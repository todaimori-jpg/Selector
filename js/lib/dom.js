export const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** 0..1 fader law that keeps the low end usable on touch (perceptual, not linear). */
export const gainFromUnit = (u) => u <= 0 ? 0 : Math.pow(u, 1.6);
export const unitFromGain = (g) => Math.pow(g, 1 / 1.6);

/** 20 Hz .. 20 kHz log scale for a 0..1 filter knob. */
export const hzFromUnit = (u) => 20 * Math.pow(1000, clamp(u, 0, 1));
export const unitFromHz = (hz) => Math.log(hz / 20) / Math.log(1000);

export const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

export const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)}k` : `${Math.round(hz)}`);

/** dBFS readout; Web Audio gain 1.0 is treated as 0 dBFS. */
export const fmtDb = (gain) => {
  if (gain <= 0.0001) return "-inf";
  return `${(20 * Math.log10(gain)).toFixed(1)}`;
};

export const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return "0";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

export const safeName = (s) => (s || "untitled").replace(/[^\w.\- ]+/g, "_").slice(0, 90);
