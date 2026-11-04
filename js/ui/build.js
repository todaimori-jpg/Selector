import { el } from "../lib/dom.js";

export function waveBlock(label, colorClass) {
  const wrap = el("div", `wave-wrap ${colorClass}`);
  const tag = el("span", "tag", label);
  tag.style.color = label === "A" ? "var(--a)" : "var(--b)";
  const main = el("canvas", "wave-main");
  main.setAttribute("aria-label", `Deck ${label} waveform, drag to adjust beat grid`);
  const over = el("canvas", "wave-over");
  over.setAttribute("aria-label", `Deck ${label} overview, drag to scrub`);
  const stack = el("div");
  stack.append(main, over);
  wrap.append(tag, stack);
  return { node: wrap, main, over };
}

export function deckPanel(id, label) {
  const colorClass = label === "A" ? "is-a" : "is-b";
  const root = el("div", `deck ${colorClass}`);

  const title = el("span", "deck-title", "Nothing loaded");
  const mode = el("span", "badge", "");
  const time = el("span", "deck-time");
  time.innerHTML = `<span class="cur">00:00</span> / <span class="dur">00:00</span>`;
  const remaining = el("span", "remaining", "");
  const head = el("div", "deck-head");
  head.append(el("span", "tag", label), title, mode, time, remaining);

  const btn = (role, text, cls = "") => {
    const b = el("button", `tbtn ${cls}`, text);
    b.type = "button";
    b.dataset.role = role;
    return b;
  };

  const transport = el("div", "transport");
  const play = btn("play", "Play");
  const stop = btn("stop", "Stop");
  const cueGo = btn("cue", "Go cue");
  const levelBtn = btn("level", "Level");
  levelBtn.title = "Trim this deck toward -18 dBFS RMS so quiet field recordings sit at the same loudness.";
  const fadeIn = btn("fadein", "Fade in");
  const fadeOut = btn("fadeout", "Fade out");
  transport.append(play, stop, cueGo, levelBtn, fadeIn, fadeOut);

  const bpmOut = el("span", "bpm-out", "— BPM");
  const pctOut = el("span", "pct", "0.0%");
  const tempoTrack = el("div", `fader ${colorClass} is-bipolar`);
  const fill = el("div", "fader-fill");
  tempoTrack.append(el("div", "fader-track"), el("div", "fader-center"), fill, el("div", "fader-knob"));
  const tempoRow = el("div", "tempo-row");
  tempoRow.append(bpmOut, tempoTrack, pctOut);

  const gridBtn = btn("grid", "Beat grid / cues / loop / tempo law", "tbtn-wide");
  const footer = el("div", "transport");
  footer.append(gridBtn);

  root.append(head, transport, tempoRow, footer);
  return { node: root, title, mode, time, cur: time.querySelector(".cur"), dur: time.querySelector(".dur"),
    remaining, bpmOut, pctOut, play, stop, cueGo, levelBtn, fadeIn, fadeOut, gridBtn, tempoTrack, fill, colorClass };
}

const EQ = [
  { key: "hi", label: "HIGH", home: 0.5 },
  { key: "mid", label: "MID", home: 0.5 },
  { key: "lo", label: "LOW", home: 0.5 },
];
const FILTERS = [
  { key: "hpf", label: "HPF", home: 0 },
  { key: "lpf", label: "LPF", home: 1 },
];

export function channelStrip(id, label) {
  const colorClass = label === "A" ? "is-a" : "is-b";
  const root = el("div", `channel ${colorClass}`);
  const name = el("span", "name", "No track loaded");
  const meter = el("canvas", "meter");
  meter.setAttribute("aria-label", "Channel level");
  const head = el("div", "channel-head");
  const tag = el("span", "tag", label);
  tag.style.color = label === "A" ? "var(--a)" : "var(--b)";
  head.append(tag, name, meter);

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
  const chKnob = el("div", `knob ${colorClass}`);
  chKnob.append(el("div", "knob-dial"));
  chKnob.setAttribute("aria-label", `Channel ${label} level`);
  const chOut = el("div", "val", "65%");
  chCell.append(el("div", "lbl", "CHANNEL"), chKnob, chOut);
  cells.fader = { knob: chKnob, out: chOut };

  const cue = el("button", "cue-btn", "CUE");
  cue.type = "button";

  const foot = el("div", "channel-foot");
  foot.append(chCell, cue);

  root.append(head, eqGrid, fltGrid, foot);
  return { node: root, name, meter, cells, cue };
}

export function masterPanel() {
  const root = el("div", "master");
  const vu = el("canvas", "vu");
  vu.setAttribute("aria-label", "Stereo master VU");
  const cueMaster = el("button", "chip", "Cue master");
  cueMaster.type = "button";
  const audition = el("button", "chip", "Audition");
  audition.type = "button";
  const fx = el("button", "chip", "FX / More");
  fx.type = "button";
  const head = el("div", "master-head");
  head.innerHTML = `<h2>MASTER</h2><span class="cal">0 VU = -18 dBFS</span>`;
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
  const note = el("p", "fineprint", "All audio stays on this device. Nothing is uploaded unless you turn on GitHub sync in Settings.");

  root.append(head, vu, row, note);
  return { node: root, vu, cueMaster, audition, fx, masterKnob: mKnob, masterOut: mOut };
}
