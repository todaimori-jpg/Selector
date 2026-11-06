import { el } from "../lib/dom.js";

export function waveBlock(label, colorClass) {
  const wrap = el("div", `wave-wrap ${colorClass}`);
  const main = el("canvas", "wave-main");
  main.setAttribute("aria-label", `Deck ${label} waveform, drag to adjust beat grid`);
  const over = el("canvas", "wave-over");
  over.setAttribute("aria-label", `Deck ${label} overview, drag to scrub`);
  const stack = el("div");
  stack.append(main, over);
  wrap.append(stack);
  return { node: wrap, main, over };
}

export function deckPanel(id, label) {
  const colorClass = `is-${label.toLowerCase()}`;
  const root = el("div", `deck ${colorClass}`);

  const title = el("span", "deck-title", "Nothing loaded");
  const mode = el("span", "badge", "");
  const time = el("span", "deck-time");
  time.innerHTML = `<span class="cur">00:00</span> / <span class="dur">00:00</span>`;
  const remaining = el("span", "remaining", "");
  const head = el("div", "deck-head");


  const btn = (role, text, cls = "") => {
    const b = el("button", `tbtn ${cls}`, text);
    b.type = "button";
    b.dataset.role = role;
    return b;
  };

  const transport = el("div", "transport");
  const play = btn("play", "▶");
  play.setAttribute("aria-label", `Play deck ${label}`);
  const stop = btn("stop", "Stop");
  const cueGo = btn("cue", "CUE");
  const cup = btn("cup", "CUP");
  const sync = btn("sync", "SYNC");
  const leader = btn("leader", "MASTER");
  leader.setAttribute("aria-pressed", "false");
  const levelBtn = btn("level", "Level");
  levelBtn.title = "Trim this deck toward -18 dBFS RMS so quiet field recordings sit at the same loudness.";
  const fadeIn = btn("fadein", "Fade in");
  const fadeOut = btn("fadeout", "Fade out");
  const loop = el("select", "loop-select");
  loop.setAttribute("aria-label", `Deck ${label} loop length`);
  for (const beats of [0, 0.25, 0.5, 1, 2, 4, 8, 16, 32]) {
    const option = el("option", "", beats ? String(beats) : "Loop");
    option.value = String(beats);
    loop.append(option);
  }
  transport.append(play, cueGo, cup, stop, fadeIn, fadeOut, loop);

  const bpmOut = el("span", "bpm-out", "— BPM");
  const pctOut = el("span", "pct", "0.0%");
  const tempoTrack = el("div", `fader ${colorClass} is-bipolar`);
  const fill = el("div", "fader-fill");
  tempoTrack.append(el("div", "fader-track"), el("div", "fader-center"), fill, el("div", "fader-knob"));
  tempoTrack.classList.add("vertical");
  tempoTrack.setAttribute("aria-label", `Deck ${label} tempo`);
  head.append(title, remaining, bpmOut, el("span", "tag", label));
  const tempoRow = el("div", "tempo-row");
  tempoRow.append(tempoTrack, pctOut);

  const gridBtn = btn("grid", "Grid");
  gridBtn.title = "Beat grid, cue points and tempo range";
  const tools = el("div", "deck-tools");
  tools.append(sync, leader, gridBtn, levelBtn, mode, time);
  const display = el("div", "deck-display");
  const waveform = el("div", "deck-wave");
  display.append(waveform, tempoRow);
  root.append(head, tools, display, transport);
  return { node: root, title, mode, time, cur: time.querySelector(".cur"), dur: time.querySelector(".dur"),
    remaining, bpmOut, pctOut, play, stop, cueGo, cup, sync, leader, loop, levelBtn, fadeIn, fadeOut, gridBtn, tempoTrack, waveform, colorClass };
}

const EQ = [
  { key: "gain", label: "GAIN", home: 0.5 },
  { key: "hi", label: "HIGH", home: 0.5 },
  { key: "mid", label: "MID", home: 0.5 },
  { key: "lo", label: "LOW", home: 0.5 },
];
const FILTERS = [
  { key: "hpf", label: "HPF", home: 0 },
  { key: "lpf", label: "LPF", home: 1 },
];

export function channelStrip(id, label) {
  const colorClass = `is-${label.toLowerCase()}`;
  const root = el("div", `channel ${colorClass}`);
  const name = el("span", "name", "No track loaded");
  const meter = el("canvas", "meter");
  meter.setAttribute("aria-label", "Channel level");
  const head = el("div", "channel-head");
  head.append(el("span", "tag", label), name);

  const cells = {};
  const mkCell = (spec) => {
    const cell = el("div", "knob-cell");
    const knob = el("div", `knob ${colorClass}`);
    knob.append(el("div", "knob-dial"));
    knob.setAttribute("aria-label", `Channel ${label} ${spec.label}`);
    if (spec.home === 0.5) knob.classList.add("is-center");
    const out = el("div", "val", "0.0 dB");
    cell.append(el("div", "lbl", spec.label), knob, out);
    cells[spec.key] = { knob, out };
    return cell;
  };

  const eqGrid = el("div", "knob-grid");
  EQ.forEach((s) => eqGrid.append(mkCell(s)));
  const fltGrid = el("div", "knob-grid two");
  FILTERS.forEach((s) => fltGrid.append(mkCell(s)));

  const chCell = el("div", "knob-cell");
  const chKnob = el("div", `fader vertical ${colorClass}`);
  chKnob.append(el("div", "fader-track"), el("div", "fader-fill"), el("div", "fader-knob"));
  chKnob.setAttribute("aria-label", `Channel ${label} level`);
  const chOut = el("div", "val", "65%");
  chCell.classList.add("level-cell");
  chCell.append(chKnob, meter, chOut);
  cells.fader = { knob: chKnob, out: chOut };

  const cue = el("button", "cue-btn", "♬");
  cue.setAttribute("aria-label", `Deck ${label} headphone cue`);
  const sends = el("div", "fx-sends");
  const fx = [1, 2].map((slot) => {
    const b = el("button", "tbtn", String(slot));
    b.type = "button";
    b.setAttribute("aria-label", `Deck ${label} FX ${slot} send`);
    b.setAttribute("aria-pressed", "false");
    sends.append(b);
    return b;
  });
  cue.type = "button";

  const foot = el("div", "channel-foot");
  foot.append(chCell, cue);

  root.append(head, eqGrid, fltGrid, sends, foot);
  return { node: root, name, meter, cells, cue, fx };
}

export function masterPanel() {
  const root = el("div", "master");
  const vu = el("canvas", "vu");
  vu.setAttribute("aria-label", "Stereo master VU");
  const cueMaster = el("button", "chip", "Monitor");
  cueMaster.type = "button";
  const audition = el("button", "chip", "Audition");
  audition.type = "button";
  const fx = el("button", "chip", "More");
  fx.type = "button";
  const btns = el("div", "master-btns");
  btns.append(cueMaster, audition, fx);

  const mKnob = el("div", "knob is-center");
  mKnob.append(el("div", "knob-dial"));
  mKnob.setAttribute("aria-label", "Master level");
  const mOut = el("div", "val", "80%");
  const mCell = el("div", "knob-cell");
  mCell.append(el("div", "lbl", "MASTER"), mKnob, mOut);

  const row = el("div", "master-row");
  row.append(btns, mCell);

  root.append(vu, row);
  return { node: root, vu, cueMaster, audition, fx, masterKnob: mKnob, masterOut: mOut };
}
