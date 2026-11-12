// Tuner decisions with no DOM, so they're unit-tested.
import { centsOff, midiToFreq, noteToMidi } from "./pitch";
import type { Tuning } from "./tunings";

/** Within this many cents counts as in tune. */
export const IN_TUNE = 3;

/** Which string a frequency belongs to (closest in pitch). */
export function nearestString(freq: number, t: Tuning, a4: number): number {
  let best = 0;
  let bestDist = Infinity;
  t.strings.forEach((n, i) => {
    const dist = Math.abs(centsOff(freq, midiToFreq(noteToMidi(n), a4)));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/** Once in tune, it takes this much drift to fall out (stops flicker). */
export const IN_TUNE_EXIT = 4.5;

/** "12 cents flat, tune up" and friends. */
export function describe(cents: number, playing: string, target: string, wasInTune = false): { text: string; inTune: boolean } {
  const c = Math.round(cents);
  if (Math.abs(cents) <= (wasInTune ? IN_TUNE_EXIT : IN_TUNE)) return { text: "In tune", inTune: true };
  if (Math.abs(cents) > 60) return { text: `That's ${playing}. Tune ${cents < 0 ? "up" : "down"} to ${target}`, inTune: false };
  return { text: `${Math.abs(c)} cents ${c < 0 ? "flat, tune up" : "sharp, tune down"}`, inTune: false };
}

/** Two strings whose pitches are a simple ratio apart (one rings along with the other). */
export function related(f1: number, f2: number): boolean {
  const r = Math.max(f1, f2) / Math.min(f1, f2);
  return [2, 3, 4, 1.5, 4 / 3, 5 / 4, 5 / 3, 8 / 3].some((x) => Math.abs(r / x - 1) < 0.02);
}

/**
 * Auto mode's choice of string. Three readings in a row must agree before
 * it changes, so one odd reading can't flip it.
 *
 * While a note dies away, other open strings ring along with it (the high
 * e sets A, low E and B humming) and end up louder than what's left of it.
 * Those readings are much quieter than the pluck was and come from a string
 * related to it: they're ignored, and the display keeps your string. A
 * string you actually pluck is as loud as a pluck (or starts with a jump in
 * level), so it still takes over.
 */
export class StringPicker {
  private current = -1;
  private candidate = -1;
  private count = 0;
  private recent: number[] = [];
  private rising = false;
  /** The loudest the current string has been since the last pluck. */
  private peak = 0;

  /** Every mic frame (silence too): how loud it is, so a new pluck is noticed. */
  hear(level: number): void {
    const floor = this.recent.length ? Math.min(...this.recent) : 0;
    // a new pluck: whatever comes next is measured against it, not the last one
    const rising = level > 0.008 && level > floor * 1.6;
    if (rising && !this.rising) this.peak = 0;
    this.rising = rising;
    this.recent.push(level);
    if (this.recent.length > 3) this.recent.shift();
  }

  /** The string, or -1 to ignore this reading (a string ringing along). */
  pick(freq: number, t: Tuning, a4: number, level = 0): number {
    const n = nearestString(freq, t, a4);
    if (this.current < 0 || n === this.current) {
      this.current = n;
      this.candidate = -1;
      this.count = 0;
      this.peak = Math.max(this.peak, level);
      return n;
    }
    if (level > 0 && level < this.peak * 0.5) {
      const fc = midiToFreq(noteToMidi(t.strings[this.current]), a4);
      const fn = midiToFreq(noteToMidi(t.strings[n]), a4);
      if (related(fc, fn)) return -1;
    }
    if (n === this.candidate) {
      if (++this.count >= 3) {
        this.current = n;
        this.candidate = -1;
        this.count = 0;
        this.peak = level;
      }
    } else {
      this.candidate = n;
      this.count = 1;
    }
    return this.current;
  }

  reset(): void {
    this.current = -1;
    this.candidate = -1;
    this.count = 0;
    this.peak = 0;
  }
}
