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

// The render rate is configurable (`agent-pet set-fps`); ask the main
// process for the persisted value so a restart keeps the user's choice.
let initialFrameRate = 60;
try {
  if (window.pet && typeof window.pet.getFrameRate === 'function') {
    const configured = await window.pet.getFrameRate();
    if (Number.isFinite(configured)) initialFrameRate = configured;
  }
} catch (_) {}

const stage = document.getElementById('stage');
const avatar = document.createElement('agent-robot-avatar');
avatar.setAttribute('size', '240');
avatar.setAttribute('color', '#08090b');
// Let the eyes/head follow the cursor (the library supports it natively).
try { avatar.setPointerFollow(true); } catch (_) {}
// Upstream draws at ~30 fps; the pet runs at the configured rate instead.
try {
  avatar.setFrameRate(initialFrameRate);
  console.log('[pet] render rate', initialFrameRate, 'fps');
} catch (_) {}
stage.appendChild(avatar);

// --- Gaze / head follow ---------------------------------------------------
// The component listens for `pointermove` on the window, but this window is
// transparent and click-through, so real pointer events only arrive while the
// cursor is over the robot. The main process forwards the global cursor
// position (read from QueryPointerServer on Wayland); replaying it as a
// window-level event keeps the built-in gaze/head follow working anywhere.
if (window.pet && typeof window.pet.onPointer === 'function') {
  let gazeConfirmed = false;
  window.pet.onPointer((point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const forwarded = new PointerEvent('pointermove', {
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      pointerType: 'mouse'
    });
    // Marked so the click-through fast path below only trusts real events:
    // this one is a polled position and therefore lags the physical cursor.
    forwarded.__forwardedPointer = true;
    window.dispatchEvent(forwarded);
    // One-time confirmation that the forwarded cursor actually reached the
    // avatar's gaze/head follow (helps diagnose Wayland pointer problems).
    if (!gazeConfirmed) {
      const p = avatar._pointer;
      if (p && p.active) {
        gazeConfirmed = true;
        console.log(`[pet] gaze follows the pointer (influence ${p.influence.toFixed(2)})`);
      }
    }
  });
}

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

// --- Window drag (option B) ----------------------------------------------
// Grab anywhere on the avatar and move the whole window. The window is
// click-through everywhere except the silhouette, so a pointerdown here means
// the user grabbed the pet. We only start moving after the pointer has
// travelled a few pixels, so a plain click keeps its normal behaviour and the
// avatar's own gestures (head squeeze, antenna drag, click reactions) still
// work. The position is driven from the renderer via screenX/screenY, which is
// also what makes it work under Wayland, where the global pointer is frozen.
const DRAG_THRESHOLD_PX = 10;
let dragState = null; // { pointerId, startScreenX, startScreenY, startWinX, startWinY, active }

function dragSupported() {
  return window.pet &&
    typeof window.pet.moveTo === 'function' &&
    typeof window.pet.getWindowBounds === 'function' &&
    typeof window.pet.setDragging === 'function';
}

window.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;                        // left button only
  if (event.pointerType && event.pointerType !== 'mouse') return;
  if (!dragSupported()) return;
  dragState = {
    pointerId: event.pointerId,
    // Origin of the gesture; the window position is read once the threshold is
    // crossed (see pointermove) so the window does not jump when it starts.
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    startWinX: 0,
    startWinY: 0,
    active: false
  };
}, { capture: true });

window.addEventListener('pointermove', (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  if (!dragState.active) {
    const ax = event.screenX - dragState.startScreenX;
    const ay = event.screenY - dragState.startScreenY;
    if (Math.hypot(ax, ay) < DRAG_THRESHOLD_PX) return;
    // Threshold crossed: this is a window drag, not a click. Rebase the origin
    // on the window's current position and the pointer, so the window follows
    // from here without a jump of the threshold distance.
    const b = window.pet.getWindowBounds();
    dragState.startWinX = b.x;
    dragState.startWinY = b.y;
    dragState.startScreenX = event.screenX;
    dragState.startScreenY = event.screenY;
    dragState.active = true;
    // Take over the pointer and cancel the avatar's head drag so the two do not
    // fight, and so releasing does not fire a drag reaction.
    try { avatar.cancelDrag(); } catch (_) {}
    try { document.body.setPointerCapture(event.pointerId); } catch (_) {}
    document.body.classList.add('dragging');
    if (window.pet.setDragging) window.pet.setDragging(true);
    return;
  }
  window.pet.moveTo(
    Math.round(dragState.startWinX + (event.screenX - dragState.startScreenX)),
    Math.round(dragState.startWinY + (event.screenY - dragState.startScreenY))
  );
}, { capture: true });

function endWindowDrag(event) {
  if (!dragState) return;
  if (event && event.pointerId !== dragState.pointerId) return;
  const pointerId = dragState.pointerId;
  const wasActive = dragState.active;
  dragState = null;
  if (!wasActive) return;
  document.body.classList.remove('dragging');
  try { document.body.releasePointerCapture(pointerId); } catch (_) {}
  if (window.pet.setDragging) window.pet.setDragging(false);
}

window.addEventListener('pointerup', endWindowDrag, { capture: true });
window.addEventListener('pointercancel', endWindowDrag, { capture: true });

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

// --- Click-through region -------------------------------------------------
// The main process only keeps the window interactive where the robot is
// actually drawn, so it needs the silhouette in window CSS pixels. Sample the
// head path into a polygon; the transparent rest of the window then lets
// clicks reach the desktop.
let lastRegionJSON = '';
/** Last silhouette sent to main, in window CSS pixels (for local hit tests). */
let lastRegion = null;

function computeHitRegion() {
  const root = avatar.shadowRoot;
  if (!root) return null;
  const svg = root.querySelector('svg');
  if (!svg) return null;
  const path = root.querySelector('#headShape') || root.querySelector('#head path');
  const head = root.querySelector('#head') || root.querySelector('svg use');

  const toWindow = (el, x, y) => {
    try {
      const m = el.getScreenCTM();
      if (m) {
        const pt = new DOMPoint(x, y).matrixTransform(m);
        if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) return pt;
      }
    } catch (_) {}
    return null;
  };

  const region = { polygon: [], circles: [] };

  if (path && head && typeof path.getTotalLength === 'function') {
    let total = 0;
    try { total = path.getTotalLength(); } catch (_) { total = 0; }
    if (total > 0) {
      const steps = 128;
      for (let i = 0; i < steps; i++) {
        const p = path.getPointAtLength((i / steps) * total);
        const w = toWindow(head, p.x, p.y);
        // Half-pixel rounding keeps the payload stable while the idle
        // animation wobbles the head a fraction of a pixel.
        if (w) region.polygon.push(Math.round(w.x * 2) / 2, Math.round(w.y * 2) / 2);
      }
    }
  }

  // Fallback: the head's bounding box (better than the whole window).
  if (region.polygon.length < 6 && head) {
    const r = head.getBoundingClientRect();
    region.polygon.push(r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom);
  }

  // The antenna dot lives outside the head path, so add it as a circle.
  const dot = root.querySelector('#antennaDot');
  if (dot && typeof dot.getScreenCTM === 'function') {
    try {
      const m = dot.getScreenCTM();
      const cx = Number(dot.getAttribute('cx'));
      const cy = Number(dot.getAttribute('cy'));
      const radius = Number(dot.getAttribute('r'));
      if (m && Number.isFinite(cx) && Number.isFinite(cy) && radius > 0) {
        const center = new DOMPoint(cx, cy).matrixTransform(m);
        const scale = Math.hypot(m.a, m.b) || 1;
        region.circles.push({ x: center.x, y: center.y, r: radius * scale });
      }
    } catch (_) {}
  }

  return region.polygon.length >= 6 ? region : null;
}

function reportHitRegion() {
  try {
    const region = computeHitRegion();
    if (!region) return;
    const json = JSON.stringify(region);
    if (json === lastRegionJSON) return;
    lastRegionJSON = json;
    lastRegion = region;
    if (window.pet && typeof window.pet.setHitRegion === 'function') {
      window.pet.setHitRegion(region);
      console.log(`[pet] hit region: ${region.polygon.length / 2} points, ${region.circles.length} circles`);
    }
  } catch (err) {
    console.error('[pet] could not compute the hit region:', err && err.message);
  }
}

// Poll for the head element; re-attach if the shadow DOM re-renders.
setInterval(() => {
  const head = getHeadElement();
  if (head) {
    attachHoverListener(head);
    applyDebugStyle(head);
  }
}, 1000);

// Keep the click-through region in sync with the (animating) avatar.
requestAnimationFrame(reportHitRegion);
setInterval(reportHitRegion, 200);

// --- Fast click-through path ---------------------------------------------
// Only the avatar silhouette should keep the window interactive. The main
// process normally decides that from polled global-pointer samples, which lag
// the physical cursor by one GNOME-extension tick plus the poll interval; a
// fast move off the robot followed by a click therefore landed on the still
// interactive window and was swallowed. While the window *is* interactive it
// receives real pointer events, so we hit-test those (exact pixel, no lag) and
// tell main to go click-through the moment the cursor leaves the silhouette.
function pointInPolygon(x, y, flat) {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isInsideSilhouette(region, x, y) {
  if (!region) return false;
  if (region.polygon.length >= 6 && pointInPolygon(x, y, region.polygon)) return true;
  for (const c of region.circles || []) {
    const dx = x - c.x, dy = y - c.y;
    if (dx * dx + dy * dy <= c.r * c.r) return true;
  }
  return false;
}

function reportPointerOffAvatar(x, y) {
  if (!window.pet || typeof window.pet.pointerLeft !== 'function') return;
  window.pet.pointerLeft({ x: Math.round(x), y: Math.round(y) });
}

window.addEventListener('pointermove', (event) => {
  if (event.__forwardedPointer) return;      // polled position, not real
  if (event.pointerType && event.pointerType !== 'mouse') return;
  if (!lastRegion) return;
  if (!isInsideSilhouette(lastRegion, event.clientX, event.clientY)) {
    reportPointerOffAvatar(event.clientX, event.clientY);
  }
}, { capture: true, passive: true });

// The cursor leaving the window entirely is also "off the avatar"; this fires
// when the pointer exits while the window is still interactive.
window.addEventListener('pointerleave', () => {
  reportPointerOffAvatar(-1, -1);
}, { passive: true });

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
  /** Current silhouette in window CSS pixels (for debugging/automation). */
  hitRegion() {
    return computeHitRegion();
  },

  /** Apply a new render rate; returns the value the avatar accepted. */
  setFrameRate(fps) {
    const value = Number(fps);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('setFrameRate: expected a positive number, got ' + fps);
    }
    avatar.setFrameRate(value);
    console.log('[pet] frame rate ->', value, 'fps');
    return value;
  },

  /** Last gaze target the avatar derived from the pointer (debugging). */
  pointerState() {
    const p = avatar._pointer;
    return p ? { x: p.x, y: p.y, active: p.active, influence: p.influence } : null;
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
