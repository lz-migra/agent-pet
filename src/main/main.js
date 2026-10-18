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
const http = require('http');
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

// Render rate of the avatar. The upstream component caps itself at ~30 fps;
// 60 matches a normal display, 30 halves the drawing cost. Persisted in
// settings.json so `agent-pet set-fps` survives restarts.
const DEFAULT_FRAME_RATE = 60;
function normalizeFrameRate(value) {
  const fps = Number(value);
  return Number.isFinite(fps) && fps >= 1 && fps <= 240
    ? Math.round(fps)
    : DEFAULT_FRAME_RATE;
}
let FRAME_RATE = normalizeFrameRate(
  process.env.AGENT_PET_FRAME_RATE || readSettings().frameRate || DEFAULT_FRAME_RATE
);

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
  // Poll the pointer to detect general activity (resets the idle timer). It
  // goes through the same source as click-through because Electron cannot
  // read the global cursor under Wayland (the value is frozen there).
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const cursor = await readPointerPosition();
      if (!cursor) return;
      if (!lastCursorPos) {
        lastCursorPos = cursor;
        return;
      }
      if (cursor.x !== lastCursorPos.x || cursor.y !== lastCursorPos.y) {
        lastCursorPos = cursor;
        resetIdleTimer();
      }
    } catch (_) {
      /* ignore */
    } finally {
      checking = false;
    }
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

// ---------- Click-through ------------------------------------------------
// The window is mostly transparent, so only the robot silhouette should
// capture the mouse; everything else must fall through to the desktop.
//
// Electron toggles that per window (`setIgnoreMouseEvents`), so we track the
// pointer and switch modes when it enters/leaves the shape the renderer
// reports (a polygon sampled from the avatar's SVG path).
//
// `screen.getCursorScreenPoint()` cannot see the global pointer on Wayland
// (it returns a frozen value), so there we read it from QueryPointerServer:
// a GNOME Shell extension publishing Mutter's `global.get_pointer()` over
// HTTP. When it is not running (or on X11) we fall back to Electron.
// ~60 Hz to match the avatar's draw rate (the GNOME extension samples at
// ~17 ms, so a faster poll would only repeat the same sample).
const POINTER_POLL_MS = Math.max(8, Number(process.env.AGENT_PET_POINTER_POLL_MS) || 16);
const POINTER_INFO_FILE = process.env.AGENT_PET_POINTER_INFO ||
  (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'query-point-server.json') : '');
const CLICK_THROUGH_DISABLED = !!process.env.AGENT_PET_NO_CLICK_THROUGH;
const pointerAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });

/** Last region reported by the renderer: { polygon: number[], circles: [] }. */
let hitRegion = null;
/** Last value handed to setIgnoreMouseEvents (null = never applied yet). */
let ignoringMouse = null;
/**
 * When the renderer last reported (from a real pointer event) that the cursor
 * is off the avatar. Global-pointer samples lag behind the physical cursor, so
 * a fresh renderer report must win over a stale "inside" sample.
 */
let rendererLeftAt = 0;
const RENDERER_LEAVE_GRACE_MS = 60;
/** Slack (px) the cursor must be inside the silhouette before re-enabling
 *  clicks; keeps the animated edge from flapping the window state. */
const POINTER_INSIDE_MARGIN = 4;
let pointerSource = 'none';
let pointerUrl = process.env.AGENT_PET_POINTER_URL || null;
let pointerDiscoveredAt = 0;
let clickThroughTimer = null;

/** Rediscover the QueryPointerServer port (it is random) when it restarts. */
function refreshPointerUrl(now) {
  if (process.env.AGENT_PET_POINTER_URL) return pointerUrl;
  if (now - pointerDiscoveredAt < 3000) return pointerUrl;
  pointerDiscoveredAt = now;
  pointerUrl = null;
  if (!POINTER_INFO_FILE) return null;
  try {
    const info = JSON.parse(fs.readFileSync(POINTER_INFO_FILE, 'utf8'));
    const port = Number(info && info.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      pointerUrl = `http://127.0.0.1:${port}/api/point`;
    }
  } catch (_) { /* server not running */ }
  return pointerUrl;
}

function fetchPointer(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: pointerAgent, timeout: 500 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        try {
          const p = JSON.parse(body);
          resolve(p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null);
        } catch (_) { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Global pointer position in screen coordinates (Wayland-aware). */
async function readPointerPosition() {
  const now = Date.now();
  const url = refreshPointerUrl(now);
  if (url) {
    const p = await fetchPointer(url);
    // `connected:false` or an old timestamp means the extension stopped
    // publishing, so the reading would be stale.
    const updatedAt = Number(p && p.updatedAt) || 0;
    if (p && p.connected && now - updatedAt < 2000) {
      pointerSource = 'querypoint';
      return { x: p.x, y: p.y };
    }
  }
  pointerSource = 'electron';
  try {
    const pt = screen.getCursorScreenPoint();
    return pt ? { x: pt.x, y: pt.y } : null;
  } catch (_) {
    return null;
  }
}

function pointInPolygon(x, y, flat) {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to a polygon outline (flat [x,y,...]). */
function distanceToPolygon(x, y, flat) {
  let best = Infinity;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const x1 = flat[j], y1 = flat[j + 1], x2 = flat[i], y2 = flat[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x1 + t * dx, py = y1 + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Is this screen point over the visible avatar (not just its bounding box)?
 * `margin` requires the point to be that many pixels inside the silhouette,
 * which keeps the animated edge from flapping the click-through state.
 */
function isOverPet(x, y, bounds, margin = 0) {
  if (!hitRegion || !mainWindow) return false;
  const b = bounds || mainWindow.getBounds();
  const lx = x - b.x;
  const ly = y - b.y;
  if (lx < 0 || ly < 0 || lx > b.width || ly > b.height) return false;
  if (hitRegion.polygon.length >= 6 && pointInPolygon(lx, ly, hitRegion.polygon)) {
    if (margin <= 0 || distanceToPolygon(lx, ly, hitRegion.polygon) >= margin) return true;
  }
  for (const c of hitRegion.circles) {
    const dx = lx - c.x, dy = ly - c.y;
    const r = c.r - margin;
    if (r > 0 && dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

function applyIgnoreMouse(next, detail) {
  if (!mainWindow || ignoringMouse === next) return;
  ignoringMouse = next;
  mainWindow.setIgnoreMouseEvents(next);
  console.log(
    `[agent-pet] click-through ${next ? 'ON  (desktop receives clicks)' : 'OFF (pet interactive)'}` +
    (detail ? ' — ' + detail : '')
  );
}

function startClickThroughWatcher() {
  if (clickThroughTimer) return;
  let busy = false;
  clickThroughTimer = setInterval(async () => {
    if (busy || !mainWindow) return;
    busy = true;
    try {
      const p = await readPointerPosition();
      if (!p) return;
      const bounds = mainWindow.getBounds();
      // Stay interactive until the renderer reports the silhouette, otherwise
      // a renderer hiccup would leave an unclickable window.
      if (!CLICK_THROUGH_DISABLED && hitRegion && mainWindow.isVisible()) {
        const detail = `cursor ${p.x},${p.y} via ${pointerSource}`;
        if (!isOverPet(p.x, p.y, bounds)) {
          applyIgnoreMouse(true, detail);
        } else if (
          isOverPet(p.x, p.y, bounds, POINTER_INSIDE_MARGIN) &&
          Date.now() - rendererLeftAt > RENDERER_LEAVE_GRACE_MS
        ) {
          applyIgnoreMouse(false, detail);
        }
        // Between the exact silhouette and the margin band we keep whatever
        // state we are in (hysteresis), so an animating edge cannot flicker.
      }
      // The window is transparent and click-through, so the page rarely sees
      // real pointer events. Forward the global cursor (window CSS px) so the
      // avatar's gaze/head can follow it anywhere on screen.
      if (mainWindow.isVisible() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('pet:pointer', {
          x: p.x - bounds.x,
          y: p.y - bounds.y
        });
      }
    } catch (err) {
      console.error('[agent-pet] pointer watcher error:', err && err.message);
    } finally {
      busy = false;
    }
  }, POINTER_POLL_MS);
}

function stopClickThroughWatcher() {
  if (clickThroughTimer) clearInterval(clickThroughTimer);
  clickThroughTimer = null;
}

function sanitizeHitRegion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const polygon = Array.isArray(raw.polygon)
    ? raw.polygon.filter((n) => Number.isFinite(n)).slice(0, 2000)
    : [];
  const circles = Array.isArray(raw.circles)
    ? raw.circles
        .filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.r) && c.r > 0)
        .slice(0, 8)
    : [];
  return polygon.length >= 6 || circles.length ? { polygon, circles } : null;
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
      return {
        ...lastAction,
        pid: process.pid,
        startedAt: app.startedAt,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        frameRate: FRAME_RATE,
        clickThrough: {
          enabled: !CLICK_THROUGH_DISABLED,
          ignoringMouse,
          pointerSource,
          pointerUrl,
          hasHitRegion: !!hitRegion
        }
      };
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
    case 'set-fps': {
      const raw = req.args && req.args[0];
      if (raw === undefined || raw === '') {
        // Report current value
        return { frameRate: FRAME_RATE };
      }
      const fps = Number(raw);
      if (!Number.isFinite(fps) || fps < 1 || fps > 240) {
        throw new Error('set-fps: expected a number between 1 and 240 (e.g. 30 or 60)');
      }
      if (process.env.AGENT_PET_FRAME_RATE) {
        console.log('[agent-pet] note: AGENT_PET_FRAME_RATE env var overrides set-fps until restart');
      }
      FRAME_RATE = Math.round(fps);
      const settings = readSettings();
      settings.frameRate = FRAME_RATE;
      writeSettings(settings);
      let applied = null;
      if (mainWindow) {
        await whenRendererReady(mainWindow.webContents);
        applied = await mainWindow.webContents.executeJavaScript(
          `window.__pet.setFrameRate(${FRAME_RATE})`,
          true
        );
      }
      console.log('[agent-pet] frame rate set to', FRAME_RATE, 'fps');
      return { frameRate: FRAME_RATE, applied };
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
  // The renderer asks for the persisted rate on startup.
  ipcMain.handle('pet:frame-rate:get', () => FRAME_RATE);
  // Renderer reports the avatar silhouette so we know where the window must
  // stay interactive; everything outside it is click-through.
  ipcMain.on('pet:hit-region', (_event, region) => {
    const next = sanitizeHitRegion(region);
    if (next) hitRegion = next;
  });
  // Fast path: while the window is interactive it receives real pointer
  // events, so the renderer can spot "cursor left the avatar" within a frame
  // instead of waiting for the next global-pointer sample (the GNOME
  // extension publishes at ~8-17 ms and the poll adds its own tick). Without
  // this, a move-then-click right on the edge is still captured by the window.
  ipcMain.on('pet:pointer-left', (_event, point) => {
    rendererLeftAt = Date.now();
    if (CLICK_THROUGH_DISABLED || !hitRegion || !mainWindow || !mainWindow.isVisible()) return;
    const at = point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? ` ${Math.round(point.x)},${Math.round(point.y)}`
      : '';
    applyIgnoreMouse(true, `renderer: cursor off avatar${at}`);
  });
  startClickThroughWatcher();
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
  stopClickThroughWatcher();
  pointerAgent.destroy();
  if (ipcServer) {
    ipcServer.close().catch(() => {});
  }
});
