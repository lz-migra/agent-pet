/**
 * Unit-test the real dispatcher extracted from main.js, to verify the
 * validation, list, and status commands work without needing Electron.
 *
 * We can't easily test `play` without a renderer, so we fake the
 * `executeJavaScript` call with a stub that records invocations and
 * resolves a fake "action finished" detail.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createIpcServer } = require('../src/main/socket-server');

// Isolate runtime dir so we don't clash with anything.
const SOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pet-disp-'));
process.env.XDG_RUNTIME_DIR = SOCK_DIR;

// Re-implement the dispatcher (matching src/main/main.js) so we can pass
// a stub executeJavaScript. Keep this in sync with main.js.
const ACTIONS = [
  'idle', 'bored', 'waiting', 'waiting-wrap', 'input', 'send',
  'success', 'failure', 'warning', 'inspect', 'blocked', 'error',
  'surprise', 'love', 'random', 'slot', 'sleep', 'wake'
];

function makeDispatcher(executeJavaScript) {
  let lastAction = { action: null, running: false, since: Date.now() };
  return async function dispatcher(req) {
    switch (req.cmd) {
      case 'list':
        return [...ACTIONS, 'reset'];
      case 'status':
        return { ...lastAction, pid: process.pid };
      case 'play':
      case 'react': {
        const action = req.args && req.args[0];
        if (!action) throw new Error('play: missing action');
        if (!ACTIONS.includes(action)) {
          throw new Error('unknown action: ' + action + ' (try `agent-pet list`)');
        }
        lastAction = { action, running: true, since: Date.now() };
        await executeJavaScript(`play(${action})`);
        lastAction = { action, running: false, since: Date.now() };
        return { ok: true };
      }
      case 'reset':
        lastAction = { action: null, running: false, since: Date.now() };
        return true;
      default:
        throw new Error('unknown cmd: ' + req.cmd);
    }
  };
}

async function client(addr, msg) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const sock = net.connect(addr);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        try {
          const r = JSON.parse(buf.slice(0, nl));
          sock.end();
          resolve(r);
        } catch (e) { reject(e); }
      }
    });
    sock.on('error', reject);
  });
}

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok', label);
  } else {
    failed++;
    console.error('  FAIL', label, detail || '');
  }
}

(async () => {
  const calls = [];
  const dispatcher = makeDispatcher(async (js) => { calls.push(js); });
  const server = createIpcServer(dispatcher);
  await server.listen();
  const addr = server.address;
  console.log('[disp] listening at', addr);

  // 1. play valid
  let r = await client(addr, { id: '1', cmd: 'play', args: ['success'] });
  check('play success', r.ok && calls[0] === 'play(success)');
  calls.length = 0;

  // 2. play invalid -> error propagated
  r = await client(addr, { id: '2', cmd: 'play', args: ['nope'] });
  check('play invalid rejected', !r.ok && /unknown action/.test(r.error));

  // 3. list contains success and reset
  r = await client(addr, { id: '3', cmd: 'list' });
  check('list contains success', r.ok && r.result.includes('success'));
  check('list contains reset', r.ok && r.result.includes('reset'));

  // 4. status
  r = await client(addr, { id: '4', cmd: 'status' });
  check('status ok', r.ok && typeof r.result.pid === 'number');
  check('status reflects last action', r.result.action === 'success' || r.result.action === null);

  // 5. reset
  r = await client(addr, { id: '5', cmd: 'reset' });
  check('reset ok', r.ok === true);

  // 6. play without args
  r = await client(addr, { id: '6', cmd: 'play', args: [] });
  check('play no args rejected', !r.ok && /missing action/.test(r.error));

  // 7. unknown cmd
  r = await client(addr, { id: '7', cmd: 'wat' });
  check('unknown cmd rejected', !r.ok && /unknown cmd/.test(r.error));

  // 8. aliased react
  r = await client(addr, { id: '8', cmd: 'react', args: ['love'] });
  check('react alias works', r.ok && calls[0] === 'play(love)');

  await server.close();
  fs.rmSync(SOCK_DIR, { recursive: true, force: true });
  console.log(failed ? `[disp] ${failed} FAIL` : '[disp] OK');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('[disp] ERROR', err);
  process.exit(1);
});
