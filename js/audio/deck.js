import { clamp } from "../lib/dom.js";
import { BufferSource, ElementSource, STREAM_AFTER_SECONDS } from "./sources.js";

/**
 * Position is derived from the audio clock, never accumulated per frame, so the
 * playhead cannot drift away from what you hear during a 30-minute ambient piece.
 * In stream mode the element's own clock is authoritative instead.
 */
export class Deck {
  constructor(engine, channelId) {
    this.engine = engine;
    this.channelId = channelId;
    this.rec = null;
    this.source = null;

    this.rate = 1;
    this.rateLimit = 16; // percent; tighten this for tonal material
    this.baseBpm = 120;
    this.bpm = 120;
    this.beat1 = 0;
    this.cue = 0;
    this.loopBeats = 0;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.trim = 1;

    this.playing = false;
    this.cueHold = false;
    this.anchorPos = 0;
    this.anchorTime = 0;
    this._listeners = new Set();
  }

  onChange(fn) { this._listeners.add(fn); }
  _emit() { for (const fn of this._listeners) fn(this); }

  get duration() { return this.source?.duration ?? 0; }
  get hasTrack() { return !!this.source; }
  get isStream() { return this.source?.kind === "stream"; }
  get beatDur() { return 60 / clamp(this.bpm, 20, 400); }

  outputNode() {
    const ch = this.engine.channels.get(this.channelId);
    return ch?.trim || this.engine.mix;
  }

  get position() {
    if (!this.hasTrack) return 0;
    const live = this.source.live();
    if (this.isStream) return clamp(this.source.position() ?? this.anchorPos, 0, this.duration);
    if (!live) return this.anchorPos;
    let p = this.anchorPos + (this.engine.now - this.anchorTime) * this.rate;
    if (this.loopBeats > 0 && this.loopEnd > this.loopStart) {
      const len = this.loopEnd - this.loopStart;
      p = this.loopStart + (((p - this.loopStart) % len) + len) % len;
    }
    return clamp(p, 0, this.duration);
  }

  /** Seconds until the end at the current rate — the number that drives a radio fade. */
  get remaining() {
    if (!this.hasTrack) return 0;
    if (this.loopBeats > 0) return Infinity;
    return Math.max(0, (this.duration - this.position) / Math.max(0.01, this.rate));
  }

  async load(rec) {
    this.stop();
    this.source?.dispose?.();
    const long = (rec.duration ?? 0) > STREAM_AFTER_SECONDS;
    const src = long ? new ElementSource(this) : new BufferSource(this);
    await src.load(rec, this.engine);
    this.source = src;
    this.rec = rec;
    this.anchorPos = rec.resumeAt ?? 0;
    this.cue = rec.cue ?? 0;
    this.loopBeats = 0;
    this.baseBpm = rec.bpm || 120;
    this.bpm = this.baseBpm;
    this.beat1 = rec.beat1 ?? 0;
    this.setTempoPct(0);
    this._emit();
    return this;
  }

  unload() {
    this.stop();
    this.source?.dispose?.();
    this.source = null;
    this.rec = null;
    this._emit();
  }

  play() {
    if (!this.hasTrack || this.playing) return;
    this._start(this.position);
    this.playing = true;
    this._emit();
  }

  stop() {
    this.playing = false;
    this.source?.stop();
    this._emit();
  }

  pause() {
    const p = this.position;
    this.playing = false;
    this.source?.stop();
    this.anchorPos = p;
    this._emit();
  }

  seek(pos) {
    const p = clamp(pos, 0, this.duration);
    const was = this.playing;
    this.anchorPos = p;
    if (was) this._start(p);
    this._emit();
  }

  goCue() { this.seek(this.cue); }

  setCueHere() {
    this.cue = this.position;
    if (this.loopBeats > 0) this._recomputeLoop();
    this._emit();
  }

  _start(pos) {
    const loop = this.loopBeats > 0 && this.loopEnd > this.loopStart
      ? { on: true, start: this.loopStart, end: this.loopEnd }
      : { on: false };
    const inLoop = loop.on && pos >= loop.start && pos < loop.end;
    const t0 = this.source.start(inLoop ? pos : loop.on ? loop.start : pos, this.rate, loop);
    this.anchorPos = loop.on && !inLoop ? loop.start : pos;
    this.anchorTime = t0 ?? this.engine.now;
  }

  /**
   * Rate stays a live parameter, so dragging the tempo fader never restarts audio.
   * Note this is vinyl-style: rate and pitch move together, which is why the UI
   * shows the resulting semitone shift instead of pretending it is key-safe.
   */
  setTempoPct(pct) {
    const p = clamp(pct, -this.rateLimit, this.rateLimit);
    const pos = this.position;
    const was = this.playing;
    this.rate = 1 + p / 100;
    this.anchorPos = pos;
    this.anchorTime = this.engine.now;
    this.bpm = this.baseBpm * this.rate;
    this.source?.setRate(this.rate);
    if (was && !this.isStream) this._resyncAnchor();
    this._emit();
  }

  _resyncAnchor() {
    const ctx = this.engine.ctx;
    this.anchorPos = this.position;
    this.anchorTime = ctx.currentTime;
  }

  get tempoPct() { return (this.rate - 1) * 100; }

  /** Semitone offset implied by the current rate, so cross-genre blends stay in key by eye. */
  get semitones() { return 12 * Math.log2(this.rate); }

  setRateLimit(pct) {
    this.rateLimit = clamp(pct, 0, 16);
    if (Math.abs(this.tempoPct) > this.rateLimit) this.setTempoPct(clamp(this.tempoPct, -this.rateLimit, this.rateLimit));
    else this._emit();
  }

  setBpm(bpm) { this.baseBpm = clamp(bpm, 20, 400); this.bpm = this.baseBpm * this.rate; this._emit(); }

  matchFrom(other) {
    if (!other?.hasTrack) return false;
    this.setBpm(other.baseBpm);
    this.setTempoPct(other.tempoPct);
    this.beat1 = other.beat1;
    this._emit();
    return true;
  }

  setBeat1FromTime(t) { this.beat1 = clamp(t, 0, this.duration); this._emit(); }

  beatIndexAt(time) { return Math.floor((time - this.beat1) / this.beatDur); }

  quantize(time, divisions = 1) {
    const step = this.beatDur / divisions;
    return this.beat1 + Math.round((time - this.beat1) / step) * step;
  }

  setLoopBeats(n) {
    this.loopBeats = clamp(n, 0, 64);
    this._recomputeLoop();
    if (this.playing) this._start(this.anchorPos);
    this._emit();
  }

  _recomputeLoop() {
    if (this.loopBeats <= 0) { this.loopStart = this.loopEnd = 0; return; }
    const idx = Math.max(0, this.beatIndexAt(this.position));
    this.loopStart = clamp(this.quantize(this.beatTime(idx), 1), 0, this.duration);
    this.loopEnd = clamp(this.loopStart + this.loopBeats * this.beatDur, 0, this.duration);
  }

  beatTime(index) { return this.beat1 + index * this.beatDur; }

  /** Auto-level: scale trim so this deck's measured RMS lands on the target. */
  applyTrimFor(targetDb, sourceRmsDb) {
    if (!Number.isFinite(sourceRmsDb)) return;
    const delta = Math.pow(10, (targetDb - sourceRmsDb) / 20);
    this.trim = clamp(delta, 0.05, 8);
    const ch = this.engine.channels.get(this.channelId);
    if (ch) ch.trim && this.engine.setTrim(this.channelId, this.trim);
    this._emit();
  }

  startCuePreview() {
    if (!this.hasTrack || this.cueHold) return;
    const ch = this.engine.channels.get(this.channelId);
    this.cueHold = true;
    if (ch) {
      this._faderCache = ch.values.fader;
      this._wasAudition = !!this.engine.cueAudition;
      this.engine.setCueAudition(true);
      this.engine.cueSendFor(this.channelId, 1);
      this.engine.setChannelValue(this.channelId, "fader", 0);
    }
    this._start(this.cue);
    this.playing = true;
    this._emit();
  }

  releaseCue() {
    if (!this.cueHold) return;
    this.cueHold = false;
    this.playing = false;
    this.source?.stop();
    this.anchorPos = this.cue;
    const ch = this.engine.channels.get(this.channelId);
    if (ch) {
      this.engine.cueSendFor(this.channelId, 0);
      this.engine.setChannelValue(this.channelId, "fader", this._faderCache ?? ch.values.fader);
      if (!this._wasAudition) this.engine.setCueAudition(false);
    }
    this._emit();
  }

  toggleCuePreview() { this.cueHold ? this.releaseCue() : this.startCuePreview(); }

  tick() {
    if (!this.playing || !this.hasTrack) return;
    const p = this.position;
    if (this.loopBeats <= 0 && p >= this.duration - 0.02) {
      if (this.cueHold) this.releaseCue();
      else { this.playing = false; this.anchorPos = this.duration; this.source?.stop(); this._emit(); }
      return;
    }
    if (!this.isStream && this.engine.now - this.anchorTime > 30) this._resyncAnchor();
  }
}
