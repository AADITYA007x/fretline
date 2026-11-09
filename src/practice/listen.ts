// Hearing you play: does what the mic hears match the note or chord on
// screen? Single notes by pitch; chords by which of the 12 notes sound
// (a "chroma") compared with the chord's own notes.
import { detectPitch, fft, freqToMidi } from "../tuner/pitch";
import { noteFreq } from "../tabs/pluck";
import type { TabNote } from "../tabs/tab";

export function expectedMidis(notes: TabNote[], capo: number): number[] {
  return notes.filter((n) => n.tech !== "mute").map((n) => Math.round(freqToMidi(noteFreq(n, capo))));
}

/** How strongly each of the 12 notes sounds in a frame (70–1400 Hz), summing to 1. */
export function chromaOf(frame: Float32Array, sampleRate: number): Float64Array {
  const N = 1 << Math.floor(Math.log2(frame.length));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const start = frame.length - N;
  for (let i = 0; i < N; i++) re[i] = frame[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  fft(re, im, false);
  const chroma = new Float64Array(12);
  const lo = Math.ceil((70 * N) / sampleRate);
  const hi = Math.min(N / 2 - 1, Math.floor((1400 * N) / sampleRate));
  const mag = new Float64Array(hi + 2);
  for (let k = lo - 1; k <= hi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
  for (let k = lo; k <= hi; k++) {
    // peaks only: a note is a peak, the spread around it isn't
    if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
    const f = (k * sampleRate) / N;
    const pc = ((Math.round(freqToMidi(f)) % 12) + 12) % 12;
    chroma[pc] += mag[k];
  }
  const sum = chroma.reduce((a, b) => a + b, 0);
  if (sum > 0) for (let i = 0; i < 12; i++) chroma[i] /= sum;
  return chroma;
}

/** 0..1: how much of what sounds is the chord's notes. */
export function chordMatch(chroma: Float64Array, midis: number[]): number {
  const pcs = new Set(midis.map((m) => ((m % 12) + 12) % 12));
  if (!pcs.size) return 0;
  let inside = 0;
  for (const pc of pcs) inside += chroma[pc];
  // each chord note should be there a little, too
  const present = [...pcs].filter((pc) => chroma[pc] > 0.04).length / pcs.size;
  return inside * (0.5 + 0.5 * present);
}

export interface Heard {
  ok: boolean;
  /** What it heard, when it's a single clear note (MIDI). */
  midi?: number;
}

/** Does this frame sound like the column? */
export function hears(frame: Float32Array, sampleRate: number, notes: TabNote[], capo: number): Heard {
  const midis = expectedMidis(notes, capo);
  if (!midis.length) return { ok: false };
  if (notes.some((n) => n.tech === "mute")) {
    // a slap with notes: the hit muddies the pitch, so just look for the
    // notes' own sound among it (or a looser pitch read for one note)
    const chroma = chromaOf(frame, sampleRate);
    const pcs = [...new Set(midis.map((m) => ((m % 12) + 12) % 12))];
    const inside = pcs.reduce((a, pc) => a + chroma[pc], 0);
    const each = pcs.every((pc) => chroma[pc] > 0.06);
    if (each && inside >= 0.25 * Math.min(1, pcs.length / 2 + 0.5)) return { ok: true };
    if (midis.length === 1) {
      const p = detectPitch(frame, { sampleRate, minFreq: 70, maxFreq: 1400 });
      if (p && p.clarity >= 0.5) {
        const m = freqToMidi(p.freq);
        const off = Math.min(Math.abs(m - midis[0]), Math.abs(m - midis[0] - 12), Math.abs(m - midis[0] + 12));
        if (off <= 0.7) return { ok: true };
      }
    }
    return { ok: false };
  }
  if (midis.length === 1) {
    const p = detectPitch(frame, { sampleRate, minFreq: 70, maxFreq: 1400 });
    if (!p || p.clarity < 0.7) return { ok: false };
    const m = freqToMidi(p.freq);
    const want = midis[0];
    // the right note (an octave slip counts: the mic often hears the octave)
    const off = Math.min(Math.abs(m - want), Math.abs(m - want - 12), Math.abs(m - want + 12));
    return { ok: off <= 0.6, midi: Math.round(m) };
  }
  return { ok: chordMatch(chromaOf(frame, sampleRate), midis) >= 0.52 };
}
