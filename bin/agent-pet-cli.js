#!/usr/bin/env node
/**
 * `agent-pet` CLI: unified entry point.
 *
 * Subcommands that talk to the running GUI process:
 *   play <action>     run an action, wait until it finishes
 *   react <action>    alias of play
 *   reset             stop and return to idle
 *   list              list known actions
 *   status            show current state
 *   show | hide       control window visibility
 *   quit              ask the GUI to exit
 *
 * Lifecycle / setup:
 *   (none) | init     start the GUI in the background if not running,
 *                      wait for it to be ready, and return when it's up.
 *
 * Exit codes:
 *   0   success
 *   2   usage error (bad arguments)
 *   75  GUI cannot be started / IPC unavailable
 *   1   server replied with an error (see message)
 */
'use strict';

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ---------- IPC socket discovery -----------------------------------------
function ipcAddress() {
  if (process.platform === 'win32') return '\\\\.\\pipe\\agent-pet';
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && fs.existsSync(runtime)) {
    return path.join(runtime, 'agent-pet.sock');
  }
  return path.join(os.homedir(), '.cache', 'agent-pet', 'agent-pet.sock');
}

// ---------- Config (where is the GUI binary?) ----------------------------
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'agent-pet'
);
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return null; }
}
function writeConfig(obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
}

// ---------- Locating the GUI binary --------------------------------------
//
// We accept any of these names for the Electron binary (because the
// post-build step renames it):
//   - agent-pet-gui              (unbundled / development tree)
//   - agent-pet-electron         (legacy post-build patcher)
//   - agent-pet-gui(.exe)        (current appdir layout under resources/gui/)
//
function defaultGuiBin() {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? ['agent-pet-gui.exe', 'Agent Pet.exe']
    : ['agent-pet-gui', 'Agent Pet', 'agent-pet-electron'];
  const here = __dirname;
  // Sibling: agent-pet-cli.js sometimes sits next to the GUI in dev.
  for (const name of candidates) {
    const sibling = path.join(here, name);
    if (fs.existsSync(sibling)) return sibling;
  }
  // appdir layout: resources/gui/<bin>
  for (const name of candidates) {
    const resourcesGui = path.join(here, '..', 'gui', name);
    if (fs.existsSync(resourcesGui)) return resourcesGui;
  }
  // Project layout: ../../dist/linux-unpacked/<bin>
  for (let up = here; up !== '/'; up = path.dirname(up)) {
    for (const name of candidates) {
      const dev = path.join(up, 'dist', 'linux-unpacked', name);
      if (fs.existsSync(dev)) return dev;
    }
  }
  return null;
}

function isValidGuiBin(p) {
  // Reject anything that doesn't look like the Electron binary: an
  // ELF on Linux, an MZ (PE) header on Windows, or a Mach-O header on
  // macOS. We *don't* want to use plain scripts here because those
  // don't understand Electron's command-line flags.
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
    if ((buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) ||
        (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xce)) return true;
    return false;
  } catch (_) { return false; }
}

function findGuiBin() {
  if (process.env.AGENT_PET_GUI_BIN && isValidGuiBin(process.env.AGENT_PET_GUI_BIN)) {
    return process.env.AGENT_PET_GUI_BIN;
  }
  const cfg = readConfig();
  if (cfg && cfg.guiBin && isValidGuiBin(cfg.guiBin)) return cfg.guiBin;
  // Stale or invalid cache -> fall back to discovery.
  const fresh = defaultGuiBin();
  if (fresh && isValidGuiBin(fresh)) return fresh;
  return null;
}

// ---------- IPC client ---------------------------------------------------
function send(req, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const addr = ipcAddress();
    let socket;
    const finish = (fn, payload) => {
      try { socket && socket.end(); } catch (_) {}
      clearTimeout(timer);
      fn(payload);
    };

    const isPipe = process.platform === 'win32';
    socket = isPipe ? net.connect('\\\\.\\pipe\\agent-pet') : net.connect(addr);
    const timer = setTimeout(() => finish(reject, new Error('timeout waiting for pet')), timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        let parsed;
        try { parsed = JSON.parse(line); }
        catch (err) { finish(reject, new Error('invalid reply: ' + err.message)); return; }
        if (parsed.ok) finish(resolve, parsed.result);
        else finish(reject, new Error(parsed.error || 'unknown error'));
      }
    });
    socket.on('error', (err) => finish(reject, err));
  });
}

function isGuiLikelyUp(timeoutMs = 400) {
  return new Promise((resolve) => {
    const addr = ipcAddress();
    const isPipe = process.platform === 'win32';
    const sock = isPipe ? net.connect('\\\\.\\pipe\\agent-pet') : net.connect(addr);
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(false); } }, timeoutMs);
    sock.once('connect', () => {
      if (done) return;
      clearTimeout(t); done = true;
      sock.end();
      resolve(true);
    });
    sock.once('error', () => {
      if (done) return;
      clearTimeout(t); done = true;
      resolve(false);
    });
  });
}

// ---------- Stale-lock cleanup -------------------------------------------
function cleanStaleSingleton() {
  const userData = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'agent-pet')
    : path.join(os.homedir(), '.config', 'agent-pet');
  for (const name of ['SingletonSocket', 'SingletonCookie', 'SingletonLock']) {
    const p = path.join(userData, name);
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

// Kill any orphaned GUI process whose socket is unresponsive.
// Handles the case where `init` was aborted mid-launch and left a zombie.
function killOrphanedGui() {
  try {
    // Find all agent-pet-gui processes except our own
    const out = require('child_process').execSync(
      "pgrep -f 'agent-pet-gui' | grep -v $$", { encoding: 'utf8' }
    );
    const pids = out.trim().split('\n').filter(Boolean);
    if (pids.length === 0) return 0;

    // Try SIGTERM first, then SIGKILL if still alive
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
    }
    // Give it a moment, then force-kill survivors
    setTimeout(() => {
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
      }
    }, 2000).unref();

    return pids.length;
  } catch (_) {
    return 0;
  }
}

// ---------- Starting the GUI ---------------------------------------------
async function startGui({ wait = true } = {}) {
  let bin = findGuiBin();
  if (!bin) throw new Error('cannot find the GUI binary (set $AGENT_PET_GUI_BIN or run from a packaged build).');
  writeConfig({ ...(readConfig() || {}), guiBin: bin, startedAt: new Date().toISOString() });

  if (await isGuiLikelyUp(300)) {
    return { bin, reused: true };
  }

  // Socket not responding: either no instance or a zombie one.
  // Clean singleton locks and kill orphaned GUI processes.
  cleanStaleSingleton();
  const killed = killOrphanedGui();
  if (killed > 0) {
    console.log('agent-pet: cleaned up', killed, 'orphaned GUI process(es).');
    // Give OS a moment to release resources
    await new Promise(r => setTimeout(r, 500));
  }

  const logPath = path.join(CONFIG_DIR, 'gui.log');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const out = fs.openSync(logPath, 'a');

  // Don't pass --no-sandbox: bash's "bad option" error was observed when
  // an execve to a FUSE mount tried to pass it. Most Linux desktops have
  // a working setuid sandbox these days; if the user's distro doesn't,
  // they can set $AGENT_PET_EXTRA_ARGS='--no-sandbox' themselves.
  const extra = process.env.AGENT_PET_EXTRA_ARGS ? process.env.AGENT_PET_EXTRA_ARGS.split(' ') : [];

  const child = spawn(bin, extra, {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env
  });
  child.unref();

  if (!wait) return { bin, reused: false };

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isGuiLikelyUp(200)) return { bin, reused: false };
    await new Promise((r) => setTimeout(r, 150));
  }
  // Don't throw — the user can re-try `agent-pet react ...` and the GUI
  // will be polled first.
  process.stderr.write('agent-pet: GUI was launched but did not open its socket; commands will retry.\n');
  return { bin, reused: false };
}

// ---------- Help / usage -------------------------------------------------
function usage() {
  process.stderr.write([
    'Usage: agent-pet <command> [args]',
    '',
    'Commands that talk to the running GUI:',
    '  play <action>     run an action, wait until it finishes',
    '  react <action>    alias of play',
    '  reset             stop and return to idle',
    '  list              list known actions',
    '  status            show current state',
    '  show | hide       toggle window visibility',
    '  quit              ask the GUI to exit',
    '',
    'Lifecycle:',
    '  init              start the GUI in the background (idempotent)',
    '  (no command)      alias of `init`',
    '',
    'Other:',
    '  -h, --help        show this message',
    '  --version         print version',
    ''
  ].join('\n'));
}

// ---------- Main ---------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === 'init') {
    try {
      const { bin, reused } = await startGui({ wait: true });
      if (reused) {
        process.stdout.write('agent-pet: GUI already running.\n');
      } else {
        process.stdout.write('agent-pet: GUI started (' + bin + ').\n');
      }
      process.stdout.write('', () => process.exit(0));
    } catch (err) {
      process.stderr.write('agent-pet: ' + (err && err.message ? err.message : err) + '\n');
      process.stderr.write('', () => process.exit(75));
    }
    return;
  }

  const cmd = argv[0];
  const args = argv.slice(1);

  if (cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(0);
  }
  if (cmd === '--version') {
    // Try the local package.json (development). When bundled inside the
    // AppImage / deb / etc. the script lives in <root>/resources/ and
    // there is no surrounding package.json; fall back to a hardcoded
    // version string kept in sync with package.json via this comment.
    let version = '0.1.0';
    try { version = require('../package.json').version; } catch (_) {}
    process.stdout.write(version + '\n');
    process.exit(0);
  }

  let req;
  switch (cmd) {
    case 'play':
    case 'react':
      if (args.length === 0) { process.stderr.write('play: missing action\n'); process.exit(2); }
      req = { id: String(Date.now()), cmd: 'play', args };
      break;
    case 'reset':
    case 'status':
    case 'list':
    case 'show':
    case 'hide':
    case 'debug-hitbox':
    case 'devtools':
    case 'set-idle':
    case 'quit':
      req = { id: String(Date.now()), cmd, args };
      break;
    default:
      process.stderr.write('unknown command: ' + cmd + '\n');
      usage();
      process.exit(2);
  }

  if (!await isGuiLikelyUp(200)) {
    try {
      await startGui({ wait: true });
    } catch (err) {
      process.stderr.write('agent-pet: cannot start GUI: ' + (err && err.message ? err.message : err) + '\n');
      process.stderr.write('', () => process.exit(75));
      return;
    }
  }

  try {
    const result = await send(req);
    if (result === null || result === undefined) {
      process.stdout.write('', () => process.exit(0));
    } else if (typeof result === 'string') {
      process.stdout.write(result + '\n', () => process.exit(0));
    } else {
      process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
    }
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
      process.stderr.write('agent-pet: cannot reach the GUI.\n');
      process.stderr.write('', () => process.exit(75));
      return;
    }
    process.stderr.write('agent-pet: ' + (err && err.message ? err.message : err) + '\n');
    process.stderr.write('', () => process.exit(1));
  }
}

main();
