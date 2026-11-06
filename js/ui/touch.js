import { clamp } from "../lib/dom.js";

/**
 * Global input hardening. Called once at boot.
 * - blocks pinch-zoom / double-tap-zoom / drag-select on the control surface
 * - blocks the iOS "peek" gestures that steal horizontal drags
 * - keeps two-finger scrolls working in lists (those elements opt in via touch-action)
 */
export function hardenTouch(root) {
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    e.preventDefault();
  }, { passive: false });

  // A pointerdown that starts on a control must never turn into a page scroll.
  root.addEventListener("touchmove", (e) => {
    if (e.cancelable && e.target.closest("[data-touch=drag]")) e.preventDefault();
  }, { passive: false });

  window.addEventListener("contextmenu", (e) => {
    if (e.target.closest("[data-touch=drag], canvas")) e.preventDefault();
  });

  window.addEventListener("blur", () => { releaseAll(); });
}

const active = new Set();
function releaseAll() { for (const d of [...active]) d.end(); }

/** iOS Safari has no Vibration API; this degrades to a silent no-op there. */
export function tick(ms = 6) {
  if (typeof navigator.vibrate === "function") { try { navigator.vibrate(ms); } catch { /* denied */ } }
}

/**
 * One-finger drag with pointer capture.
 *
 * Why this feels better than the usual approach:
 *  - setPointerCapture keeps the drag alive when the finger leaves the element,
 *    so a knob you spin past its own 60px circle does not stop responding.
 *  - getCoalescedEvents() recovers the intermediate samples the OS buffered
 *    between animation frames, which is where iPad Pencil/high-Hz touch detail lives.
 *  - the primary pointer is latched, so a stray second finger cannot hijack it.
 */
export function makeDrag(node, handlers) {
  const d = {
    node,
    handlers,
    pointerId: null,
    startX: 0,
    startY: 0,
    startValue: 0,
    lastX: 0,
    lastY: 0,
    acc: 0,
  };

  const onDown = (e) => {
    if (d.pointerId !== null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    d.pointerId = e.pointerId;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.acc = 0;
    active.add(d);
    try { node.setPointerCapture(e.pointerId); } catch { /* element gone */ }
    node.classList.add("is-dragging");
    handlers.onStart?.(d, e);
    e.preventDefault();
  };

  const onMove = (e) => {
    if (e.pointerId !== d.pointerId) return;
    // Coalesced samples give the finer-grained path the OS actually recorded.
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
    const path = events && events.length ? events : [e];
    for (const ev of path) {
      const dx = ev.clientX - d.lastX;
      const dy = ev.clientY - d.lastY;
      d.lastX = ev.clientX;
      d.lastY = ev.clientY;
      handlers.onMove?.(d, { dx, dy, x: ev.clientX, y: ev.clientY, ev });
    }
    e.preventDefault();
  };

  const onUp = (e) => {
    if (e.pointerId !== d.pointerId) return;
    d.end();
  };

  d.end = () => {
    if (d.pointerId === null) return;
    const id = d.pointerId;
    d.pointerId = null;
    active.delete(d);
    node.classList.remove("is-dragging");
    try { node.releasePointerCapture(id); } catch { /* already released */ }
    handlers.onEnd?.(d);
  };

  node.setAttribute("data-touch", "drag");
  node.style.touchAction = "none";
  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onUp);
  node.addEventListener("keydown", (e) => {
    const step = handlers.onKey?.(e.key, d);
    if (step !== undefined && step !== null) { e.preventDefault(); handlers.onNudge?.(step, d); }
  });
  node.tabIndex = node.tabIndex >= 0 ? node.tabIndex : 0;
  return d;
}

/**
 * Rotary knob: absolute-angle tracking with relative pickup.
 *
 * Absolute-angle means the pointer position around the dial IS the value, which is
 * what real hardware feels like. The relative pickup means grabbing a knob whose
 * indicator is nowhere near your finger does not make the sound jump — the first
 * movement becomes an offset instead. That single change removes most of the
 * "I touched an EQ knob and ruined the mix" problem on a 7-inch screen.
 */
export function attachKnob(node, { value, onChange, sweep = 150, detents = [], onDouble, fine }) {
  let val = clamp(value, 0, 1);
  let grabbed = false;
  let lastDetent = null;
  const cx = () => node.getBoundingClientRect().left + node.offsetWidth / 2;
  const cy = () => node.getBoundingClientRect().top + node.offsetHeight / 2;

  const angleFor = (x, y) => {
    const a = Math.atan2(x - cx(), cy() - y) * (180 / Math.PI); // 0 = straight up
    return clamp(a, -sweep / 2, sweep / 2);
  };

  const paint = () => {
    node.style.setProperty("--angle", `${(val - 0.5) * sweep}deg`);
    node.setAttribute("aria-valuenow", val.toFixed(3));
  };

  const commit = (next) => {
    const v = clamp(next, 0, 1);
    if (v === val) return;
    val = v;
    paint();
    onChange(val);
    const d = nearestDetent(val);
    if (d !== lastDetent) { lastDetent = d; if (d !== null) tick(5); }
  };

  function nearestDetent(v) {
    for (const d of detents) if (Math.abs(v - d) < 0.004) return d;
    return null;
  }

  const ctrl = makeDrag(node, {
    onStart: (d) => {
      d.startValue = val;
      grabbed = false;
    },
    onMove: (d, m) => {
      const precise = !!fine?.();
      if (!grabbed && !precise) {
        // Decide on first real movement: snap to pointer angle only if the finger
        // is already near the indicator, otherwise ride the delta.
        const dist = Math.hypot(m.x - d.startX, m.y - d.startY);
        if (dist < 12) return;
        const pointerAngle = angleFor(m.x, m.y);
        const currentAngle = (val - 0.5) * sweep;
        grabbed = Math.abs(pointerAngle - currentAngle) < 26;
      }
      if (grabbed) {
        commit(angleFor(m.x, m.y) / sweep + 0.5);
      } else {
        // fine mode slows the delta law right down for long, careful sweeps
        commit(d.startValue + (d.startY - m.y) / (precise ? 520 : 180));
      }
    },
    onEnd: () => { grabbed = false; },
    onKey: (key) => (key === "ArrowUp" || key === "ArrowRight" ? 0.02
      : key === "ArrowDown" || key === "ArrowLeft" ? -0.02 : undefined),
    onNudge: (step) => commit(val + step),
  });

  node.setAttribute("role", "slider");
  node.setAttribute("aria-valuemin", "0");
  node.setAttribute("aria-valuemax", "1");
  node.addEventListener("dblclick", () => { if (onDouble) { commit(onDouble()); tick(8); } });
  paint();

  return {
    get value() { return val; },
    /** Paint without firing onChange — used by the fade ramp. */
    set(v) { val = clamp(v, 0, 1); paint(); },
    /** Paint and fire onChange — used by programmatic resets. */
    commit(v) { commit(v); },
    destroy: () => ctrl.end(),
  };
}

/**
 * Horizontal or vertical fader (tempo, channel gain, master).
 * Absolute along the track, with the same relative-pickup idea.
 */
export function attachFader(node, { value, onChange, bipolar = false, vertical = false, onDouble, fine }) {
  let val = clamp(value, 0, 1);
  const paint = () => {
    node.style.setProperty("--pos", `${val * 100}%`);
    if (bipolar) {
      // fill grows out of the centre, which needs both edges since CSS has no portable abs()
      const lo = Math.min(0.5, val), hi = Math.max(0.5, val);
      node.style.setProperty("--fill-left", `${lo * 100}%`);
      node.style.setProperty("--fill-width", `${(hi - lo) * 100}%`);
    }
    node.setAttribute("aria-valuenow", val.toFixed(3));
  };
  const commit = (next) => {
    const v = clamp(next, 0, 1);
    if (v === val) return;
    val = v;
    paint();
    onChange(val);
  };

  makeDrag(node, {
    onStart: (d) => { d.startValue = val; },
    onMove: (d, m) => {
      const r = node.getBoundingClientRect();
      const length = (vertical ? r.height : r.width) || 1;
      const direct = (vertical ? r.bottom - m.y : m.x - r.left) / length;
      const delta = vertical ? d.startY - m.y : m.x - d.startX;
      const precise = !!fine?.();
      const near = !precise && Math.abs(direct - val) < 0.09;
      if (near) commit(direct);
      else commit(d.startValue + delta / (length * (precise ? 4 : 1)));
    },
    onKey: (key) => (key === "ArrowRight" || key === "ArrowUp" ? 0.01
      : key === "ArrowLeft" || key === "ArrowDown" ? -0.01 : undefined),
    onNudge: (step) => commit(val + step),
  });

  node.setAttribute("role", "slider");
  node.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
  node.setAttribute("aria-valuemin", "0");
  node.setAttribute("aria-valuemax", "1");
  if (onDouble) node.addEventListener("dblclick", () => { commit(onDouble()); tick(8); });
  paint();
  return {
    get value() { return val; },
    set(v) { val = clamp(v, 0, 1); paint(); },
    commit(v) { commit(v); },
    bipolar,
  };
}
