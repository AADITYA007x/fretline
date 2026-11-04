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

/**
 * Auto mode's choice of string, with some stickiness: another string takes
 * over only after three readings in a row agree, so one odd reading (a
 * string ringing along, the guitar body) can't flip it.
 */
export class StringPicker {
  private current = -1;
  private candidate = -1;
  private count = 0;

  pick(freq: number, t: Tuning, a4: number): number {
    const n = nearestString(freq, t, a4);
    if (this.current < 0 || n === this.current) {
      this.current = n;
      this.candidate = -1;
      this.count = 0;
    } else if (n === this.candidate) {
      if (++this.count >= 3) {
        this.current = n;
        this.candidate = -1;
        this.count = 0;
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
  }
}
