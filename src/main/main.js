/**
 * Electron main entry.
 *
 * Single-instance lock + frameless transparent window + IPC server.
 *
 * Lifecycle:
 *  1. Acquire single-instance lock (focus existing window if duplicate).
 *  2. `app.whenReady` -> create window, start IPC server.
 *  3. Each CLI request is dispatched into the renderer via
 *     `webContents.executeJavaScript`, awaited, and the result is
 *     returned to the CLI socket.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { createIpcServer } = require('./socket-server');

// ---------- Chromium switches ------------------------------------------
// Electron's default settings can fail on Linux/Wayland boxes that lack a
// working GPU process (Chromium then can't composite the window and the
// process eventually dies with "GPU process isn't usable"). Make the pet
// resilient: prefer software compositing + transparent surfaces.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-features', 'UseOzonePlatform');
  // Allow `--in-process-gpu` as a fallback if normal launch fails.
  if (process.env.AGENT_PET_SOFTWARE_GPU) {
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
}

const CONFIG_FILE = path.join(app.getPath('userData'), 'window-state.json');

let mainWindow = null;
let tray = null;
let ipcServer = null;
/** Tracks current action; surfaced via `status` and reflected to renderer. */
let lastAction = { action: null, running: false, since: Date.now() };
app.startedAt = Date.now();

// ---------- Idle auto-sleep ----------------------------------------------
// Idle timeout in ms before the pet goes to sleep. 0 = disabled.
// Precedence: env AGENT_PET_IDLE_MS > persisted settings.json > default 5 min.
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_IDLE_MS = 5 * 60 * 1000; // 5 min

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}
function writeSettings(obj) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2));
  } catch (_) { /* ignore */ }
}

// `let` (not const) so set-idle can change it at runtime.
let IDLE_TIMEOUT_MS = Number(process.env.AGENT_PET_IDLE_MS) ||
                      Number(readSettings().idleTimeoutMs) ||
                      DEFAULT_IDLE_MS;

let idleTimer = null;
let lastUserActivity = Date.now();

function resetIdleTimer() {
  lastUserActivity = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  if (IDLE_TIMEOUT_MS <= 0 || !mainWindow) return;
  idleTimer = setTimeout(() => {
    const idleFor = Date.now() - lastUserActivity;
    if (idleFor >= IDLE_TIMEOUT_MS && mainWindow && mainWindow.isVisible()) {
      // Only auto-sleep if not already sleeping
      if (petMood !== 'sleep') {
        petMood = 'sleep';
        console.log('[agent-pet] idle timeout -> play sleep');
        dispatcher({ cmd: 'play', args: ['sleep'] }).catch(() => {});
      }
    }
  }, IDLE_TIMEOUT_MS);
}

// The visual/mood state is separate from lastAction (which is ephemeral during
// execution). petMood tells us what the pet is currently showing.
let petMood = 'idle';

let lastCursorPos = null;
function setupIdleDetection() {
  // Poll cursor position to detect general activity (resets idle timer only)
  setInterval(() => {
    try {
      const cursor = screen.getCursorScreenPoint();
      if (!lastCursorPos) {
        lastCursorPos = cursor;
        return;
      }
      if (cursor.x !== lastCursorPos.x || cursor.y !== lastCursorPos.y) {
        lastCursorPos = cursor;
        resetIdleTimer();
      }
    } catch (_) { /* ignore */ }
  }, 1000);
  resetIdleTimer();
}

// Wake the pet when the renderer reports hover over visible avatar pixels
function onPetHover() {
  if (petMood === 'sleep' && mainWindow && mainWindow.isVisible()) {
    petMood = 'idle';
    console.log('[agent-pet] hover over pet -> play wake');
    dispatcher({ cmd: 'play', args: ['wake'] }).catch(() => {});
  }
}

// ---------- Single instance lock ----------------------------------------
if (!app.requestSingleInstanceLock()) {
  // Hard exit: `app.quit()` alone can leave a lingering process if the app
  // object has pending async work. `app.exit(0)` forces immediate cleanup.
  console.log('[agent-pet] another instance is running; exiting.');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Surface crashes from any process.
process.on('uncaughtException', (err) => {
  console.error('[agent-pet] uncaughtException', err && err.stack || err);
});

// ---------- Window state persistence -----------------------------------
function readState() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return { width: 320, height: 320 };
  }
}
function writeState(win) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(win.getBounds()));
  } catch (_) { /* ignore */ }
}
function clampToDisplay(bounds) {
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const { x, y, width, height } = d.workArea;
    if (
      bounds.x !== undefined && bounds.y !== undefined &&
      bounds.x >= x && bounds.y >= y &&
      bounds.x + bounds.width <= x + width &&
      bounds.y + bounds.height <= y + height
    ) {
      return bounds;
    }
  }
  const primary = screen.getPrimaryDisplay().workArea;
  return {
    width: bounds.width,
    height: bounds.height,
    x: Math.round(primary.x + (primary.width - bounds.width) / 2),
    y: Math.round(primary.y + (primary.height - bounds.height) / 2)
  };
}

// ---------- Window ------------------------------------------------------
function createWindow() {
  const state = clampToDisplay(readState());
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('moved', () => writeState(mainWindow));
  mainWindow.on('resized', () => writeState(mainWindow));
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.on('context-menu', () => {
    if (!tray) createTray();
    if (tray) tray.popUpContextMenu();
  });

  // Forward renderer console messages to the main process stdout so we can
  // diagnose load issues from the terminal without DevTools.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const lvl = ['log', 'warn', 'error'][level] || 'log';
    console.log(`[renderer:${lvl}] ${message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer] did-fail-load', code, desc, url);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone', details);
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Agent Pet (right-click for menu)');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: () => mainWindow && (mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()) },
    { label: 'Quit', click: () => { app.quitting = true; app.quit(); } }
  ]));
}

// ---------- CLI dispatcher ---------------------------------------------
const ACTIONS = [
  'idle', 'bored', 'waiting', 'waiting-wrap', 'input', 'send',
  'success', 'failure', 'warning', 'inspect', 'blocked', 'error',
  'surprise', 'love', 'random', 'slot', 'sleep', 'wake'
];

/**
 * Wait until `window.__pet` is defined AND the avatar exposes .play.
 * Used to sequence IPC calls into the renderer until the component
 * finishes its initial ESM import + custom-element registration.
 */
let rendererReadyPromise = null;
function whenRendererReady(webContents) {
  if (rendererReadyPromise) return rendererReadyPromise;
  rendererReadyPromise = (async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const ok = await webContents.executeJavaScript(
          '!!(window.__pet && window.__pet.isReady && window.__pet.isReady())',
          true
        );
        if (ok) return;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('renderer not ready (avatar did not initialise)');
  })();
  return rendererReadyPromise;
}

async function dispatcher(req) {
  switch (req.cmd) {
    case 'list':
      return [...ACTIONS, 'reset'];
    case 'status':
      return { ...lastAction, pid: process.pid, startedAt: app.startedAt, idleTimeoutMs: IDLE_TIMEOUT_MS };
    case 'play':
    case 'react': {
      const action = req.args && req.args[0];
      if (!action) throw new Error('play: missing action');
      if (!ACTIONS.includes(action)) {
        throw new Error('unknown action: ' + action + ' (try `agent-pet list`)');
      }
      if (!mainWindow) throw new Error('pet window not ready');
      await whenRendererReady(mainWindow.webContents);
      lastAction = { action, running: true, since: Date.now() };
      try {
        await mainWindow.webContents.executeJavaScript(
          `window.__pet.play(${JSON.stringify(action)})`,
          false
        );
      } finally {
        lastAction = { action, running: false, since: Date.now() };
      }
      return { ok: true };
    }
    case 'reset': {
      if (!mainWindow) return true;
      await whenRendererReady(mainWindow.webContents);
      await mainWindow.webContents.executeJavaScript('window.__pet.reset()', false);
      lastAction = { action: null, running: false, since: Date.now() };
      return true;
    }
    case 'hide':
      if (mainWindow) mainWindow.hide();
      return true;
    case 'show':
      if (mainWindow) mainWindow.show();
      return true;
    case 'debug-hitbox': {
      console.log('[agent-pet] toggling debug-hitbox');
      if (!mainWindow) throw new Error('pet window not ready');
      await whenRendererReady(mainWindow.webContents);
      const isOn = await mainWindow.webContents.executeJavaScript(
        'window.__pet.toggleDebugHitbox()',
        true
      );
      return { debugHitbox: isOn };
    }
    case 'devtools': {
      if (!mainWindow) throw new Error('pet window not ready');
      const wc = mainWindow.webContents;
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
        console.log('[agent-pet] devtools closed');
        return { devtools: false };
      }
      wc.openDevTools({ mode: 'detach' });
      console.log('[agent-pet] devtools opened');
      return { devtools: true };
    }
    case 'set-idle': {
      const raw = req.args && req.args[0];
      if (raw === undefined || raw === '') {
        // Report current value
        return { idleTimeoutMs: IDLE_TIMEOUT_MS };
      }
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error('set-idle: expected milliseconds >= 0 (0 = disabled)');
      }
      if (process.env.AGENT_PET_IDLE_MS) {
        console.log('[agent-pet] note: AGENT_PET_IDLE_MS env var overrides set-idle until restart');
      }
      IDLE_TIMEOUT_MS = ms;
      const settings = readSettings();
      settings.idleTimeoutMs = ms;
      writeSettings(settings);
      resetIdleTimer();
      console.log('[agent-pet] idle timeout set to', ms, 'ms');
      return { idleTimeoutMs: IDLE_TIMEOUT_MS };
    }
    case 'quit':
      app.quitting = true;
      // Use `app.exit(0)` (vs `app.quit()` or `process.exit(0)`) so
      // Chromium cleans up its single-instance lock files. `process.exit`
      // and SIGKILL orphan those files and break subsequent launches.
      try {
        if (ipcServer) ipcServer.close().catch(() => {});
      } catch (_) {}
      setImmediate(() => app.exit(0));
      return true;
    default:
      throw new Error('unknown cmd: ' + req.cmd);
  }
}

// ---------- App lifecycle ----------------------------------------------
app.whenReady().then(() => {
  app.startedAt = Date.now();
  createWindow();
  setupIdleDetection();
  ipcMain.on('pet:wakeOnHover', onPetHover);
  ipcServer = createIpcServer(dispatcher);
  ipcServer.listen().then(() => {
    // Print so devs can see where the socket lives.
    console.log('[agent-pet] ipc listening at', ipcServer.address);
  }).catch((err) => {
    console.error('[agent-pet] failed to bind ipc:', err && err.message);
  });
});

app.on('window-all-closed', (e) => {
  // Keep alive: user wants the pet alive even with no windows.
  e && e.preventDefault && e.preventDefault();
});

app.on('before-quit', () => {
  if (ipcServer) {
    ipcServer.close().catch(() => {});
  }
});
