#!/usr/bin/env node
/**
 * `agent-pet` Node dispatcher.
 *
 * Lives at the root of the appdir (sibling of `agent-pet` shim) and
 * also at <project>/bin/agent-pet.js for development. Decides between
 * running the bundled Electron GUI (no args / unknown args) and the
 * bundled Node CLI (args match a known subcommand).
 *
 * Both decisions resolve to files produced by electron-builder without
 * rename — the final binary is built as `agent-pet-gui` and lives
 * alongside the other Electron runtime under resources/gui/. The CLI
 * script lives at resources/cli/agent-pet-cli.
 *
 * Layout (identical across platforms):
 *
 *   appdir/
 *   ├── agent-pet         (sh: `exec node ./agent-pet.js "$@"`)
 *   ├── agent-pet.js      (this file)
 *   └── resources/
 *       ├── gui/
 *       │   ├── agent-pet-gui       (Electron binary; .exe on Windows)
 *       │   ├── app.asar
 *       │   ├── chrome-sandbox
 *       │   ├── *.pak, lib*.so, icudtl.dat, locales/, ...
 *       │   └── vendor/...
 *       └── cli/
 *           └── agent-pet-cli       (Node CLI script)
 *
 * Development (npm link):
 *
 *   <project>/
 *   ├── bin/
 *   │   ├── agent-pet.js   (this file, identical)
 *   │   ├── agent-pet      (shim that exec's this file via node)
 *   │   └── agent-pet-cli  (Node CLI used for development)
 *   └── (npm link puts a symlink at ~/.local/bin/agent-pet)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ---------- Where are we? -------------------------------------------------
// We may be invoked as a Node script (`node bin/agent-pet.js`) or as the
// shell-shim exec'd target (`sh ./agent-pet` -> `node ./agent-pet.js`).
// In either case `__dirname` is the directory holding this file.
const HERE = __dirname;

// Find the bundled CLI.
function findCliBin() {
  const candidates = [
    path.join(HERE, 'resources', 'cli', 'agent-pet-cli'),  // packaged
    path.join(HERE, 'agent-pet-cli'),                      // macOS .app layout
    path.join(HERE, 'resources', 'agent-pet-cli'),         // legacy layout
    path.join(HERE, 'cli.js'),                             // legacy dev
    path.join(HERE, '..', 'bin', 'agent-pet-cli.js')      // dev (bin/agent-pet.js -> bin/agent-pet-cli.js)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Find the Electron binary (or, in dev, spawn Electron via npm).
function findGuiBin() {
  if (process.env.AGENT_PET_GUI_BIN && fs.existsSync(process.env.AGENT_PET_GUI_BIN)) {
    return process.env.AGENT_PET_GUI_BIN;
  }
  const isWindows = process.platform === 'win32';
  const exe = isWindows ? 'agent-pet-gui.exe' : 'agent-pet-gui';
  const candidates = [
    path.join(HERE, 'resources', 'gui', exe),  // packaged
    path.join(HERE, 'resources', exe),         // alternative layout
    path.join(HERE, 'agent-pet-gui'),          // flat layout
    path.join(HERE, 'dist', 'linux-unpacked', exe),
    path.join(HERE, 'dist', 'mac', 'Agent Pet.app', 'Contents', 'MacOS', 'Agent Pet'),
    path.join(HERE, 'dist', 'win-unpacked', exe)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ---------- Subcommand classification ------------------------------------
const CLI_COMMANDS = new Set([
  'init', 'install',
  'play', 'react',
  'reset',
  'list', 'status',
  'show', 'hide',
  'debug-hitbox', 'devtools', 'set-idle',
  'quit'
]);

const HELP_FLAGS = new Set(['--help', '-h', '--usage', '-?']);
const VERSION_FLAGS = new Set(['--version', '-V']);

function classify(argv) {
  const first = argv[0] || '';
  if (HELP_FLAGS.has(first)) return { mode: 'cli', reason: 'help' };
  if (VERSION_FLAGS.has(first)) return { mode: 'cli', reason: 'version' };
  if (CLI_COMMANDS.has(first)) return { mode: 'cli', reason: first };
  return { mode: 'gui', reason: first ? 'unknown-arg' : 'no-args' };
}

// ---------- Spawn helpers ------------------------------------------------
function spawnNode(script, args, opts = {}) {
  return spawn(process.execPath, [script, ...args], {
    stdio: 'inherit',
    ...opts
  });
}

function spawnGui(bin, args) {
  // We don't inject --no-sandbox from this code path either: see bin/agent-pet
  // for the rationale. Most desktop-pet users have a normal compositor
  // and don't need to disable the sandbox.
  const extra = [];

  // If a TTY is attached (the common case for `./agent-pet` from an
  // interactive shell), replace this process with Electron. That way
  // SIGINT/Ctrl-C propagates naturally and the GUI owns the terminal.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const child = spawn(bin, [...extra, ...args], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    return;
  }

  // Non-interactive: spawn detached so the GUI outlives us. We also
  // drop stdio so Electron doesn't get piped stdio that confuses it
  // (it treats the pipe as a controlling tty in some cases).
  const child = spawn(bin, [...extra, ...args], {
    stdio: 'ignore',
    detached: true
  });
  child.unref();
  // Don't `process.exit` until Electron has actually started listening
  // on its socket. We wait for it by polling the socket.
  waitForSocket(() => process.exit(0));
}

function waitForSocket(cb) {
  const path_ = '/run/user/' + (process.getuid ? process.getuid() : '1000') + '/agent-pet.sock';
  const t = setTimeout(() => cb(), 8000);
  function tick() {
    try {
      require('net').connect(path_).on('connect', () => {
        require('net').connect(path_).destroy();
        clearTimeout(t);
        cb();
      }).on('error', () => setTimeout(tick, 100));
    } catch (_) { setTimeout(tick, 100); }
  }
  tick();
}

// ---------- Main ---------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const { mode } = classify(argv);

  if (mode === 'cli') {
    const cli = findCliBin();
    if (!cli) {
      process.stderr.write('agent-pet: cannot find the CLI bundle.\n');
      process.exit(1);
    }
    const child = spawnNode(cli, argv);
    child.on('exit', (code) => process.exit(code || 0));
    return;
  }

  // mode === 'gui'
  const gui = findGuiBin();
  if (!gui) {
    process.stderr.write('agent-pet: cannot find the GUI binary in this bundle.\n');
    process.stderr.write('  Checked: ' + [
      path.join(HERE, 'resources/gui/agent-pet-gui'),
      path.join(HERE, 'dist/linux-unpacked/agent-pet-gui')
    ].join(', ') + '\n');
    process.exit(1);
  }
  spawnGui(gui, argv);
}

main();
