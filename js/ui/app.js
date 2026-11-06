import { mountPhoneCue } from "../../phone-cue.js";
import { Engine } from "../audio/engine.js";
import { Deck } from "../audio/deck.js";
import { Recorder, extFor } from "../audio/recorder.js";
import { Library } from "../lib/library.js";
import { SessionLog } from "../lib/session.js";
import { idb } from "../lib/idb.js";
import * as gh from "../lib/github.js";
import * as sp from "../lib/spotify.js";
import { el, clamp, fmtTime, fmtHz, fmtBytes } from "../lib/dom.js";
import { hardenTouch, attachKnob, attachFader, tick } from "./touch.js";
import { Waveform, COLORS } from "./waveform.js";
import { Meter } from "./meter.js";
import { waveBlock, deckPanel, channelStrip, masterPanel } from "./build.js";

const $ = (s) => document.querySelector(s);
const STORE_KEY = "ui-state";
// 0 VU on the meter is -18 dBFS, so that is the level new tracks are trimmed toward.
const LEVEL_TARGET_DB = -18;

const KNOB_SPECS = {
  hi: { label: "HIGH", home: 0.5, fmt: (v) => `${((v - 0.5) * 24).toFixed(1)} dB` },
  mid: { label: "MID", home: 0.5, fmt: (v) => `${((v - 0.5) * 24).toFixed(1)} dB` },
  lo: { label: "LOW", home: 0.5, fmt: (v) => `${((v - 0.5) * 24).toFixed(1)} dB` },
  hpf: { label: "HPF", home: 0, fmt: (v) => `${fmtHz(20 * Math.pow(1000, v))} Hz` },
  lpf: { label: "LPF", home: 1, fmt: (v) => `${fmtHz(20 * Math.pow(1000, v))}` },
  fader: { label: "CHANNEL", home: 0.65, fmt: (v) => `${Math.round(v * 100)}%` },
};

const FADE_TIMES = [2, 5, 10, 20, 40, 80];

export class App {
  constructor() {
    this.engine = new Engine();
    this.decks = { A: new Deck(this.engine, "A"), B: new Deck(this.engine, "B") };
    this.library = new Library(this.engine);
    this.log = new SessionLog();
    this.recorder = new Recorder(this.engine);
    this.waves = {};
    this.meters = {};
    this.controls = {};
    this.ramps = {};
    this.gh = { cfg: null };
  }

  async boot() {
    hardenTouch($("#app"));
    await this.restoreState();
    // a Spotify redirect lands here with ?code=…, before anything else reads the URL
    const login = await sp.completeLogin();
    await this.library.init();
    await this.log.init();
    this.buildUi();
    this.bindTopbar();
    this.bindDecks();
    this.bindChannels();
    this.engine.setFaderCurve(this.saved.curve);
    this.bindMaster();
    mountPhoneCue($("#phoneCueButton"), () => this.engine.enable(), () => {
      const route = this.engine.routePhoneCue();
      return {
        stream: route.stream,
        release: () => {
          for (const deck of Object.values(this.decks)) deck.releaseCue();
          route.release();
        },
      };
    });
    this.bindTracks();
    this.bindRecorder();
    this.bindSettings();
    this.bindSheet();
    this.renderLists();
    this.renderQueue();
    this.engine.onState((s) => this.syncAudioButton(s));
    this.syncAudioButton(this.engine.state);
    this.loop();
    this.status(this.library.tracks.length
      ? `${this.library.tracks.length} track${this.library.tracks.length === 1 ? "" : "s"} · ${this.library.queue.length} queued. Tap Enable audio.`
      : "Add music with ＋ Music to begin.");
    if (login) {
      this.status(login.ok ? login.message : `Spotify: ${login.message}`);
      this.setTab("spotify");
    }
  }

  // ---------- state ----------
  async restoreState() {
    const s = (await idb.kv.get(STORE_KEY)) || {};
    this.saved = {
      span: s.span ?? 8,
      view: s.view ?? "decks",
      auditionHold: !!s.auditionHold,
      channels: s.channels || { A: {}, B: {} },
      master: s.master ?? 0.8,
      fadeTime: s.fadeTime ?? 10,
      autoLevel: s.autoLevel !== false,
      rateLimit: s.rateLimit ?? 16,
      curve: s.curve ?? "power",
      fineDrag: !!s.fineDrag,
    };
    this.gh.cfg = await gh.loadConfig();
    this.spCfg = await sp.loadConfig();
  }

  _persistTimer = null;
  persist() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(async () => {
      const channels = {};
      for (const id of ["A", "B"]) {
        channels[id] = {};
        for (const k of Object.keys(KNOB_SPECS)) {
          const c = this.controls[`ch-${id}-${k}`];
          if (c) channels[id][k] = c.value;
        }
      }
      await idb.kv.set(STORE_KEY, {
        span: Number($("#spanSelect").value),
        view: this.currentView,
        auditionHold: !!this.controls.audition?.pressed,
        channels,
        master: this.controls.master?.value ?? 0.8,
        fadeTime: this.saved.fadeTime,
        autoLevel: this.saved.autoLevel,
        rateLimit: this.saved.rateLimit,
        curve: this.saved.curve,
        fineDrag: this.saved.fineDrag,
      });
    }, 400);
  }

  status(msg, busy = false) {
    const n = $("#statusLine");
    n.textContent = msg;
    n.classList.toggle("is-busy", busy);
  }

  // ---------- ui ----------
  buildUi() {
    const wf = $("#waveforms");
    const dk = $("#decks");
    const ch = $("#channels");
    for (const id of ["A", "B"]) {
      const w = waveBlock(id, id === "A" ? "is-a" : "is-b");
      wf.append(w.node);
      this.waves[id] = {
        main: new Waveform(w.main, this.decks[id], { color: COLORS[id.toLowerCase()], mode: "main" }),
        over: new Waveform(w.over, this.decks[id], { color: COLORS[id.toLowerCase()], mode: "over" }),
      };
      this.waves[id].main.setSpan(this.saved.span);
      this.waves[id].over.setSpan(this.saved.span);
      this.waves[id].over.setWindowSource(() => ({
        start: this.waves[id].main.windowStart(),
        span: this.waves[id].main.span,
      }));

      const p = deckPanel(id, id);
      dk.append(p.node);
      this.controls[`deck-${id}`] = p;

      const c = channelStrip(id, id);
      ch.append(c.node);
      this.controls[`strip-${id}`] = c;
    }
    const m = masterPanel();
    $("#master").append(m.node);
    this.controls.masterPanel = m;
    $("#spanSelect").value = String(this.saved.span);
    $("#fadeSelect").value = String(this.saved.fadeTime);
  }

  bindTopbar() {
    $("#btnAudio").addEventListener("click", async () => {
      try {
        await this.engine.enable();
        this.syncAudioButton("running");
        this.status("Audio live.");
      } catch (e) { this.status(`Audio failed: ${e.message}`); }
    });
    $("#btnSettings").addEventListener("click", () => this.openSettings());
    for (const seg of document.querySelectorAll(".seg")) {
      seg.addEventListener("click", () => this.showView(seg.dataset.view));
    }
    this.showView(this.saved.view || "decks");
    $("#spanSelect").addEventListener("change", (e) => {
      const s = Number(e.target.value);
      for (const id of ["A", "B"]) { this.waves[id].main.setSpan(s); this.waves[id].over.setSpan(s); }
      this.persist();
    });
    $("#fadeSelect").addEventListener("change", (e) => {
      this.saved.fadeTime = Number(e.target.value);
      this.status(`Fade time ${this.saved.fadeTime}s.`);
      this.persist();
    });
    $("#btnMarker").addEventListener("click", () => {
      const live = ["A", "B"].filter((id) => this.decks[id].playing).map((id) => `${id}${this.decks[id].isStream ? " (stream)" : ""}`);
      const e = this.log.add("marker", `manual marker · decks ${live.length ? live.join("+") : "silent"}`);
      this.status(`Marker at ${fmtTime(e.at)}.`);
      tick(10);
    });
  }

  showView(name) {
    this.currentView = name;
    document.querySelectorAll(".seg").forEach((s) => s.classList.toggle("is-active", s.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === name));
    this.persist();
  }

  syncAudioButton(state) {
    const b = $("#btnAudio");
    const live = state === "running";
    b.textContent = live ? "Audio live" : "Enable audio";
    b.classList.toggle("is-active", live);
    b.disabled = live;
  }

  // ---------- decks ----------
  bindDecks() {
    for (const id of ["A", "B"]) {
      const p = this.controls[`deck-${id}`];
      const deck = this.decks[id];

      p.play.addEventListener("click", async () => {
        if (!deck.hasTrack) { await this.loadNext(id); return; }
        await this.engine.enable();
        deck.play();
        this.log.add("play", `Deck ${id} start · ${deck.rec.name}`);
        this.status(`Deck ${id} playing.`);
      });
      p.stop.addEventListener("click", () => {
        if (deck.playing) this.log.add("stop", `Deck ${id} stop · ${deck.rec?.name} at ${fmtTime(deck.position)}`);
        deck.stop();
      });
      p.cueGo.addEventListener("click", () => { if (deck.hasTrack) deck.goCue(); });
      p.levelBtn.addEventListener("click", () => this.levelDeck(id));
      p.fadeIn.addEventListener("click", () => this.rampFader(id, 1));
      p.fadeOut.addEventListener("click", () => this.rampFader(id, 0));
      p.gridBtn.addEventListener("click", () => this.openGridSheet(id));

      const f = attachFader(p.tempoTrack, {
        value: 0.5,
        fine: () => this.saved.fineDrag,
        onChange: (u) => {
          const pct = (u - 0.5) * 2 * this.saved.rateLimit;
          deck.setTempoPct(pct);
          this.syncDeck(id);
          this.persist();
        },
        onDouble: () => 0.5,
      });
      this.controls[`tempo-${id}`] = f;
      deck.onChange(() => this.syncDeck(id));
      this.syncDeck(id);
    }
  }

  syncDeck(id) {
    const deck = this.decks[id];
    const p = this.controls[`deck-${id}`];
    p.title.textContent = deck.hasTrack ? deck.rec.name : "Nothing loaded";
    p.dur.textContent = fmtTime(deck.duration);
    p.play.classList.toggle("is-on", deck.playing && !deck.cueHold);
    p.mode.textContent = deck.hasTrack ? (deck.isStream ? "stream" : "buffer") : "";
    p.mode.title = deck.isStream
      ? "Streaming: decoded as it plays, so long files stay in memory-safe territory."
      : "Buffered in memory for sample-accurate cueing.";

    const semi = deck.semitones;
    p.bpmOut.textContent = deck.hasTrack
      ? `${deck.baseBpm.toFixed(1)} BPM${Math.abs(semi) > 0.05 ? ` ${semi > 0 ? "+" : ""}${semi.toFixed(2)} st` : ""}`
      : "— BPM";
    p.pctOut.textContent = `${deck.tempoPct >= 0 ? "+" : ""}${deck.tempoPct.toFixed(1)}%`;
    // The thumb is repainted from the deck's real rate, so it never lies after a
    // load resets tempo or after a tighter tempo limit clamps an existing offset.
    const tempo = this.controls[`tempo-${id}`];
    if (tempo) {
      const u = this.saved.rateLimit
        ? clamp(0.5 + deck.tempoPct / (2 * this.saved.rateLimit), 0, 1)
        : 0.5;
      tempo.set(u);
    }
    p.remaining.textContent = deck.hasTrack && deck.playing
      ? (Number.isFinite(deck.remaining) ? `ends ${fmtTime(deck.remaining)}` : "looped")
      : (deck.hasTrack ? `ready ${fmtTime(deck.duration - deck.position)}` : "");
  }

  /** One-tap long fade, which is what manual radio blending actually needs. */
  rampFader(id, target, seconds = this.saved.fadeTime) {
    const knob = this.controls[`ch-${id}-fader`];
    const out = this.controls[`strip-${id}`].cells.fader.out;
    if (!knob) return;
    this.stopRamp(id);
    const from = knob.value;
    target = clamp(target, 0, 1);
    if (Math.abs(from - target) < 0.001) return;
    // The engine owns the audio; these timers only move the thumb.
    this.engine.rampFader(id, target, seconds);
    const t0 = performance.now();
    const dur = Math.max(1, seconds * 1000);
    const paint = () => {
      const u = clamp((performance.now() - t0) / dur, 0, 1);
      const v = from + (target - from) * u;
      knob.set(v);
      out.textContent = `${Math.round(v * 100)}%`;
      if (u >= 1) this.finishRamp(id);
    };
    paint();
    this.ramps[id] = {
      iv: setInterval(paint, 90),
      // one long timeout so the fade still completes, and a fade-out still pauses
      // the deck, when a hidden tab throttles the interval to a tick per second
      end: setTimeout(() => this.finishRamp(id), dur + 40),
      target,
      from,
      seconds,
    };
  }

  finishRamp(id) {
    const r = this.ramps[id];
    if (!r || r.done) return;
    r.done = true;
    const { target, seconds } = r;
    clearInterval(r.iv);
    clearTimeout(r.end);
    delete this.ramps[id];
    const knob = this.controls[`ch-${id}-fader`];
    const out = this.controls[`strip-${id}`].cells.fader.out;
    knob.set(target);
    out.textContent = `${Math.round(target * 100)}%`;
    if (target === 0 && this.decks[id].playing) this.decks[id].pause();
    this.log.add("fade", `Deck ${id} fade ${r.from > target ? "out" : "in"} ${seconds}s`);
    this.persist();
  }

  stopRamp(id) {
    const r = this.ramps[id];
    if (!r) return;
    clearInterval(r.iv);
    clearTimeout(r.end);
    delete this.ramps[id];
  }

  /** Trim toward the meter's 0 VU so a quiet field recording does not vanish. */
  levelDeck(id) {
    const deck = this.decks[id];
    if (!deck.hasTrack) { this.status(`Deck ${id}: nothing loaded.`); return; }
    const rec = deck.rec;
    if (!Number.isFinite(rec.rmsDb)) { this.status("No level measurement for this file."); return; }
    deck.applyTrimFor(LEVEL_TARGET_DB, rec.rmsDb);
    this.status(`Deck ${id} trimmed to ${LEVEL_TARGET_DB} dBFS RMS (${rec.rmsDb.toFixed(1)} → target).`);
    this.log.add("level", `Deck ${id} level match · ${rec.name}`);
    tick(8);
  }

  async loadNext(id) {
    const loaded = [this.decks.A.rec?.id, this.decks.B.rec?.id].filter(Boolean);
    const next = this.library.nextUp(loaded);
    if (!next) { this.status("Queue is empty. Add items in Tracks, then tap Next."); return; }
    await this.loadInto(id, next);
    await this.library.dequeue(next.id);
    this.renderQueue();
  }

  openGridSheet(id) {
    const deck = this.decks[id];
    const body = el("div");
    body.innerHTML = `
      <p class="tagline">DECK ${id} · BEAT GRID (OPTIONAL)</p>
      <div class="row">
        <label class="field"><span>BPM</span><input type="number" inputmode="decimal" min="20" max="400" step="0.01" value="${deck.baseBpm.toFixed(2)}" data-f="bpm" style="width:104px"></label>
        <label class="field"><span>Beat 1</span><input type="number" inputmode="decimal" min="0" step="0.001" value="${deck.beat1.toFixed(3)}" data-f="beat1" style="width:104px"></label>
      </div>
      <div class="row">
        <button class="mini" data-a="nudge-">-1 ms</button>
        <button class="mini" data-a="nudge+">+1 ms</button>
        <button class="mini" data-a="tap">Tap tempo</button>
        <button class="mini" data-a="cueHere">Set cue here</button>
        <button class="mini" data-a="match">Match other deck</button>
      </div>
      <p class="tagline">LOOP (BEATS)</p>
      <div class="row" data-loops>
        ${[0, 1, 2, 4, 8, 16].map((n) => `<button class="mini ${deck.loopBeats === n ? "is-a" : ""}" data-loop="${n}">${n === 0 ? "off" : n}</button>`).join("")}
      </div>
      <p class="tagline">TEMPO LAWS</p>
      <div class="row" data-limits>
        ${[0, 4, 8, 16].map((n) => `<button class="mini ${this.saved.rateLimit === n ? "is-a" : ""}" data-limit="${n}">${n === 0 ? "locked" : `±${n}%`}</button>`).join("")}
      </div>
      <p class="fineprint">Tempo here is vinyl-style: rate and pitch move together, and the deck header shows
        the resulting semitone shift. Beat ±4% stays inside a semitone, which is usually the limit for tonal
        ambient material. Locked holds the original pitch entirely.</p>
      <p class="fineprint">Drag the waveform sideways to move beat 1, or vertically to bend BPM.</p>`;

    const tapTimes = [];
    body.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a === "nudge-") deck.setBeat1FromTime(deck.beat1 - 0.001);
      if (b.dataset.a === "nudge+") deck.setBeat1FromTime(deck.beat1 + 0.001);
      if (b.dataset.a === "cueHere") deck.setCueHere();
      if (b.dataset.a === "match") {
        const other = id === "A" ? this.decks.B : this.decks.A;
        if (other.hasTrack) { deck.matchFrom(other); this.status(`Deck ${id} matched to ${deck.baseBpm.toFixed(2)}.`); }
        else this.status("The other deck has nothing loaded.");
      }
      if (b.dataset.a === "tap") {
        const now = performance.now();
        if (now - (tapTimes[tapTimes.length - 1] ?? 0) > 2200) tapTimes.length = 0;
        tapTimes.push(now);
        if (tapTimes.length >= 2) {
          const spans = [];
          for (let i = 1; i < tapTimes.length; i++) spans.push(tapTimes[i] - tapTimes[i - 1]);
          deck.setBpm(clamp(60000 / (spans.reduce((a, x) => a + x, 0) / spans.length), 20, 400));
          this.status(`Tap tempo ${deck.baseBpm.toFixed(2)} BPM.`);
        }
        tick(6);
      }
      if (b.dataset.loop !== undefined) {
        deck.setLoopBeats(Number(b.dataset.loop));
        body.querySelectorAll("[data-loop]").forEach((x) => x.classList.toggle("is-a", Number(x.dataset.loop) === deck.loopBeats));
        tick(8);
      }
      if (b.dataset.limit !== undefined) {
        this.saved.rateLimit = Number(b.dataset.limit);
        for (const d of ["A", "B"]) this.decks[d].setRateLimit(this.saved.rateLimit);
        for (const d of ["A", "B"]) this.controls[`tempo-${d}`].commit(0.5);
        body.querySelectorAll("[data-limit]").forEach((x) => x.classList.toggle("is-a", Number(x.dataset.limit) === this.saved.rateLimit));
        this.status(this.saved.rateLimit === 0 ? "Tempo locked to original pitch." : `Tempo limited to ±${this.saved.rateLimit}%.`);
        this.persist();
      }
      this.syncGridInputs(body, deck);
      deck._emit();
    });
    body.addEventListener("change", (e) => {
      if (e.target.dataset?.f === "bpm") deck.setBpm(clamp(Number(e.target.value) || 120, 20, 400));
      if (e.target.dataset?.f === "beat1") deck.setBeat1FromTime(Math.max(0, Number(e.target.value) || 0));
      deck._emit();
    });
    this.syncGridInputs(body, deck);
    this.openSheet(`Deck ${id}`, body);
  }

  syncGridInputs(body, deck) {
    const bpm = body.querySelector("[data-f=bpm]");
    const beat = body.querySelector("[data-f=beat1]");
    if (bpm && document.activeElement !== bpm) bpm.value = deck.baseBpm.toFixed(2);
    if (beat && document.activeElement !== beat) beat.value = deck.beat1.toFixed(3);
  }

  // ---------- channels ----------
  bindChannels() {
    for (const id of ["A", "B"]) {
      const strip = this.controls[`strip-${id}`];
      const deck = this.decks[id];
      this.engine.addChannel(id);

      for (const key of Object.keys(KNOB_SPECS)) {
        const spec = KNOB_SPECS[key];
        const cell = strip.cells[key];
        const start = this.saved.channels[id]?.[key] ?? spec.home;
        const apply = (v) => {
          if (key === "fader") this.stopRamp(id);
          this.engine.setChannelValue(id, key, v);
          cell.out.textContent = spec.fmt(v);
          cell.knob.classList.toggle("is-center", spec.home === 0.5 && Math.abs(v - 0.5) < 0.004);
          this.persist();
        };
        const knob = attachKnob(cell.knob, {
          value: start,
          onChange: apply,
          detents: spec.home === 0.5 ? [0.5] : [],
          onDouble: () => spec.home,
          fine: () => this.saved.fineDrag,
        });
        apply(knob.value);
        this.controls[`ch-${id}-${key}`] = knob;
      }

      deck.onChange(() => strip.cue.classList.toggle("is-on", deck.cueHold));
      const cueBlocked = () => {
        if (deck.hasTrack) return false;
        this.status(`Deck ${id}: nothing to cue.`);
        return true;
      };
      strip.cue.addEventListener("pointerdown", async () => {
        this._cueHoldMode = !!this.controls.audition?.pressed;
        if (!this._cueHoldMode || cueBlocked()) return;
        await this.engine.enable();
        deck.startCuePreview();
      });
      const endHold = () => { if (this._cueHoldMode && deck.cueHold) deck.releaseCue(); };
      strip.cue.addEventListener("pointerup", endHold);
      strip.cue.addEventListener("pointercancel", endHold);
      strip.cue.addEventListener("click", async () => {
        if (this._cueHoldMode || cueBlocked()) return;
        await this.engine.enable();
        deck.toggleCuePreview();
      });

      deck.onChange(() => { strip.name.textContent = deck.hasTrack ? deck.rec.name : "No track loaded"; });
      this.meters[id] = new Meter(strip.meter, { stereo: false });
    }
  }

  // ---------- master ----------
  bindMaster() {
    const m = this.controls.masterPanel;
    this.meters.master = new Meter(m.vu, { stereo: true });

    const knob = attachKnob(m.masterKnob, {
      value: this.saved.master ?? 0.8,
      onChange: (v) => { this.engine.setMaster(v); m.masterOut.textContent = `${Math.round(v * 100)}%`; this.persist(); },
      onDouble: () => 0.8,
    });
    this.controls.master = knob;
    this.engine.setMaster(knob.value);
    m.masterOut.textContent = `${Math.round(knob.value * 100)}%`;

    m.cueMaster.addEventListener("click", () => {
      if (this.engine.phoneCueActive) {
        this.status("Cue is routed to the iPhone. End the phone session to use local cue.");
        return;
      }
      const on = !m.cueMaster.classList.contains("is-active");
      m.cueMaster.classList.toggle("is-active", on);
      this.engine.setCueAudition(on);
      this.status(on ? "Cue bus routed to output." : "Cue bus muted.");
    });

    m.audition.addEventListener("click", () => {
      const on = !m.audition.classList.contains("is-active");
      m.audition.classList.toggle("is-active", on);
      m.audition.setAttribute("aria-pressed", String(on));
      this.controls.audition = { pressed: on };
      this.status(on ? "CUE becomes hold-to-preview." : "CUE latches on tap.");
      this.persist();
    });
    if (this.saved.auditionHold) m.audition.click();

    m.fx.addEventListener("click", () => this.openMoreSheet());
  }

  openMoreSheet() {
    const body = el("div");
    body.innerHTML = `
      <p class="tagline">FADE CURVE</p>
      <div class="row" data-curves>
        <button class="mini ${this.saved.curve === "power" ? "is-a" : ""}" data-curve="power">Constant power</button>
        <button class="mini ${this.saved.curve === "linear" ? "is-a" : ""}" data-curve="linear">Linear</button>
      </div>
      <p class="tagline">MIXER</p>
      <div class="row">
        <button class="mini" data-x="reset">Reset EQ / filters</button>
        <button class="mini" data-x="unity">Faders to 65%</button>
        <button class="mini" data-x="zero">Faders to 0</button>
        <button class="mini" data-x="stop">Stop both decks</button>
      </div>
      <p class="tagline">SESSION</p>
      <div class="row">
        <button class="mini" data-x="log">Show running order</button>
        <button class="mini" data-x="logexport">Download log</button>
        <button class="mini danger" data-x="logreset">New session</button>
      </div>
      <p class="fineprint" id="moreStorage">Storage: calculating…</p>
      <p class="fineprint">Remote control from a second device is intentionally absent: static hosting cannot
        run a signalling server, so it would depend on a third-party broker.</p>`;
    body.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.curve) {
        this.saved.curve = b.dataset.curve;
        this.engine.setFaderCurve(this.saved.curve);
        body.querySelectorAll("[data-curve]").forEach((x) => x.classList.toggle("is-a", x.dataset.curve === this.saved.curve));
        this.status(this.saved.curve === "power"
          ? "Fade curve: constant power. Crossfades hold their level."
          : "Fade curve: linear. Faster taper near unity.");
        this.persist();
        return;
      }
      const x = b.dataset.x;
      if (x === "reset") for (const id of ["A", "B"]) for (const k of ["hi", "mid", "lo", "hpf", "lpf"]) this.controls[`ch-${id}-${k}`].commit(KNOB_SPECS[k].home);
      if (x === "unity") for (const id of ["A", "B"]) this.rampFader(id, 0.65, 2);
      if (x === "zero") for (const id of ["A", "B"]) this.rampFader(id, 0, 2);
      if (x === "stop") for (const id of ["A", "B"]) this.decks[id].stop();
      if (x === "log") this.openSheet("Running order", el("pre", "logbox", this.log.toText().replace(/</g, "&lt;")));
      if (x === "logexport") this.downloadText(this.log.toText(), `selector-session-${new Date().toISOString().slice(0, 10)}.txt`);
      if (x === "logreset") { await this.log.reset(); this.status("Session log cleared."); this.closeSheet(); }
    });
    this.openSheet("FX / More", body);
    this.storageInfo().then((t) => { const n = body.querySelector("#moreStorage"); if (n) n.textContent = t; });
  }

  // ---------- tracks ----------
  bindTracks() {
    $("#btnImport").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", (e) => this.importFiles([...e.target.files]));
    $("#btnRecord").addEventListener("click", () => this.toggleRecord());
    $("#searchInput").addEventListener("input", () => this.renderLists());
    for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => this.setTab(b.dataset.tab));
    this.setTab("library");
    $("#btnNextA").addEventListener("click", () => this.loadNext("A"));
    $("#btnNextB").addEventListener("click", () => this.loadNext("B"));
    $("#queueList").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const id = b.closest("[data-id]")?.dataset.id;
      if (!id) return;
      if (b.dataset.q === "up") this.moveInQueue(id, -1);
      if (b.dataset.q === "down") this.moveInQueue(id, 1);
      if (b.dataset.q === "out") { this.library.dequeue(id); this.renderQueue(); }
      if (b.dataset.q === "A") this.loadInto("A", this.library.byId(id));
      if (b.dataset.q === "B") this.loadInto("B", this.library.byId(id));
    });
    $("#spGo").addEventListener("click", () => this.searchSpotify());
    $("#spInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.searchSpotify(); }
    });
    $("#spList").addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-sp]");
      if (!b) return;
      const item = this.spItems?.[Number(b.dataset.i)];
      if (!item) return;
      if (b.dataset.sp === "open") { window.open(sp.deepLink(item), "_blank", "noopener"); return; }
      await this.importPreview(item, b);
    });
  }

  async searchSpotify() {
    const q = $("#spInput").value.trim();
    if (!q) return;
    if (!(await sp.loadConfig()).clientId) {
      this.status("Spotify needs a client ID — add yours in Settings.");
      this.openSettings();
      return;
    }
    this.status(`Searching Spotify for “${q}”…`, true);
    this.spItems = null;
    this.renderSpotify();
    const r = await sp.search(q);
    if (r.error) {
      this.status(sp.HINTS[r.error] || `Spotify: ${r.error}`);
      this.spItems = [];
      this.spError = sp.HINTS[r.error] || String(r.error);
      this.renderSpotify();
      return;
    }
    this.spItems = r.items;
    this.spError = null;
    const withClip = r.items.filter((i) => i.preview).length;
    this.status(`${withClip} of ${r.items.length} Spotify results have a 30 s clip.`);
    this.renderSpotify();
  }

  async importPreview(item, btn) {
    btn.disabled = true;
    btn.textContent = "Reading…";
    const r = await sp.fetchPreview(item);
    if (r.error) {
      this.status(sp.HINTS[r.error] || `Could not import: ${r.error}`);
      btn.disabled = false;
      btn.textContent = r.error === "no-preview" ? "no clip" : "clip";
      return;
    }
    await this.importFiles([r.file]);
    btn.textContent = "in library";
  }

  renderSpotify() {
    const ul = $("#spList");
    ul.textContent = "";
    if (!this.spItems) {
      ul.append(el("li", "empty", "Search Spotify for a track. Results that carry a 30-second preview can be imported as a real file; the rest open in Spotify."));
      return;
    }
    if (this.spError) {
      ul.append(el("li", "empty", this.spError));
      return;
    }
    if (!this.spItems.length) {
      ul.append(el("li", "empty", "No results."));
      return;
    }
    this.spItems.forEach((item, i) => {
      const li = el("li", "track");
      const meta = el("div", "meta");
      meta.append(
        el("div", "name", item.title),
        el("div", "sub", `${item.artist} · ${item.album} · ${Math.round(item.ms / 1000)} s full`),
      );
      const acts = el("div", "btns");
      const imp = el("button", "mini", item.preview ? "30 s clip" : "no clip");
      imp.type = "button";
      imp.dataset.sp = "import";
      imp.dataset.i = String(i);
      imp.disabled = !item.preview;
      const open = el("button", "mini", "Spotify");
      open.type = "button";
      open.dataset.sp = "open";
      open.dataset.i = String(i);
      acts.append(imp, open);
      li.append(meta, acts);
      ul.append(li);
    });
  }

  moveInQueue(id, dir) {
    const q = [...this.library.queue];
    const i = q.indexOf(id);
    const j = clamp(i + dir, 0, q.length - 1);
    if (i < 0) return;
    [q[i], q[j]] = [q[j], q[i]];
    this.library.setQueue(q).then(() => this.renderQueue());
  }

  renderQueue() {
    const ul = $("#queueList");
    ul.textContent = "";
    $("#queueCount").textContent = String(this.library.queue.length);
    if (!this.library.queue.length) {
      ul.append(el("li", "empty", "Nothing queued. Tap Next in the library to build a running order."));
      return;
    }
    this.library.queue.forEach((id, i) => {
      const t = this.library.byId(id);
      if (!t) return;
      const li = el("li", "track");
      li.dataset.id = id;
      const meta = el("div", "meta");
      meta.append(
        el("div", "name", `${i + 1}. ${t.name}`),
        el("div", "sub", `${fmtTime(t.duration)}${Number.isFinite(t.rmsDb) ? ` · ${t.rmsDb.toFixed(1)} dBFS RMS` : ""}`),
      );
      const btns = el("div", "btns");
      const mk = (label, cls, q) => { const b = el("button", `mini ${cls}`, label); b.type = "button"; b.dataset.q = q; return b; };
      btns.append(mk("↑", "", "up"), mk("↓", "", "down"), mk("A", "is-a", "A"), mk("B", "is-b", "B"), mk("×", "", "out"));
      li.append(meta, btns);
      ul.append(li);
    });
    const total = this.library.queue.reduce((a, id) => a + (this.library.byId(id)?.duration ?? 0), 0);
    ul.append(el("li", "fineprint", `Queued running time ${fmtTime(total)}.`));
  }

  setTab(tab) {
    this.tab = tab;
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
    $("#trackList").hidden = tab !== "library";
    $("#queueList").hidden = tab !== "queue";
    $("#takeList").hidden = tab !== "takes";
    $("#spList").hidden = tab !== "spotify";
    $("#spSearchRow").hidden = tab !== "spotify";
    if (tab === "spotify" && !this.spItems) this.renderSpotify();
    this.renderQueue();
    this.renderLists();
  }

  async importFiles(files) {
    if (!files.length) return;
    for (const f of files) {
      try {
        this.status(`Analysing ${f.name}…`, true);
        const rec = await this.library.addFile(f, (p) => {
          if (p.stage === "decode") this.status(`Reading ${f.name}…`, true);
          if (p.stage === "envelope") this.status(`Mapping ${f.name}…`, true);
        });
        this.status(`Added ${rec.name} · ${fmtTime(rec.duration)}${rec.liveOnly ? " · no peak map" : ""}`);
      } catch (e) {
        this.status(`${f.name}: ${e.message}`);
      }
    }
    $("#fileInput").value = "";
    this.renderLists();
  }

  renderLists() {
    const list = this.library.search($("#searchInput").value);
    $("#trackCount").textContent = String(this.library.tracks.length);
    const ul = $("#trackList");
    ul.textContent = "";
    if (!list.length) {
      ul.append(el("li", "empty", this.library.tracks.length ? "No matches." : "Add your music from Files. Nothing leaves this device."));
    }
    const loaded = new Set([this.decks.A.rec?.id, this.decks.B.rec?.id]);
    for (const t of list) {
      const li = el("li", "track");
      li.dataset.id = t.id;
      li.classList.toggle("is-loaded", loaded.has(t.id));
      const meta = el("div", "meta");
      const sub = `${fmtTime(t.duration)} · ${fmtBytes(t.size)}${Number.isFinite(t.rmsDb) ? ` · ${t.rmsDb.toFixed(1)} dB` : ""}${t.liveOnly ? " · timeline only" : ""}`;
      meta.append(el("div", "name", t.name), el("div", "sub", sub));
      const btns = el("div", "btns");
      const mk = (label, cls, fn) => { const b = el("button", `mini ${cls}`, label); b.type = "button"; b.addEventListener("click", fn); return b; };
      btns.append(
        mk("A", "is-a", () => this.loadInto("A", t)),
        mk("B", "is-b", () => this.loadInto("B", t)),
        mk("Next", this.library.queue.includes(t.id) ? "is-a" : "", async () => {
          await this.library.enqueue(t.id);
          this.setTab("queue");
        }),
        mk("×", "", async () => { await this.library.remove(t.id); this.renderLists(); this.renderQueue(); }),
      );
      li.append(meta, btns);
      ul.append(li);
    }

    const tl = $("#takeList");
    tl.textContent = "";
    if (!this.library.takes.length) tl.append(el("li", "empty", "No takes yet. Press Record, mix, then stop."));
    for (const t of this.library.takes) {
      const li = el("li", "track");
      const meta = el("div", "meta");
      meta.append(el("div", "name", t.name), el("div", "sub", `${fmtTime(t.duration)} · ${fmtBytes(t.size)} · ${extFor(t.mime)}${t.sync ? " · synced" : ""}`));
      const btns = el("div", "btns");
      const mk = (label, cls, fn) => { const b = el("button", `mini ${cls}`, label); b.type = "button"; b.addEventListener("click", fn); return b; };
      btns.append(
        mk("Save", "", () => this.download(t)),
        mk("Log", "", () => this.downloadText(this.log.toText({ title: t.name }), `${t.name}-running-order.txt`)),
        mk("Sync", t.sync ? "is-a" : "", () => this.syncTake(t)),
        mk("Play", "", () => this.playTake(t)),
        mk("×", "", async () => { await this.library.removeTake(t.id); this.renderLists(); }),
      );
      li.append(meta, btns);
      tl.append(li);
    }
  }

  async loadInto(id, track) {
    const deck = this.decks[id];
    // remember where the outgoing item stopped so a long piece can be picked up again
    if (deck.hasTrack) await this.library.update(deck.rec.id, { resumeAt: deck.position, cue: deck.cue, bpm: deck.baseBpm, beat1: deck.beat1 });
    try {
      await this.engine.enable();
      this.status(`Loading ${track.name}…`, true);
      await deck.load(track);
      if (this.saved.autoLevel && Number.isFinite(track.rmsDb)) deck.applyTrimFor(LEVEL_TARGET_DB, track.rmsDb);
      this.controls[`tempo-${id}`].set(0.5);
      this.syncDeck(id);
      this.log.add("load", `Deck ${id} ← ${track.name} (${fmtTime(track.duration)})`);
      this.status(`${track.name} → Deck ${id} · ${deck.isStream ? "streaming" : "buffered"}${track.resumeAt ? ` · resumed ${fmtTime(track.resumeAt)}` : ""}`);
      tick(8);
      this.renderLists();
    } catch (e) {
      this.status(`Could not load ${track.name}: ${e.message}`);
    }
  }

  async playTake(t) {
    try {
      await this.engine.enable();
      const buffer = await this.engine.decode(await t.blob.arrayBuffer());
      if (!this.preview) {
        this.preview = { src: null, gain: this.engine.ctx.createGain() };
        this.preview.gain.connect(this.engine.master);
      }
      if (this.preview.src) { try { this.preview.src.stop(); } catch { /* noop */ } }
      const src = this.engine.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.preview.gain);
      src.start();
      this.preview.src = src;
      this.status(`Playing ${t.name}`);
    } catch (e) {
      this.status(`Cannot preview this take: ${e.message}`);
    }
  }

  download(t) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(t.blob);
    a.download = `${t.name}.${extFor(t.mime)}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  downloadText(text, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------- recording ----------
  async toggleRecord() {
    if (this.recorder.isRecording) { this.recorder.stop(); return; }
    try {
      await this.recorder.start();
      this.log.markRecordingStart();
      this.log.add("record", "take started");
      $("#btnRecord").classList.add("is-active");
      $("#btnRecord").innerHTML = '<span class="rec-dot"></span>Stop';
      this.status("Recording master output.", true);
    } catch (e) {
      this.status(e.message);
    }
  }

  bindRecorder() {
    this.recorder.onStop = async (blob, err) => {
      $("#btnRecord").classList.remove("is-active");
      $("#btnRecord").textContent = "● Record";
      if (err) { this.status(err.message); return; }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const take = await this.library.addTake(blob, {
        duration: this.recorder.lastDuration,
        name: `Take ${stamp}`,
        log: this.log.entries.length,
      });
      this.log.markRecordingStop();
      this.log.add("record", `take saved · ${fmtBytes(take.size)}`);
      this.status(`Saved ${take.name} · ${fmtBytes(take.size)}`);
      this.lastTake = take;
      $("#btnExportTake").disabled = false;
      this.renderLists();
      tick(20);
    };
  }

  async syncTake(t) {
    const cfg = this.gh.cfg;
    if (!cfg?.token) { this.status("GitHub sync needs a token in Settings."); this.openSettings(); return; }
    const base = `${new Date(t.createdAt).toISOString().replace(/[:.]/g, "-")}`;
    try {
      this.status(`Uploading ${base}…`, true);
      const r = await gh.pushTake(cfg, `${base}.${extFor(t.mime)}`, t.blob);
      let logPath = null;
      try {
        const r2 = await gh.pushTake(cfg, `${base}-running-order.txt`, new Blob([this.log.toText({ title: t.name })], { type: "text/plain" }));
        logPath = r2.path;
      } catch (e) { this.status(`Audio synced, log skipped: ${e.message}`); }
      t.sync = { name: `${base}.${extFor(t.mime)}`, sha: r.sha, log: logPath, at: Date.now() };
      await idb.takes.put(t);
      this.status(`Synced to ${cfg.owner}/${cfg.repo}:${r.path}`);
      this.renderLists();
    } catch (e) {
      this.status(`Sync failed: ${e.message}`);
    }
  }

  // ---------- sheet ----------
  bindSheet() {
    $("#sheetClose").addEventListener("click", () => this.closeSheet());
    $("#sheetScrim").addEventListener("pointerdown", () => this.closeSheet());
  }

  openSheet(title, bodyNode) {
    $("#sheetBody").textContent = "";
    $("#sheetBody").append(el("h2", null, title), bodyNode);
    $("#sheet").hidden = false;
    $("#sheetScrim").hidden = false;
  }

  closeSheet() {
    $("#sheet").hidden = true;
    $("#sheetScrim").hidden = true;
  }

  // ---------- settings ----------
  async openSettings() {
    const d = $("#settingsDialog");
    const cfg = this.gh.cfg;
    $("#ghOwner").value = cfg.owner || "";
    $("#ghRepo").value = cfg.repo || "";
    $("#ghBranch").value = cfg.branch || "main";
    $("#ghPath").value = cfg.path || "takes";
    $("#ghToken").value = cfg.token || "";
    $("#autoLevel").checked = this.saved.autoLevel;
    $("#fineDrag").checked = this.saved.fineDrag;
    $("#spRedirect").textContent = sp.redirectUri();
    $("#spClientId").value = this.spCfg?.clientId || "";
    $("#spStatus").textContent = this.spCfg?.clientId
      ? (await sp.isAuthed() ? "Connected — previews available." : "Client ID set, not connected yet.")
      : "Not configured.";
    $("#spConnect").disabled = !this.spCfg?.clientId;
    $("#storageInfo").textContent = await this.storageInfo();
    d.showModal();
  }

  async storageInfo() {
    const e = await idb.estimate();
    if (!e.quota) return "Storage estimate unavailable in this browser.";
    return `${fmtBytes(e.usage)} of ${fmtBytes(e.quota)} used · ${e.persisted ? "protected from eviction" : "may be cleared if storage runs low"}`;
  }

  bindSettings() {
    const read = () => ({
      owner: $("#ghOwner").value.trim(),
      repo: $("#ghRepo").value.trim(),
      branch: $("#ghBranch").value.trim() || "main",
      path: $("#ghPath").value.trim() || "takes",
      token: $("#ghToken").value.trim(),
    });
    const note = (msg, ok) => { const n = $("#ghStatus"); n.textContent = msg; n.style.color = ok ? "var(--a)" : "var(--danger)"; };
    for (const id of ["ghOwner", "ghRepo", "ghBranch", "ghPath", "ghToken"]) {
      $(`#${id}`).addEventListener("change", async () => { this.gh.cfg = read(); await gh.saveConfig(read()); });
    }
    $("#autoLevel").addEventListener("change", (e) => { this.saved.autoLevel = e.target.checked; this.persist(); });
    $("#fineDrag").addEventListener("change", (e) => { this.saved.fineDrag = e.target.checked; this.persist(); });
    const spNote = (msg, ok) => { const n = $("#spStatus"); n.textContent = msg; n.style.color = ok ? "var(--a)" : "var(--danger)"; };
    $("#spClientId").addEventListener("change", async () => {
      this.spCfg = { ...this.spCfg, clientId: $("#spClientId").value.trim(), enabled: true };
      await sp.saveConfig(this.spCfg);
      $("#spConnect").disabled = !this.spCfg.clientId;
      spNote("Client ID saved. Add the redirect URI above in your Spotify app, then Connect.", true);
    });
    $("#spConnect").addEventListener("click", async () => {
      try {
        this.spCfg = { ...this.spCfg, clientId: $("#spClientId").value.trim(), enabled: true };
        await sp.saveConfig(this.spCfg);
        spNote("Opening Spotify sign-in…", true);
        await sp.beginLogin();
      } catch (e) { spNote(e.message, false); }
    });
    $("#spForget").addEventListener("click", async () => {
      await sp.clearAuth();
      this.spCfg = { ...this.spCfg, clientId: "", enabled: false };
      await sp.saveConfig(this.spCfg);
      $("#spClientId").value = "";
      $("#spConnect").disabled = true;
      spNote("Spotify credentials cleared.", true);
    });
    $("#btnPersist").addEventListener("click", async () => {
      const ok = await idb.requestPersist();
      $("#storageInfo").textContent = await this.storageInfo() + (ok ? "" : " · request refused");
    });
    $("#btnGhTest").addEventListener("click", async () => {
      try { note(`OK · ${await gh.test(read())}`, true); } catch (e) { note(e.message, false); }
    });
    $("#btnGhPull").addEventListener("click", async () => {
      try {
        const files = await gh.listTakes(read());
        note(`${files.length} file(s) in ${read().path}. Pull one into Takes.`, true);
        const ul = $("#takeList");
        for (const f of files) {
          const li = el("li", "track");
          const meta = el("div", "meta");
          meta.append(el("div", "name", f.name), el("div", "sub", `${fmtBytes(f.size)} · in repo`));
          const btns = el("div", "btns");
          const b = el("button", "mini", "Pull");
          b.addEventListener("click", async () => {
            try {
              const blob = await gh.fetchTake(read(), f);
              await this.library.addTake(blob, { name: f.name.replace(/\.[^.]+$/, ""), duration: 0 });
              this.renderLists();
              note(`Pulled ${f.name}`, true);
            } catch (e) { note(e.message, false); }
          });
          btns.append(b);
          li.append(meta, btns);
          ul.append(li);
        }
      } catch (e) { note(e.message, false); }
    });
    $("#btnGhClear").addEventListener("click", async () => {
      await gh.clearConfig();
      this.gh.cfg = await gh.loadConfig();
      $("#ghToken").value = "";
      note("Token forgotten.", true);
    });
    $("#btnExportTake").addEventListener("click", () => { if (this.lastTake) this.download(this.lastTake); });
  }

  // ---------- render loop ----------
  loop() {
    let lastRec = 0;
    const lastText = {};
    const frame = () => {
      for (const id of ["A", "B"]) {
        const deck = this.decks[id];
        deck.tick();
        this.waves[id].main.draw();
        this.waves[id].over.draw();
        const t = `${fmtTime(deck.position)} / ${fmtTime(deck.duration)}`;
        if (lastText[id] !== t) {
          lastText[id] = t;
          this.controls[`deck-${id}`].cur.textContent = fmtTime(deck.position);
          this.controls[`deck-${id}`].dur.textContent = fmtTime(deck.duration);
          this.syncRemaining(id);
        }
      }
      const m = this.engine.masterLevel();
      this.meters.master.draw(m.l, m.r);
      for (const id of ["A", "B"]) this.meters[id].draw(this.engine.channelLevel(id));
      if (this.recorder.isRecording && Date.now() - lastRec > 500) {
        lastRec = Date.now();
        $("#btnRecord").innerHTML = `<span class="rec-dot"></span>${fmtTime(this.recorder.elapsed)}`;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  syncRemaining(id) {
    const deck = this.decks[id];
    const p = this.controls[`deck-${id}`];
    p.remaining.textContent = deck.hasTrack
      ? (deck.playing ? (Number.isFinite(deck.remaining) ? `ends ${fmtTime(deck.remaining)}` : "looped") : `ready ${fmtTime(deck.duration - deck.position)}`)
      : "";
  }
}
