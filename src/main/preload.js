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

  // Toggle hitbox visual debug
  debugHitbox: (on) => ipcRenderer.invoke('pet:invoke', { cmd: 'debug-hitbox', args: [on ? 'on' : 'off'] })
});
