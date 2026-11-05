// Lining the notes up with the sound: when each note is really plucked.
//
// The tab's moving cursor gives each note a time, but tab videos' cursors
// run a little early or late (sometimes most of a second), and the reading
// can be off by a frame or two. The video's sound says exactly when a
// string is plucked: a sudden rise in energy (an "onset"). So: find the
// onsets, slide the cursor times until they line up best with them, then
// move each note onto the pluck right next to it.

import { fft } from "../tuner/pitch";

/** Onset strength, FPS values a second. */
export const FPS = 100;

/**
 * How strongly something starts at each moment: the rise in the spectrum
 * (log magnitude, 70 Hz–4 kHz) from one 10 ms step to the next.
 */
export function onsetEnvelope(pcm: Float32Array, rate: number): Float32Array {
  const hop = Math.round(rate / FPS);
  const n = 512;
  const frames = Math.max(0, Math.floor((pcm.length - n) / hop) + 1);
  const out = new Float32Array(frames);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const lo = Math.max(1, Math.floor((70 * n) / rate));
  const hi = Math.min(n / 2, Math.ceil((4000 * n) / rate));
  let prev = new Float64Array(hi);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const at = f * hop;
    for (let i = 0; i < n; i++) {
      re[i] = pcm[at + i] * win[i];
      im[i] = 0;
    }
    fft(re, im, false);
    const cur = new Float64Array(hi);
    let flux = 0;
    for (let k = lo; k < hi; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
    }
    out[f] = f === 0 ? 0 : flux;
    prev = cur;
  }
  // Take away the slowly changing level (a strum ringing, the room) so
  // only sudden starts stand out.
  const base = movingMean(out, 50);
  for (let i = 0; i < frames; i++) out[i] = Math.max(0, out[i] - base[i]);
  return out;
}

function movingMean(a: Float32Array, half: number): Float32Array {
  const out = new Float32Array(a.length);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < a.length; i++) {
    const want0 = Math.max(0, i - half);
    const want1 = Math.min(a.length - 1, i + half);
    while (hi < want1) sum += a[++hi];
    while (lo < want0) sum -= a[lo++];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

/** Plucks: moments where the onset strength peaks clearly. */
export function onsetPeaks(env: Float32Array): { t: number; s: number }[] {
  const out: { t: number; s: number }[] = [];
  const level = movingMean(env, 100);
  for (let i = 2; i < env.length - 2; i++) {
    const v = env[i];
    if (v <= 0 || v < env[i - 1] || v < env[i + 1] || v < env[i - 2] || v < env[i + 2]) continue;
    if (v < level[i] * 1.5) continue;
    const last = out[out.length - 1];
    // two peaks within 40 ms are one pluck: keep the stronger
    if (last && i / FPS - last.t < 0.04) {
      if (v > last.s) out[out.length - 1] = { t: i / FPS, s: v };
      continue;
    }
    out.push({ t: i / FPS, s: v });
  }
  return out;
}

// --- Which notes sound when: lining up by pitch -----------------------------------------

/** Open strings in standard tuning (MIDI), 1 = high e … 6 = low E. */
const OPEN = [0, 64, 59, 55, 50, 45, 40];

/** Pitch class (0–11, C = 0) of a string and fret, with a capo. */
export function pitchClass(string: number, fret: number, capo = 0): number {
  return (OPEN[string] + fret + capo) % 12;
}

/** How much each pitch class newly starts sounding, 100 times a second. */
export interface PitchStarts {
  frames: number;
  /** frames × 12 */
  rise: Float32Array;
}

/**
 * For each moment, how much each of the 12 notes (C, C#, … B, any octave)
 * starts sounding: the energy at that note's pitch and its overtones, now
 * compared with a tenth of a second before.
 */
export function pitchStarts(pcm: Float32Array, rate: number): PitchStarts {
  const hop = Math.round(rate / FPS);
  const n = 2048;
  const frames = Math.max(0, Math.floor((pcm.length - n) / hop) + 1);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const binHz = rate / n;
  // which bins belong to which pitch class (fundamental + 2 overtones, E2..C7)
  const weight = new Float32Array((n / 2) * 12);
  for (let m = 40; m <= 96; m++) {
    const f = 440 * 2 ** ((m - 69) / 12);
    for (let h = 1; h <= 3; h++) {
      const bin = Math.round((f * h) / binHz);
      if (bin <= 1 || bin >= n / 2) continue;
      weight[bin * 12 + (m % 12)] += 1 / h;
    }
  }
  const chroma = new Float32Array(frames * 12);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const at = f * hop;
    for (let i = 0; i < n; i++) {
      re[i] = pcm[at + i] * win[i];
      im[i] = 0;
    }
    fft(re, im, false);
    for (let k = 2; k < n / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag === 0) continue;
      for (let pc = 0; pc < 12; pc++) {
        const w = weight[k * 12 + pc];
        if (w) chroma[f * 12 + pc] += w * mag;
      }
    }
    for (let pc = 0; pc < 12; pc++) chroma[f * 12 + pc] = Math.log1p(chroma[f * 12 + pc]);
  }
  // Frame f covers a quarter second starting at f/FPS, so it is centred
  // `centre` frames later. The rise at moment f: the frame centred just
  // after it compared with the one centred just before.
  const lag = 10;
  const centre = Math.round(n / 2 / hop);
  const rise = new Float32Array(frames * 12);
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, Math.min(frames - 1, f - centre + Math.round(lag / 2)));
    const b = Math.max(0, a - lag);
    for (let pc = 0; pc < 12; pc++) rise[f * 12 + pc] = Math.max(0, chroma[a * 12 + pc] - chroma[b * 12 + pc]);
  }
  return { frames, rise };
}

export interface Column {
  t: number;
  /** strings and frets played (muted hits left out) */
  notes: { string: number; fret: number }[];
}

/** How well the columns' notes start at their times (shifted by d), with a capo. */
function pitchScore(cols: Column[], ps: PitchStarts, d: number, capo: number): number {
  let s = 0;
  for (const c of cols) {
    if (!c.notes.length) continue;
    const pcs = [...new Set(c.notes.map((n) => pitchClass(n.string, n.fret, capo)))];
    const f0 = Math.round((c.t + d) * FPS);
    let best = 0;
    for (let f = f0 - 4; f <= f0 + 4; f++) {
      if (f < 0 || f >= ps.frames) continue;
      let v = 0;
      for (const pc of pcs) v += ps.rise[f * 12 + pc];
      if (v > best) best = v;
    }
    s += best / pcs.length;
  }
  return s;
}

/**
 * The slide (seconds) and capo that make the columns' notes start sounding
 * at their times, searching ±`range` around `around`. Also how clear the
 * winner is (best score ÷ the typical score).
 */
export function alignByPitch(cols: Column[], ps: PitchStarts, range = 3, around = 0, capos = [0, 1, 2, 3, 4, 5, 6, 7]): { offset: number; capo: number; clarity: number } {
  // For each capo: the best slide, and how much it stands out from that
  // capo's typical score (some capos score high everywhere just because
  // their notes are common in the song; the right one has a clear peak).
  let best = { offset: around, capo: 0, clarity: 0 };
  for (const capo of capos) {
    const all: number[] = [];
    let top = { d: around, s: -1 };
    for (let d = around - range; d <= around + range + 1e-9; d += 0.02) {
      const s = pitchScore(cols, ps, d, capo);
      all.push(s);
      if (s > top.s) top = { d, s };
    }
    all.sort((a, b) => a - b);
    const clarity = top.s / (all[all.length >> 1] || 1);
    if (clarity > best.clarity) best = { offset: Math.round(top.d * 100) / 100, capo, clarity };
  }
  return best;
}

// --- All together -------------------------------------------------------------------------

export interface SyncNote {
  t: number;
  string: number;
  fret: number;
  chord?: number;
  tech?: string;
}

export interface SyncReport {
  /** The slide for the whole video (seconds; − means the sound comes earlier). */
  offset: number;
  capo: number;
  /** How clearly the notes lined up (1 = not at all; ~2+ = clearly). */
  clarity: number;
  /** The slide used on each page. */
  pageOffsets: number[];
  columns: number;
  snapped: number;
  /** Why the times were left alone, when they were. */
  skipped?: string;
}

/**
 * New times for the notes, lined up with the sound: one slide for the
 * video (found by matching the notes' pitches to what starts sounding),
 * refined page by page, then each column moved onto the pluck next to it.
 * Notes keep their order. When nothing lines up clearly, times stay.
 */
export interface Sound {
  starts: PitchStarts;
  /** onset strength (see onsetEnvelope) */
  env: Float32Array;
}

/** What the lining-up needs from the sound (the sound itself isn't kept). */
export function analyzeSound(pcm: Float32Array, rate: number): Sound {
  return { starts: pitchStarts(pcm, rate), env: onsetEnvelope(pcm, rate) };
}

export function syncNotes(notes: SyncNote[], pages: { start: number; end: number }[], sound: Sound): { times: number[]; report: SyncReport } {
  // columns: a chord's notes (or notes at one time) together
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].t - notes[b].t);
  const colOf = new Array<number>(notes.length);
  const cols: (Column & { members: number[] })[] = [];
  for (const i of order) {
    const n = notes[i];
    const last = cols[cols.length - 1];
    const same = last && (Math.abs(last.t - n.t) < 1e-6 || (n.chord !== undefined && notes[last.members[0]].chord === n.chord));
    if (same) {
      last.members.push(i);
      if (n.tech !== "mute") last.notes.push({ string: n.string, fret: n.fret });
    } else cols.push({ t: n.t, notes: n.tech === "mute" ? [] : [{ string: n.string, fret: n.fret }], members: [i] });
    colOf[i] = cols.length - 1;
  }
  const keep = { times: notes.map((n) => n.t) };
  const base: SyncReport = { offset: 0, capo: 0, clarity: 0, pageOffsets: [], columns: cols.length, snapped: 0 };
  if (cols.filter((c) => c.notes.length).length < 8) return { ...keep, report: { ...base, skipped: "too few notes" } };

  const ps = sound.starts;
  const g = alignByPitch(cols, ps, 3, 0);
  if (g.clarity < 1.5) return { ...keep, report: { ...base, offset: g.offset, capo: g.capo, clarity: g.clarity, skipped: "the sound didn't line up clearly" } };

  const pageOf = (t: number) => pages.findIndex((p) => t >= p.start - 0.05 && t < p.end + 0.05);
  const pageOffsets = pages.map((_, k) => {
    const mine = cols.filter((c) => pageOf(c.t) === k && c.notes.length);
    if (mine.length < 6) return g.offset;
    const r = alignByPitch(mine, ps, 0.4, g.offset, [g.capo]);
    return r.clarity >= 1.15 ? r.offset : g.offset;
  });
  const shifted = cols.map((c) => {
    const k = pageOf(c.t);
    return c.t + (k >= 0 ? pageOffsets[k] : g.offset);
  });

  // each column onto the pluck next to it (±80 ms), keeping their order
  const peaks = onsetPeaks(sound.env);
  const colTimes: number[] = [];
  let snapped = 0;
  let pi = 0;
  shifted.forEach((t, ci) => {
    const prev = ci ? colTimes[ci - 1] : -Infinity;
    while (pi < peaks.length && peaks[pi].t < t - 0.08) pi++;
    let best = -1;
    for (let k = pi; k < peaks.length && peaks[k].t <= t + 0.08; k++) if (best < 0 || Math.abs(peaks[k].t - t) < Math.abs(peaks[best].t - t)) best = k;
    if (best >= 0 && peaks[best].t > prev + 0.02) {
      colTimes.push(peaks[best].t);
      snapped++;
    } else colTimes.push(Math.max(t, prev + 0.02));
  });
  return {
    times: notes.map((_, i) => Math.round(colTimes[colOf[i]] * 1000) / 1000),
    report: { offset: g.offset, capo: g.capo, clarity: Math.round(g.clarity * 100) / 100, pageOffsets, columns: cols.length, snapped },
  };
}
