/**
 * Waveform peaks are extracted from a deliberately terrible-sounding copy of the
 * file: mono at 8 kHz. Peak envelopes need no high frequency content, and this cuts
 * the memory of analysing a 35-minute field recording by roughly 12x versus
 * decoding it at full rate. Playback never touches this buffer.
 */
export const PEAK_RATE = 300; // buckets per second of audio
const ANALYSE_HZ = 8000;      // lowest rate OfflineAudioContext accepts
const ANALYSE_MAX_SECONDS = 90 * 60;

export async function probeDuration(blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((res) => {
      const a = new window.Audio();
      a.preload = "metadata";
      const done = (v) => { res(Number.isFinite(v) ? v : 0); };
      a.onloadedmetadata = () => done(a.duration);
      a.onerror = () => done(0);
      setTimeout(() => done(a.duration), 5000);
      a.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function analyse(blob, { durationHint = 0, onProgress = () => {} } = {}) {
  const duration = durationHint || await probeDuration(blob);
  if (duration > ANALYSE_MAX_SECONDS) {
    // 90+ minutes is not worth holding in memory for a picture; the UI falls back
    // to a live strip built from the master analyser while it plays.
    return { duration, peaks: null, liveOnly: true };
  }

  onProgress({ stage: "decode" });
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil((duration || 1) * ANALYSE_HZ)), ANALYSE_HZ);
  const ab = await blob.arrayBuffer();
  let buf;
  try {
    buf = await ctx.decodeAudioData(ab.slice(0));
  } catch {
    throw new Error("Cannot decode this file. DRM-protected tracks will not load.");
  }
  const realDur = buf.duration;
  const count = Math.max(1, Math.floor(realDur * PEAK_RATE));
  const peaks = new Float32Array(count * 2);
  const perBucket = Math.max(1, Math.floor(ANALYSE_HZ / PEAK_RATE));

  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));

  let sumSq = 0, n = 0, absPeak = 0;
  onProgress({ stage: "envelope" });
  for (let b = 0; b < count; b++) {
    const s = b * perBucket;
    const e = Math.min(s + perBucket, buf.length);
    let lo = 1, hi = -1;
    for (let c = 0; c < chans.length; c++) {
      const d = chans[c];
      for (let i = s; i < e; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        const a = v < 0 ? -v : v;
        if (a > absPeak) absPeak = a;
        sumSq += v * v; n++;
      }
    }
    peaks[b * 2] = lo === 1 ? 0 : lo;
    peaks[b * 2 + 1] = hi === -1 ? 0 : hi;
  }
  // release the decoded copy before doing anything else
  for (let c = 0; c < chans.length; c++) chans[c] = null;

  const rms = n ? Math.sqrt(sumSq / n) : 0;
  const toDb = (v) => (v <= 0.000126 ? -80 : 20 * Math.log10(v));
  onProgress({ stage: "done" });
  return {
    duration: realDur,
    peaks: { data: peaks, count, rate: PEAK_RATE },
    peakDb: toDb(absPeak),
    rmsDb: toDb(rms),
    liveOnly: false,
  };
}

/**
 * When peaks are null the waveform layer draws a bare timeline with cue and loop
 * markers instead of pretending to have envelope data it never read.
 */
export const hasPeaks = (track) => !!track?.peaks;

