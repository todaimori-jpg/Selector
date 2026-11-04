/**
 * Records the master bus. Nothing touches the microphone, so there is no
 * permission prompt: the source is a MediaStreamAudioDestinationNode.
 */
const CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2", // iOS / Safari
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

export const extFor = (mime) =>
  mime.includes("mp4") ? "m4a" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : "audio";

export class Recorder {
  constructor(engine) {
    this.engine = engine;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mime = "audio/mp4";
    this.onStop = null;
  }

  get isRecording() { return !!this.rec && this.rec.state === "recording"; }

  get elapsed() { return this.isRecording ? (Date.now() - this.startedAt) / 1000 : 0; }

  async start() {
    if (this.isRecording) return false;
    if (typeof MediaRecorder === "undefined") throw new Error("This browser cannot record audio.");
    if (!this.engine.ctx) await this.engine.enable();
    const mime = pickMimeType();
    if (mime === null) throw new Error("MediaRecorder is unavailable here.");
    this.mime = mime || "audio/mp4";
    this.chunks = [];
    // 1s slices survive a backgrounded tab better than one giant final blob
    this.rec = new MediaRecorder(this.engine.recTap.stream, {
      mimeType: mime || undefined,
      audioBitsPerSecond: 128000,
    });
    this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.rec.onerror = (e) => { this.onStop?.(null, e.error || new Error("Recorder failed")); };
    this.rec.start(1000);
    this.startedAt = Date.now();
    return true;
  }

  stop() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mime });
      this.chunks = [];
      const duration = (Date.now() - this.startedAt) / 1000;
      this.lastDuration = duration;
      this.onStop?.(blob.size ? blob : null, blob.size ? null : new Error("Recording produced no data"));
    };
    try { rec.stop(); } catch { rec.onstop?.(); }
  }
}
