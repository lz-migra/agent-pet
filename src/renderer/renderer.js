/**
 * Renderer: mounts the agent-robot-avatar web component (vendored under
 * ./vendor/ and loaded via <script type=module> in index.html) and
 * exposes `window.__pet` for the main process to drive via
 * webContents.executeJavaScript.
 *
 * window.__pet.play(action) -> Promise that resolves when the action
 *   animation has finished (uses the component's `action-state` event).
 * window.__pet.reset() -> cancel any current action and go idle.
 */

// Wait until the custom element is registered so we know its methods
// (play/reset/etc.) are on the prototype.
await customElements.whenDefined('agent-robot-avatar');

const stage = document.getElementById('stage');
const avatar = document.createElement('agent-robot-avatar');
avatar.setAttribute('size', '240');
avatar.setAttribute('color', '#08090b');
try { avatar.setPointerFollow(false); } catch (_) {}
stage.appendChild(avatar);

/**
 * Tracks the action currently being waited on. The component fires
 * `action-state` events with `phase: 'start' | 'end' | 'cancel'`. We
 * resolve the pending play() promise when the corresponding phase is
 * 'end' or 'cancel'.
 */
let pending = null;

avatar.addEventListener('action-state', (event) => {
  const detail = event && event.detail ? event.detail : null;
  if (!detail || !pending) return;
  if (detail.action !== pending.action) return;
  if (detail.phase === 'end' || detail.phase === 'cancel') {
    const p = pending;
    pending = null;
    if (p.timer) clearTimeout(p.timer);
    p.resolve(detail);
  }
});

// Allow dragging the window by grabbing anywhere on the avatar.
document.body.addEventListener('mousedown', () => document.body.classList.add('dragging'));
document.body.addEventListener('mouseup', () => document.body.classList.remove('dragging'));

// Wake on hover: listen directly on the avatar's shadow DOM #head element
// (the visible head shape). This avoids an external hitbox entirely.
let hoverThrottle = 0;
let debugHitbox = false;
let attachedHead = null;

function getHeadElement() {
  try {
    const root = avatar.shadowRoot;
    if (!root) return null;
    // The library may name it #head or #headShape depending on version.
    return root.querySelector('#head') ||
           root.querySelector('#headShape') ||
           root.querySelector('svg use[href="#headShape"]') ||
           root.querySelector('svg');
  } catch (_) {
    return null;
  }
}

function attachHoverListener(head) {
  if (head === attachedHead) return;
  attachedHead = head;
  // Ensure the head actually receives pointer events (the library may set
  // pointer-events:none on decorative SVG parts).
  try { head.style.pointerEvents = 'auto'; } catch (_) {}
  // Use mousemove: fires continuously while the cursor is over the head,
  // so it still triggers if the cursor is already there when the pet sleeps.
  head.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - hoverThrottle > 500) {
      hoverThrottle = now;
      console.log('[pet] hover on head -> waking');
      if (window.pet && window.pet.wakeOnHover) window.pet.wakeOnHover();
    }
  });
  console.log('[pet] head hover listener attached');
}

function applyDebugStyle(head) {
  if (!head) return;
  head.style.outline = debugHitbox ? '2px dashed red' : '';
  head.style.outlineOffset = debugHitbox ? '2px' : '';
}

// Poll for the head element; re-attach if the shadow DOM re-renders.
setInterval(() => {
  const head = getHeadElement();
  if (head) {
    attachHoverListener(head);
    applyDebugStyle(head);
  }
}, 1000);

window.__pet = {
  ready: true,
  isReady() {
    return typeof avatar.play === 'function' && typeof avatar.reset === 'function';
  },
  async play(action) {
    if (typeof avatar.play !== 'function') {
      throw new Error('agent-robot-avatar.play not a function (got: ' + typeof avatar.play + ')');
    }
    // Replace any pending play() so the latest one wins.
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      const old = pending;
      pending = null;
      old.resolve({ action: old.action, phase: 'cancel', superseded: true });
    }
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    pending = {
      action,
      resolve: resolveFn,
      timer: setTimeout(() => {
        if (pending) {
          const p = pending; pending = null;
          p.resolve({ action, phase: 'end', source: 'timeout' });
        }
      }, 8000)
    };
    try {
      const ret = avatar.play(action);
      // avatar.play returns either `this` (sync) or a Promise<void>.
      if (ret && typeof ret.then === 'function') await ret;
    } catch (err) {
      if (pending && pending.timer) clearTimeout(pending.timer);
      pending = null;
      throw err;
    }
    return await promise;
  },
  reset() {
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      const old = pending; pending = null;
      old.resolve({ action: old.action, phase: 'cancel', reset: true });
    }
    if (typeof avatar.reset === 'function') avatar.reset();
    return true;
  },
  toggleDebugHitbox() {
    debugHitbox = !debugHitbox;
    const head = getHeadElement();
    if (head) {
      head.style.outline = debugHitbox ? '2px dashed red' : '';
      head.style.outlineOffset = debugHitbox ? '2px' : '';
    }
    console.log('[pet] debug hitbox:', debugHitbox);
    return debugHitbox;
  },
  /**
   * Generic handler kept for future commands; currently the main.js
   * process drives everything via executeJavaScript on window.__pet.play.
   */
  async handle({ cmd, args }) {
    if (cmd === 'play' || cmd === 'react') return this.play(args[0]);
    if (cmd === 'reset') return this.reset();
    throw new Error('unknown cmd: ' + cmd);
  }
};
