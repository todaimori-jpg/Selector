import { clamp } from "../lib/dom.js";

const FLOOR_DB = -36;
const SEGMENTS = 26;
// The original's calibration: 0 VU sits at -18 dBFS, so the scale is anchored there.
const ZERO_VU_DB = -18;

export class Meter {
  constructor(canvas, { stereo = false } = {}) {
    this.canvas = canvas;
    this.c = canvas.getContext("2d", { alpha: false });
    this.stereo = stereo;
    this._last = "";
    this._fit();
    window.addEventListener("resize", () => { this._fit(); this._last = ""; }, { passive: true });
  }

  _fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr) || 1;
    const h = Math.round(this.canvas.clientHeight * dpr) || 1;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.w = w; this.h = h; this.dpr = dpr;
  }

  draw(lDb, rDb = null) {
    const key = `${this.w}|${this.h}|${lDb.toFixed(1)}|${(rDb ?? 0).toFixed(1)}`;
    if (key === this._last) return;
    this._last = key;
    const c = this.c;
    c.fillStyle = "#070c15";
    c.fillRect(0, 0, this.w, this.h);
    const tracks = this.stereo ? [lDb, rDb] : [lDb];
    const gap = this.dpr;
    const th = (this.h - gap * (tracks.length - 1)) / tracks.length;
    tracks.forEach((db, i) => this._track(db, i * (th + gap), th));
    // 0 VU reference notch
    const x = this._xFor(ZERO_VU_DB);
    c.fillStyle = "rgba(220,235,255,0.55)";
    c.fillRect(Math.round(x), 0, Math.max(1, this.dpr), this.h);
  }

  _xFor(db) {
    const u = (db - FLOOR_DB) / (0 - FLOOR_DB);
    return u * this.w;
  }

  _track(db, y, h) {
    const c = this.c;
    const segW = this.w / SEGMENTS;
    const active = Math.round(clamp((db - FLOOR_DB) / (0 - FLOOR_DB), 0, 1) * SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) {
      const on = i < active;
      const frac = i / SEGMENTS;
      c.fillStyle = !on
        ? "#131d2b"
        : frac > 0.94 ? "#ff5468"
        : frac > 0.82 ? "#ffb347"
        : frac > 0.5 ? "#4fd8e8"
        : "#2f7f92";
      c.fillRect(Math.round(i * segW), Math.round(y), Math.ceil(segW - 1.2 * this.dpr), Math.round(h));
    }
  }
}
