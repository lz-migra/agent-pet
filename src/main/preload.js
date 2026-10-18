/**
 * Preload script: runs in an isolated context with access to Node + DOM.
 * Exposes a tiny, explicit API to the renderer over contextBridge.
 *
 * The renderer must never get `ipcRenderer` directly; we only publish
 * what the avatar needs.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  /**
   * Dispatch a CLI command into the main process and resolve with the result.
   * @param {string} cmd one of: play | reset | status | list
   * @param {string[]} args
   */
  invoke: (cmd, args) => ipcRenderer.invoke('pet:invoke', { cmd, args: args || [] }),

  /**
   * Subscribe to status messages (e.g. "playing success", "idle").
   * @param {(state: {action:string|null, running:boolean}) => void} fn
   */
  onStatus: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('pet:status', handler);
    return () => ipcRenderer.removeListener('pet:status', handler);
  },

  // Wake the pet when the user hovers over it (only on opaque pixels)
  wakeOnHover: () => ipcRenderer.send('pet:wakeOnHover'),

  /**
   * Fast click-through path. While the window is interactive it receives real
   * pointer events, so the renderer knows the exact instant the cursor leaves
   * the avatar silhouette; the main process switches to click-through right
   * away instead of waiting for the next global-pointer sample.
   * @param {{x:number, y:number}} point window CSS pixels
   */
  pointerLeft: (point) => ipcRenderer.send('pet:pointer-left', point),

  /**
   * Report where the avatar is drawn, in window CSS pixels, so the main
   * process can keep that silhouette interactive and let clicks through
   * everywhere else.
   * @param {{polygon: number[], circles: {x:number,y:number,r:number}[]}} region
   */
  setHitRegion: (region) => ipcRenderer.send('pet:hit-region', region),

  /** Render frame rate configured in the main process (applied on startup). */
  getFrameRate: () => ipcRenderer.invoke('pet:frame-rate:get'),

  /**
   * Subscribe to the global pointer position (window CSS pixels), forwarded
   * by the main process. Needed because a transparent, click-through window
   * only receives pointer events while the cursor is over the pet.
   * @param {(point: {x:number, y:number}) => void} fn
   */
  onPointer: (fn) => {
    const handler = (_event, point) => fn(point);
    ipcRenderer.on('pet:pointer', handler);
    return () => ipcRenderer.removeListener('pet:pointer', handler);
  },

  // Toggle hitbox visual debug
  debugHitbox: (on) => ipcRenderer.invoke('pet:invoke', { cmd: 'debug-hitbox', args: [on ? 'on' : 'off'] })
});
