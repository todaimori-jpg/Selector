import { idb } from "./idb.js";
import { analyse } from "../audio/peaks.js";
import { safeName } from "./dom.js";

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const QUEUE_KEY = "queue";

/**
 * Tracks store the original file Blob plus a low-rate peak envelope. Nothing here
 * ever holds full-resolution PCM, which is what lets a 40-minute field recording
 * sit in the library alongside three-hour sets without exhausting Safari's memory.
 */
export class Library {
  constructor(engine) {
    this.engine = engine;
    this.tracks = [];
    this.takes = [];
    this.queue = [];
  }

  async init() {
    const [tracks, takes, q] = await Promise.all([idb.tracks.all(), idb.takes.all(), idb.kv.get(QUEUE_KEY)]);
    this.tracks = tracks.sort((a, b) => b.addedAt - a.addedAt);
    this.takes = takes.sort((a, b) => b.createdAt - a.createdAt);
    const known = new Set(this.tracks.map((t) => t.id));
    this.queue = (q || []).filter((id) => known.has(id));
    return this;
  }

  async addFile(file, onProgress = () => {}) {
    onProgress({ stage: "read" });
    const rec = {
      id: uid(),
      name: safeName(file.name.replace(/\.[^.]+$/, "")),
      mime: file.type || "audio/*",
      size: file.size,
      addedAt: Date.now(),
      bpm: 120,
      beat1: 0,
      cue: 0,
      resumeAt: 0,
      blob: file,
    };
    const a = await analyse(file, { onProgress });
    rec.duration = a.duration;
    rec.peaks = a.peaks;
    rec.peakDb = a.peakDb;
    rec.rmsDb = a.rmsDb;
    rec.liveOnly = !!a.liveOnly;
    await idb.tracks.put(rec);
    this.tracks.unshift(rec);
    return rec;
  }

  async update(id, patch) {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    await idb.tracks.put(t);
  }

  async remove(id) {
    await idb.tracks.del(id);
    this.tracks = this.tracks.filter((t) => t.id !== id);
    await this.setQueue(this.queue.filter((x) => x !== id));
  }

  search(q) {
    const needle = (q || "").trim().toLowerCase();
    if (!needle) return this.tracks;
    return this.tracks.filter((t) => t.name.toLowerCase().includes(needle));
  }

  byId(id) { return this.tracks.find((t) => t.id === id) || null; }

  async setQueue(ids) {
    this.queue = [...ids];
    await idb.kv.set(QUEUE_KEY, this.queue);
  }

  async enqueue(id) { if (!this.queue.includes(id)) await this.setQueue([...this.queue, id]); }

  async dequeue(id) { await this.setQueue(this.queue.filter((x) => x !== id)); }

  /** The next queued item, optionally excluding what is already loaded. */
  nextUp(exclude = []) {
    for (const id of this.queue) {
      if (exclude.includes(id)) continue;
      const t = this.byId(id);
      if (t) return t;
    }
    return null;
  }

  async addTake(blob, { duration, name, log } = {}) {
    const rec = {
      id: uid(),
      name: safeName(name || `Take ${new Date().toLocaleString()}`),
      mime: blob.type || "audio/mp4",
      size: blob.size,
      duration,
      createdAt: Date.now(),
      blob,
      log: log || null,
      sync: null,
    };
    await idb.takes.put(rec);
    this.takes.unshift(rec);
    return rec;
  }

  async removeTake(id) {
    await idb.takes.del(id);
    this.takes = this.takes.filter((t) => t.id !== id);
  }
}
