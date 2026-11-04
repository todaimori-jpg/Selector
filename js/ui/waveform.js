import { clamp, fmtTime } from "../lib/dom.js";
import { makeDrag, tick } from "./touch.js";

const DPR_CAP = 2; // a 3x canvas on an iPad costs 2.25x the pixels for no visible gain

/**
 * Waveform rendering is deliberately direct-mode: one path, one fill per frame over
 * only the visible window. At ~800 px that is cheaper than maintaining a cache, and
 * it means the image can never drift out of sync with the audio clock.
 */
export class Waveform {
  constructor(canvas, deck, { color, mode = "main" }) {
    this.canvas = canvas;
    this.deck = deck;
    this.color = color;
    this.mode = mode;
    this.span = 8;
    this.ctx2d = canvas.getContext("2d", { alpha: false });
    this._lastKey = "";
    this._fit();
    if (mode === "main") this._bindGridDrag();
    else this._bindSeek();
    window.addEventListener("resize", () => { this._fit(); this._lastKey = ""; }, { passive: true });
  }

  setSpan(s) { this.span = s; this._lastKey = ""; }

  /**
   * The overview has to show where the zoomed view is looking, so it asks for that
   * window instead of computing its own — its own is always 0, which is what pinned
   * the position box to the left edge.
   */
  setWindowSource(fn) { this._windowSource = fn; this._lastKey = ""; }

  /** Window the big view is showing, in seconds. */
  visibleWindow() {
    if (this._windowSource) return this._windowSource();
    return { start: this.windowStart(), span: this.span };
  }

  _fit() {
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  get pxPerSec() { return this.w / this.span; }
  get timePerPx() { return 1 / this.pxPerSec; }

  /** Main view: playhead sits at 30% so you can see what is coming. */
  windowStart() {
    const p = this.deck.position;
    return this.mode === "main" ? p - this.span * 0.3 : 0;
  }

  _bindGridDrag() {
    const deck = this.deck;
    makeDrag(this.canvas, {
      onStart: (d) => {
        d.startBeat1 = deck.beat1;
        d.startBpm = deck.baseBpm;
        d.axis = null;
      },
      onMove: (d, m) => {
        const dx = m.x - d.startX, dy = m.y - d.startY;
        if (!d.axis && Math.hypot(dx, dy) > 8) d.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        if (d.axis === "x") {
          deck.beat1 = clamp(d.startBeat1 - dx * this.timePerPx / this.dpr, 0, deck.duration);
        } else if (d.axis === "y") {
          deck.setBpm(d.startBpm * (1 - dy / 220));
        }
        this._lastKey = "";
      },
      onEnd: (d) => {
        if (d.axis) tick(8);
        deck._emit();
        d.axis = null;
      },
    });
  }

  _bindSeek() {
    const deck = this.deck;
    makeDrag(this.canvas, {
      onStart: (d) => { this._scrub(d); },
      onMove: (d) => { this._scrub(d); },
      onEnd: () => { tick(6); deck._emit(); },
    });
  }

  _scrub(d) {
    const r = this.canvas.getBoundingClientRect();
    const x = clamp((d.lastX - r.left) / r.width, 0, 1);
    this.deck.seek(x * this.deck.duration);
    this._lastKey = "";
  }

  draw(force = false) {
    this._fit();
    const c = this.ctx2d;
    const deck = this.deck;

    if (!deck.hasTrack) {
      c.fillStyle = "#0a1120";
      c.fillRect(0, 0, this.w, this.h);
      c.fillStyle = "#243349";
      c.font = `${11 * this.dpr}px system-ui`;
      c.fillText(this.mode === "main" ? "Load a track" : "no track", 6 * this.dpr, this.h / 2 + 4 * this.dpr);
      this._lastKey = "";
      return;
    }

    const rec = deck.rec;
    if (!rec.peaks) {
      // Long-form files analysed without a peak map still need a readable timeline.
      const pps = this.mode === "main" ? this.pxPerSec : this.w / Math.max(0.001, deck.duration);
      const k = `t|${rec.id}|${Math.round((this.mode === "main" ? this.windowStart() : deck.position) * pps)}`;
      if (!force && k === this._lastKey) return;
      this._lastKey = k;
      this._drawTimeline(c, rec);
      return;
    }
    const pk = rec.peaks;
    const start = this.mode === "main" ? this.windowStart() : 0;
    const pps = this.mode === "main" ? this.pxPerSec : this.w / Math.max(0.001, deck.duration);
    const pos = deck.position;

    // Quantised to pixels: a frame that would draw identically is skipped.
    const win = this.visibleWindow();
    const key = this.mode === "main"
      ? `m|${this.w}|${this.h}|${rec.id}|${Math.round(pps)}|${Math.round(start * pps)}`
      : `o|${this.w}|${this.h}|${rec.id}|${Math.round(pos * pps * 4)}|${Math.round(win.start * pps)}|${Math.round(win.span * pps)}|${Math.round(deck.cue * pps)}`;
    if (!force && key === this._lastKey) return;
    this._lastKey = key;

    c.fillStyle = "#0a1120";
    c.fillRect(0, 0, this.w, this.h);

    // The full-track envelope is static, and on a 40-minute file rebuilding it costs
    // hundreds of thousands of array reads per frame, so the overview keeps its path.
    if (this.mode === "main" || this._pathKey !== `p|${rec.id}|${this.w}|${pps.toFixed(4)}`) {
      this._path = this._envelopePath(pk, start, pps);
      this._pathKey = `p|${rec.id}|${this.w}|${pps.toFixed(4)}`;
    }
    const path = this._path;

    c.fillStyle = this.color.dim;
    c.fill(path);

    const cut = this.mode === "main" ? (pos - start) * pps : pos * pps;
    if (cut > 0 && cut < this.w) {
      c.save();
      c.beginPath();
      c.rect(0, 0, cut, this.h);
      c.clip();
      c.fillStyle = this.color.bright;
      c.fill(path);
      c.restore();
    }

    if (this.mode === "main") this._drawGrid(c, start, pps, pos);
    else this._drawOverview(c, pps, pos, win);
  }

  /** One pixel column per bucket range, min and max folded into a single rect. */
  _envelopePath(pk, start, pps) {
    const path = new Path2D();
    const mid = this.h / 2;
    for (let px = 0; px < this.w; px++) {
      const t0 = start + px / pps;
      const t1 = start + (px + 1) / pps;
      let b0 = Math.floor(t0 * pk.rate), b1 = Math.ceil(t1 * pk.rate);
      if (b1 <= b0) b1 = b0 + 1;
      b0 = clamp(b0, 0, pk.count - 1);
      b1 = clamp(b1, 1, pk.count);
      let lo = 1, hi = -1;
      for (let b = b0; b < b1; b++) {
        const a = pk.data[b * 2], z = pk.data[b * 2 + 1];
        if (a < lo) lo = a;
        if (z > hi) hi = z;
      }
      if (hi <= lo) { hi = 0.002; lo = -0.002; }
      const y0 = mid - hi * mid * 0.94;
      const y1 = mid - lo * mid * 0.94;
      path.rect(px, y0, 1, Math.max(1, y1 - y0));
    }
    return path;
  }

  _drawGrid(c, start, pps, pos) {
    const deck = this.deck;
    const beat = deck.beatDur;
    let idx = Math.floor((start - deck.beat1) / beat);
    for (let i = 0; i < 200; i++, idx++) {
      const t = deck.beat1 + idx * beat;
      if (t > start + this.span) break;
      const x = Math.round((t - start) * pps);
      if (x < -1 || x > this.w + 1) continue;
      const isBar = ((idx % 4) + 4) % 4 === 0;
      c.fillStyle = isBar ? "rgba(160,190,220,0.42)" : "rgba(140,170,205,0.18)";
      c.fillRect(x, 0, isBar ? Math.max(1, this.dpr) : 1, this.h);
    }

    if (deck.loopBeats > 0) {
      const lx = (deck.loopStart - start) * pps;
      const lw = (deck.loopEnd - deck.loopStart) * pps;
      c.fillStyle = "rgba(79,216,232,0.12)";
      c.fillRect(lx, 0, lw, this.h);
      c.strokeStyle = "rgba(79,216,232,0.6)";
      c.lineWidth = this.dpr;
      c.strokeRect(lx, 1, lw, this.h - 2);
    }

    const cx = (deck.cue - start) * pps;
    if (cx > -2 && cx < this.w + 2) {
      c.fillStyle = "#ffb347";
      c.fillRect(Math.round(cx), 0, Math.max(1, this.dpr), this.h);
    }

    const px = Math.round((pos - start) * pps);
    c.fillStyle = "#f2f7ff";
    c.fillRect(px, 0, Math.max(1, this.dpr * 1.5), this.h);
  }

  /** Fallback for files too long to hold a peak map: position, cue, loop and endgame. */
  _drawTimeline(c, rec) {
    const deck = this.deck;
    const start = this.mode === "main" ? this.windowStart() : 0;
    const pps = this.mode === "main" ? this.pxPerSec : this.w / Math.max(0.001, deck.duration);
    const pos = deck.position;

    c.fillStyle = "#0a1120";
    c.fillRect(0, 0, this.w, this.h);
    const mid = this.h / 2;
    c.strokeStyle = "#1c2a3d";
    c.lineWidth = this.dpr;
    c.beginPath();
    c.moveTo(0, mid); c.lineTo(this.w, mid);
    c.stroke();

    c.fillStyle = this.color.dim;
    const played = clamp((pos - start) * pps, 0, this.w);
    c.fillRect(0, mid - this.dpr, played, this.dpr * 2);

    if (this.mode === "main") {
      this._drawGrid(c, start, pps, pos);
      c.fillStyle = "#5c6f8a";
      c.font = `${10 * this.dpr}px system-ui`;
      c.fillText("no peak map (long file)", 6 * this.dpr, this.h - 5 * this.dpr);
    } else {
      this._drawOverview(c, pps, pos, this.visibleWindow());
    }
  }

  /**
   * The map of the whole track: what has played, what is coming, and where the
   * zoomed view sits. Drag anywhere on it to jump.
   */
  _drawOverview(c, pps, pos, win) {
    const deck = this.deck;
    const dur = Math.max(0.001, deck.duration);
    const labelH = 11 * this.dpr;

    // the next half minute, so "what is coming" is readable without counting ticks
    const ahead = Math.min(dur, pos + 30);
    c.fillStyle = "rgba(255,255,255,0.09)";
    c.fillRect(pos * pps, 0, (ahead - pos) * pps, this.h - labelH);

    // outline the zoomed window rather than filling it, so the shape stays visible
    const winX = win.start * pps;
    const winW = Math.max(2 * this.dpr, win.span * pps);
    c.strokeStyle = "rgba(255,255,255,0.42)";
    c.lineWidth = this.dpr;
    c.strokeRect(Math.round(clamp(winX, 0, this.w)), Math.round(this.dpr), Math.round(Math.min(winW, this.w - winX)), Math.round(this.h - labelH - 2 * this.dpr));

    // time ruler, spaced so labels never collide
    const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const minPx = 72 * this.dpr;
    const step = STEPS.find((s) => s * pps >= minPx) || STEPS[STEPS.length - 1];
    c.font = `${9 * this.dpr}px system-ui`;
    c.textBaseline = "bottom";
    for (let t = step; t < dur; t += step) {
      const x = Math.round(t * pps);
      if (x > this.w - 4) break;
      c.fillStyle = "rgba(160,190,220,0.30)";
      c.fillRect(x, 0, 1, this.h - labelH);
      c.fillStyle = "#7f93ad";
      c.fillText(fmtTime(t), x + 3 * this.dpr, this.h - 1 * this.dpr);
    }

    c.fillStyle = "#ffb347";
    c.fillRect(Math.round(deck.cue * pps), 0, Math.max(1, this.dpr), this.h - labelH);
    c.fillStyle = "#f2f7ff";
    c.fillRect(Math.round(pos * pps), 0, Math.max(1, this.dpr * 1.5), this.h);

    c.fillStyle = "#7f93ad";
    c.fillText(`FULL ${fmtTime(dur)}`, 4 * this.dpr, this.h - 1 * this.dpr);
  }
}

export const COLORS = {
  a: { dim: "#1f5560", bright: "#4fd8e8" },
  b: { dim: "#5c2a40", bright: "#f06a9c" },
};
