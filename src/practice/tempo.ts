// The song's beat, from when its notes are played: how many beats a minute,
// and where the beats fall (so the click lands with the notes).

export interface Beat {
  bpm: number;
  /** A moment (seconds) that is on a beat. */
  phase: number;
}

/**
 * Tempo from note times: the gap that best explains when the notes come
 * (an onset train compared with itself shifted), between 60 and 180 BPM.
 */
export function estimateBeat(times: number[]): Beat | null {
  const ts = [...new Set(times.map((t) => Math.round(t * 100) / 100))].sort((a, b) => a - b);
  if (ts.length < 8) return null;
  const RES = 0.01;
  const t0 = ts[0];
  const n = Math.ceil((ts[ts.length - 1] - t0) / RES) + 1;
  const train = new Float32Array(n);
  for (const t of ts) {
    const i = Math.round((t - t0) / RES);
    // a little width: notes aren't timed to the millisecond
    for (let d = -2; d <= 2; d++) if (i + d >= 0 && i + d < n) train[i + d] = Math.max(train[i + d], 1 - Math.abs(d) * 0.3);
  }
  const score = (period: number) => {
    // how often a note has another one beat(s) later, at 1, 2 and 4 beats
    let s = 0;
    for (const k of [1, 2, 4]) {
      const lag = Math.round((period * k) / RES);
      if (lag >= n) continue;
      let c = 0;
      for (let i = 0; i + lag < n; i++) c += train[i] * train[i + lag];
      s += c / k ** 0.3;
    }
    return s;
  };
  let best = 0;
  let bestScore = -1;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const sc = score(60 / bpm);
    if (sc > bestScore) {
      bestScore = sc;
      best = bpm;
    }
  }
  if (bestScore <= 0) return null;
  return { bpm: best, phase: bestPhase(ts, 60 / best) };
}

/** Where the beats should fall so that most notes land on one. */
export function bestPhase(times: number[], period: number): number {
  let best = times[0] ?? 0;
  let bestHits = -1;
  for (const cand of times.slice(0, 40)) {
    let hits = 0;
    for (const t of times) {
      const k = (t - cand) / period;
      const off = Math.abs(k - Math.round(k)) * period;
      if (off < 0.05) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = cand;
    }
  }
  return best;
}

/** The beats (seconds) from `from` to `to`. */
export function beatsBetween(b: Beat, from: number, to: number): number[] {
  const period = 60 / b.bpm;
  const out: number[] = [];
  let k = Math.ceil((from - b.phase) / period - 1e-9);
  for (let t = b.phase + k * period; t <= to + 1e-9; k++, t = b.phase + k * period) out.push(Math.round(t * 1000) / 1000);
  return out;
}

/** Tap tempo: the beat from your last few taps (ms timestamps). */
export function tapBpm(taps: number[]): number | null {
  const recent = taps.slice(-6);
  if (recent.length < 3) return null;
  const gaps = recent.slice(1).map((t, i) => t - recent[i]).filter((g) => g > 250 && g < 2000);
  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps[gaps.length >> 1];
  return Math.round(60000 / mid);
}
