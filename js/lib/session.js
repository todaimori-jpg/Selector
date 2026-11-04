import { idb } from "./idb.js";

const KEY = "session-log";

/**
 * Running order for a show. Radio mixes need track IDs for the archive and for
 * anyone who asks "what was that at 41 minutes", so every load, mix and manual
 * marker is timestamped against the recording clock rather than wall time.
 */
export class SessionLog {
  constructor() {
    this.startedAt = Date.now();
    this.entries = [];
    this.recordingBase = null;
  }

  async init() {
    const saved = await idb.kv.get(KEY);
    if (saved) Object.assign(this, saved);
    return this;
  }

  async save() { await idb.kv.set(KEY, { startedAt: this.startedAt, entries: this.entries.slice(-400) }); }

  reset() { this.entries = []; this.startedAt = Date.now(); this.recordingBase = null; return this.save(); }

  /** `at` is seconds into the take when recording, otherwise wall-clock since boot. */
  add(kind, text, extra = {}) {
    const now = Date.now();
    const at = this.recordingBase !== null ? (now - this.recordingBase) / 1000 : (now - this.startedAt) / 1000;
    this.entries.push({ at, wall: now, kind, text, ...extra });
    this.save();
    return this.entries[this.entries.length - 1];
  }

  markRecordingStart() { this.recordingBase = Date.now(); }
  markRecordingStop() { this.recordingBase = null; }

  toText({ title = "Selector session" } = {}) {
    const stamp = new Date(this.startedAt).toLocaleString();
    const rows = this.entries.map((e) => {
      const m = String(Math.floor(e.at / 60)).padStart(2, "0");
      const s = String(Math.floor(e.at % 60)).padStart(2, "0");
      const tag = e.kind === "marker" ? "MARK " : `${String(e.kind).toUpperCase().padEnd(6)}`;
      return `${m}:${s}  ${tag}${e.text}`;
    });
    const tracks = this.entries
      .filter((e) => e.kind === "load")
      .map((e) => `${e.text}`);
    return [
      `${title}`,
      `Started ${stamp}`,
      `${this.entries.length} events`,
      "",
      "--- Running order ---",
      ...tracks,
      "",
      "--- Log ---",
      ...rows,
      "",
    ].join("\n");
  }
}
