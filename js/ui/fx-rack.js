import { el } from "../lib/dom.js";
import { attachKnob } from "./touch.js";

export function makeFxRack(engine, slot, label) {
  const rack = el("section", `fx-rack fx-${slot + 1}`);
  rack.setAttribute("aria-label", `Effects rack ${slot + 1}`);
  const name = el("strong", "fx-name", `FX ${slot + 1}  /  ${label}`);
  const power = el("button", "tbtn fx-power", "OFF");
  power.type = "button";
  power.setAttribute("aria-label", `${label} enable`);
  power.setAttribute("aria-pressed", "false");
  power.addEventListener("click", () => {
    const enabled = power.getAttribute("aria-pressed") !== "true";
    engine.setFxEnabled(slot, enabled);
    power.setAttribute("aria-pressed", String(enabled));
    power.textContent = enabled ? "ON" : "OFF";
  });

  const makeControl = (caption, value, onChange) => {
    const cell = el("div", "knob-cell");
    const knob = el("div", "knob");
    knob.setAttribute("aria-label", `${label} ${caption}`);
    knob.append(el("div", "knob-dial"));
    cell.append(knob, el("span", "lbl", caption));
    attachKnob(knob, { value, onChange, onDouble: () => value });
    return cell;
  };

  const wet = makeControl("WET", 0.3, (value) => engine.setFxWet(slot, value));
  const time = slot === 0 ? makeControl("TIME", 0.4, (value) => engine.setDelayTime(value)) : null;
  const feedback = slot === 0 ? makeControl("FDBK", 0.3, (value) => engine.setDelayFeedback(value)) : null;
  rack.append(name, wet);
  if (time) rack.append(time, feedback);
  rack.append(power);
  return rack;
}
