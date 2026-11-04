import { clamp } from "../lib/dom.js";

/**
 * Two playback paths behind one interface, chosen by file length.
 *
 * Buffer mode is sample-accurate and cheap to seek, but holding a 35-minute
 * field recording as Float32 is ~270 MB and Safari on iPad kills the tab rather
 * than warn you. Stream mode plays the same Blob through a media element, which
 * keeps a few seconds of audio in memory regardless of length.
 */
export class BufferSource {
  constructor(deck) {
    this.deck = deck;
    this.src = null;
    this.env = null;
    this.kind = "buffer";
  }

  async load(rec, engine) {
    this.engine = engine;
    this.buffer = await engine.decode(await rec.blob.arrayBuffer());
    this.duration = this.buffer.duration;
  }

  _ensureEnv() {
    if (!this.env) {
      this.env = this.engine.ctx.createGain();
      this.env.connect(this.deck.outputNode());
    }
    return this.env;
  }

  start(at, rate, loop) {
    const ctx = this.engine.ctx;
    this.stop();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;
    const env = this._ensureEnv();
    const t0 = ctx.currentTime + 0.001;
    env.gain.cancelScheduledValues(t0);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.004);
    if (loop.on) { src.loop = true; src.loopStart = loop.start; src.loopEnd = loop.end; }
    src.connect(env);
    src.start(t0, clamp(at, 0, Math.max(0, this.duration - 0.01)));
    this.src = src;
    return t0;
  }

  stop() {
    if (!this.src) return;
    const old = this.src;
    this.src = null;
    try { old.stop(this.engine.ctx.currentTime + 0.006); } catch { /* already done */ }
    old.onended = () => { try { old.disconnect(); } catch { /* noop */ } };
  }

  setRate(rate) { if (this.src) this.src.playbackRate.setTargetAtTime(rate, this.engine.ctx.currentTime, 0.015); }
  live() { return !!this.src; }
  position() { return null; } // derived by the deck from its own clock
}

export class ElementSource {
  constructor(deck) {
    this.deck = deck;
    this.el = null;
    this.node = null;
    this.url = null;
    this.kind = "stream";
    this._pendingRate = 1;
  }

  async load(rec, engine) {
    this.engine = engine;
    if (!engine.ctx) await engine.enable();
    this.url = URL.createObjectURL(rec.blob);
    const el = new window.Audio();
    el.src = this.url;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    await new Promise((res, rej) => {
      el.onloadedmetadata = res;
      el.onerror = () => rej(new Error("This browser cannot stream this file."));
      setTimeout(res, 4000); // some codecs never fire metadata; duration stays NaN and we cope
    });
    this.el = el;
    this.duration = Number.isFinite(el.duration) ? el.duration : rec.duration || 0;
    // created once per deck and reused: a second createMediaElementSource on the
    // same element throws, so this must never run twice for one element.
    this.node = engine.ctx.createMediaElementSource(el);
    this.node.connect(this.deck.outputNode());
  }

  start(at, rate, loop) {
    const el = this.el;
    if (!el) return 0;
    el.loop = false;
    el.currentTime = clamp(at, 0, Math.max(0, this.duration - 0.01));
    el.playbackRate = rate;
    this._pendingRate = rate;
    el.play().catch(() => { /* autoplay policy: deck.play already ran from a gesture */ });
    return this.engine.ctx.currentTime;
  }

  stop() { try { this.el?.pause(); } catch { /* noop */ } }
  setRate(rate) { if (this.el) { this.el.playbackRate = rate; this._pendingRate = rate; } }
  live() { return !!this.el && !this.el.paused; }
  position() { return this.el ? this.el.currentTime : 0; }

  dispose() {
    this.stop();
    try { this.node?.disconnect(); } catch { /* noop */ }
    if (this.url) URL.revokeObjectURL(this.url);
    this.el = null; this.node = null; this.url = null;
  }
}

export const STREAM_AFTER_SECONDS = 600; // 10 minutes: past this, buffer mode is a memory hazard
