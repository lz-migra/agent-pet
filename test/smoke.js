/**
 * Smoke test: spin up the IPC server with a fake dispatcher, connect with
 * the same logic as the CLI, send a few commands, assert replies.
 *
 * Run: node test/smoke.js
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createIpcServer } = require('../src/main/socket-server');

// Use a test-only socket path so we don't collide with the real GUI.
const SOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pet-test-'));
process.env.XDG_RUNTIME_DIR = SOCK_DIR;

const server = createIpcServer(async (req) => {
  switch (req.cmd) {
    case 'play': return { ok: true, echoed: req.args && req.args[0] };
    case 'list': return ['idle', 'success'];
    case 'error': throw new Error('boom');
    default: return { ok: true, cmd: req.cmd };
  }
});

let exited = 0;

async function client(req, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(SOCK_DIR, 'agent-pet.sock'));
    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(t);
        try {
          const parsed = JSON.parse(buf.slice(0, nl));
          sock.end();
          resolve(parsed);
        } catch (e) { reject(e); }
      }
    });
    sock.on('error', reject);
  });
}

(async () => {
  await server.listen();
  console.log('[smoke] listening on', server.address);

  const r1 = await client({ id: '1', cmd: 'play', args: ['success'] });
  console.log('[smoke] play ->', r1);
  if (!r1.ok || r1.result.echoed !== 'success') throw new Error('play failed');

  const r2 = await client({ id: '2', cmd: 'list' });
  console.log('[smoke] list ->', r2);
  if (!r2.ok) throw new Error('list failed');

  const r3 = await client({ id: '3', cmd: 'error' });
  console.log('[smoke] error ->', r3);
  if (r3.ok || !/boom/.test(r3.error)) throw new Error('error propagation failed');

  // Bad-JSON line handling
  const rawClient = () => new Promise((resolve, reject) => {
    const sock = net.connect(path.join(SOCK_DIR, 'agent-pet.sock'));
    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 2000);
    sock.on('connect', () => sock.write('not json\n'));
    let buf = '';
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(t);
        try {
          const parsed = JSON.parse(buf.slice(0, nl));
          sock.end();
          resolve(parsed);
        } catch (e) { reject(e); }
      }
    });
    sock.on('error', reject);
  });
  const r4 = await rawClient();
  console.log('[smoke] bad-json ->', r4);
  if (r4.ok || !/invalid json/.test(r4.error)) throw new Error('bad-json did not echo an error');

  // Test the actual CLI binary too. `bin/agent-pet` is a POSIX shim
  // (#!/usr/bin/env bash), so it must be executed directly, not via Node.
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(__dirname, '..', 'bin', 'agent-pet'), ['list'], {
      env: { ...process.env, XDG_RUNTIME_DIR: SOCK_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; process.stdout.write('[cli] ' + b); });
    child.stderr.on('data', (b) => { err += b; process.stderr.write('[cli-err] ' + b); });
    child.on('exit', (code) => {
      console.log('[smoke] cli exit', code);
      exited = code;
      if (code !== 0) reject(new Error('cli non-zero: ' + err));
      else if (!/"idle"/.test(out)) reject(new Error('cli output missing "idle"; got: ' + out));
      else resolve();
    });
  });
  console.log('[smoke] child resolved, closing server...');

  await server.close();
  console.log('[smoke] server closed');

  fs.rmSync(SOCK_DIR, { recursive: true, force: true });
  console.log('[smoke] OK');
})().catch((err) => {
  console.error('[smoke] FAIL', err);
  process.exit(1);
});
