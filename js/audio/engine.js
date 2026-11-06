import { clamp, gainFromUnit } from "../lib/dom.js";

/**
 * One AudioContext, created lazily inside a user gesture (iOS refuses to start
 * a context that was constructed outside one).
 *
 * graph:  deck -> trim -> [hi shelf | mid peak | lo shelf] -> hpf -> lpf -> fader -> mix
 *         lpf -> cueSend -> cueMix -> local monitor or phone stream
 *         mix -> master -> analyser -> speakers
 *                              -> recorder tap
 */
export class Engine {
  constructor() {
    this.ctx = null;
    this.channels = new Map();
    this.state = "idle";
    this._onState = [];
    this.fxSettings = [{ on: false, wet: 0.3 }, { on: false, wet: 0.3 }];
    this.delayTime = 0.4;
    this.delayFeedback = 0.3;
  }

  onState(fn) { this._onState.push(fn); }
  _set(state) { this.state = state; for (const fn of this._onState) fn(state); }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  async enable() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      });
      this._buildMaster();
      this._buildFx();
      for (const ch of this.channels.values()) this._wireChannel(ch);
      // values set before the context existed are replayed now
      if (this.masterUnit !== undefined) this.setMaster(this.masterUnit);
      if (this.cueAudition) this.setCueAudition(true);
      this._set("running");
      return this.ctx;
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
    this._set("running");
    return this.ctx;
  }

  _buildMaster() {
    const ctx = this.ctx;
    this.mix = ctx.createGain();
    this.mix.gain.value = 1;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;

    // getFloatTimeDomainData only ever returns one channel, so a real stereo VU
    // needs a splitter feeding two analysers.
    this.splitter = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    for (const a of [this.analyserL, this.analyserR]) {
      a.fftSize = 1024;
      a.smoothingTimeConstant = 0;
    }
    this._mBuf = new Float32Array(this.analyserL.fftSize);

    // Recorder tap sits after master so takes capture exactly what the speakers hear.
    this.recTap = ctx.createMediaStreamDestination();

    this.cueMix = ctx.createGain();
    this.cueMix.gain.value = 0;
    this.cueOut = ctx.createGain();
    this.cueOut.gain.value = 1;

    this.mix.connect(this.master);
    this.master.connect(ctx.destination);
    this.master.connect(this.recTap);
    this.master.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.cueMix.connect(this.cueOut);
    this.cueOut.connect(ctx.destination);
  }

  _buildFx() {
    const ctx = this.ctx;
    this.delay = ctx.createDelay(1);
    this.feedback = ctx.createGain();
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.reverb = ctx.createConvolver();
    const frames = Math.floor(ctx.sampleRate * 1.25);
    const impulse = ctx.createBuffer(2, frames, ctx.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const samples = impulse.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3;
      }
    }
    this.reverb.buffer = impulse;
    this.fx = [this.delay, this.reverb].map((effect) => {
      const out = ctx.createGain();
      effect.connect(out);
      out.connect(this.mix);
      return { effect, out };
    });
    this.fxSettings.forEach(({ wet }, index) => this.setFxWet(index, wet));
    this.setDelayTime(this.delayTime);
    this.setDelayFeedback(this.delayFeedback);
  }

  setFxEnabled(slot, on) {
    const setting = this.fxSettings[slot];
    setting.on = on;
    this.setFxWet(slot, setting.wet);
  }

  setFxWet(slot, wet) {
    const setting = this.fxSettings[slot];
    setting.wet = wet;
    this.fx?.[slot].out.gain.setTargetAtTime(setting.on ? wet * 0.5 : 0, this.ctx.currentTime, 0.015);
  }

  setDelayTime(value) {
    this.delayTime = value;
    this.delay?.delayTime.setTargetAtTime(0.055 + value * 0.8, this.ctx.currentTime, 0.015);
  }

  setDelayFeedback(value) {
    this.delayFeedback = value;
    this.feedback?.gain.setTargetAtTime(value * 0.75, this.ctx.currentTime, 0.015);
  }

  setFxSend(id, slot, on) {
    const ch = this.channels.get(id);
    ch.fxOn[slot] = on;
    ch.fxSends?.[slot].gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.015);
  }

  addChannel(id) {
    const ch = {
      id,
      trim: null, hi: null, mid: null, lo: null, hpf: null, lpf: null,
      fader: null, previewMute: null, cueSend: null, fxOn: [false, false],
      values: { gain: 0.5, hi: 0.5, mid: 0.5, lo: 0.5, hpf: 0, lpf: 1, fader: 0.65 },
      analyser: null, _buf: null,
    };
    this.channels.set(id, ch);
    if (this.ctx) this._wireChannel(ch);
    return ch;
  }

  _wireChannel(ch) {
    if (!this.ctx || ch.hi) return;
    const ctx = this.ctx;
    ch.trim = ctx.createGain();
    ch.hi = ctx.createBiquadFilter(); ch.hi.type = "highshelf"; ch.hi.frequency.value = 3200;
    ch.mid = ctx.createBiquadFilter(); ch.mid.type = "peaking"; ch.mid.frequency.value = 1000; ch.mid.Q.value = 0.7;
    ch.lo = ctx.createBiquadFilter(); ch.lo.type = "lowshelf"; ch.lo.frequency.value = 320;
    ch.hpf = ctx.createBiquadFilter(); ch.hpf.type = "highpass"; ch.hpf.Q.value = 0.707;
    ch.lpf = ctx.createBiquadFilter(); ch.lpf.type = "lowpass"; ch.lpf.Q.value = 0.707;
    ch.fader = ctx.createGain();
    ch.previewMute = ctx.createGain();
    ch.cueSend = ctx.createGain(); ch.cueSend.gain.value = 0;
    ch.analyser = ctx.createAnalyser();
    ch.analyser.fftSize = 1024;
    ch.analyser.smoothingTimeConstant = 0;
    // explicit mono down-mix so the channel meter reflects L+R, not just L
    ch.analyser.channelCount = 1;
    ch.analyser.channelCountMode = "explicit";
    ch._buf = new Float32Array(ch.analyser.fftSize);

    ch.trim.connect(ch.hi); ch.hi.connect(ch.mid); ch.mid.connect(ch.lo);
    ch.lo.connect(ch.hpf); ch.hpf.connect(ch.lpf); ch.lpf.connect(ch.fader);
    ch.fader.connect(ch.previewMute);
    ch.previewMute.connect(this.mix);
    ch.fxSends = this.fx.map(({ effect }, slot) => {
      const send = ctx.createGain();
      send.gain.value = ch.fxOn[slot] ? 1 : 0;
      ch.previewMute.connect(send);
      send.connect(effect);
      return send;
    });
    // cue is pre-fader, so a channel can be muted in the mix and still be auditioned
    ch.lpf.connect(ch.cueSend);
    ch.cueSend.connect(this.cueMix);
    ch.fader.connect(ch.analyser);

    for (const [key, value] of Object.entries(ch.values)) this.setChannelValue(ch.id, key, value);
  }

  /**
   * EQ units are 0..1 with 0.5 = 0 dB, swept +/- 12 dB like a real rotary.
   * HPF/LPF use a log 20 Hz..20 kHz law; fader uses a perceptual taper.
   */
  setChannelValue(id, key, unit) {
    const ch = this.channels.get(id);
    if (!ch) return;
    unit = clamp(unit, 0, 1);
    ch.values[key] = unit;
    if (!this.ctx || !ch.hi) return;
    const t = this.ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, t, 0.008); // de-zipper without adding lag
    const db = (unit - 0.5) * 24;
    switch (key) {
      case "gain": this.setTrim(id, ch.trimValue ?? 1); break;
      case "hi": set(ch.hi.gain, db); break;
      case "mid": set(ch.mid.gain, db); break;
      case "lo": set(ch.lo.gain, db); break;
      case "hpf": set(ch.hpf.frequency, 20 * Math.pow(1000, unit)); break;
      case "lpf": set(ch.lpf.frequency, 20 * Math.pow(1000, unit)); break;
      case "fader": {
        // drop any fade still scheduled on the audio thread: the finger wins
        ch.fader.gain.cancelScheduledValues(t);
        set(ch.fader.gain, this.faderLaw(unit));
        break;
      }
    }
  }

  /**
   * A fade scheduled on the audio thread as short linear ramp segments.
   *
   * A ramp driven from requestAnimationFrame stops the instant the tab is hidden,
   * which on a phone means a 20-second ambient blend freezes half open and the
   * listener hears a channel stuck at 40%. Sampling the taper into <=50ms segments
   * keeps the fade completing while the JS thread sleeps, and keeps a two-channel
   * crossfade summing flat because both sides are sampled from the same law.
   */
  rampFader(id, toUnit, seconds) {
    const ch = this.channels.get(id);
    if (!ch) return;
    const target = clamp(toUnit, 0, 1);
    ch.values.fader = target;
    if (!this.ctx || !ch.fader) return;
    const g = ch.fader.gain;
    const t0 = this.ctx.currentTime + 0.002;
    g.cancelScheduledValues(t0);
    // Start from the gain actually in effect now, so grabbing a fader mid-fade,
    // or interrupting one fade with another, cannot click or jump.
    const from = this.faderLawInv(clamp(g.value, 0, 1));
    if (seconds <= 0.05 || from === target) {
      g.setValueAtTime(this.faderLaw(from), t0);
      g.setTargetAtTime(this.faderLaw(target), t0, 0.008);
      return;
    }
    const steps = Math.max(2, Math.min(64, Math.ceil(seconds / 0.05)));
    g.setValueAtTime(this.faderLaw(from), t0);
    for (let i = 1; i <= steps; i++) {
      const u = from + (target - from) * (i / steps);
      g.linearRampToValueAtTime(this.faderLaw(u), t0 + (seconds * i) / steps);
    }
  }

  /** Inverse of faderLaw, so a fade can start from the gain that is live right now. */
  faderLawInv(gain) {
    if (gain <= 0) return 0;
    if (gain >= 1) return 1;
    return this.faderCurve === "linear" ? Math.pow(gain, 1 / 1.6) : Math.asin(gain) * (2 / Math.PI);
  }

  /** Pre-EQ scale used by auto-level; keeps loudness matching off the fader taper. */
  setTrim(id, value) {
    const ch = this.channels.get(id);
    if (!ch) return;
    ch.trimValue = clamp(value, 0.02, 12);
    if (ch.trim && this.ctx) ch.trim.gain.setTargetAtTime(ch.trimValue * 10 ** ((ch.values.gain - 0.5) * 24 / 20), this.ctx.currentTime, 0.02);
  }

  /**
   * Fader taper. With "power", both channels use sin(u*PI/2), so a crossfade where
   * one goes up as the other comes down sums to constant power instead of dipping
   * in the middle — the difference that matters on a 20-second ambient blend.
   */
  faderLaw(u) {
    return this.faderCurve === "linear" ? Math.pow(u, 1.6) : Math.sin(u * Math.PI / 2);
  }

  setFaderCurve(name) {
    this.faderCurve = name === "linear" ? "linear" : "power";
    for (const id of this.channels.keys()) this.setChannelValue(id, "fader", this.channels.get(id).values.fader);
  }

  setMaster(unit) {    this.masterUnit = clamp(unit, 0, 1);
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(gainFromUnit(this.masterUnit), this.ctx.currentTime, 0.008);
  }

  routePhoneCue() {
    const destination = this.ctx.createMediaStreamDestination();
    this.cueOut.gain.value = 0;
    this.cueMix.connect(destination);
    this.phoneCueActive = true;
    return {
      stream: destination.stream,
      release: () => {
        this.cueMix.disconnect(destination);
        destination.stream.getTracks().forEach((track) => track.stop());
        this.phoneCueActive = false;
        this.cueOut.gain.value = 1;
      },
    };
  }

  setCueAudition(on) {
    this.cueAudition = !!on;
    this.updateCueMix();
  }

  cueSendFor(id, level) {
    const ch = this.channels.get(id);
    if (ch?.cueSend && this.ctx) ch.cueSend.gain.setTargetAtTime(clamp(level, 0, 1), this.ctx.currentTime, 0.01);
    if (ch) ch.cueLevel = clamp(level, 0, 1);
    this.updateCueMix();
  }

  updateCueMix() {
    const on = this.cueAudition || [...this.channels.values()].some((ch) => ch.cueLevel > 0);
    this.cueMix?.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /** Peak dBFS for a stereo analyser, [-inf..0]. */
  readLevel(analyser, buf) {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    return peak <= 0.0001 ? -80 : 20 * Math.log10(peak);
  }

  masterLevel() {
    if (!this.analyserL) return { l: -80, r: -80 };
    return { l: this.readLevel(this.analyserL, this._mBuf), r: this.readLevel(this.analyserR, this._mBuf) };
  }

  channelLevel(id) {
    const ch = this.channels.get(id);
    if (!ch?.analyser) return -80;
    return this.readLevel(ch.analyser, ch._buf);
  }

  async decode(arrayBuffer) {
    if (!this.ctx) await this.enable();
    return await this.ctx.decodeAudioData(arrayBuffer.slice(0));
  }
}
