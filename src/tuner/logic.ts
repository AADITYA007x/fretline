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

/** "12 cents flat, tune up" and friends. */
export function describe(cents: number, playing: string, target: string): { text: string; inTune: boolean } {
  const c = Math.round(cents);
  if (Math.abs(cents) <= IN_TUNE) return { text: "In tune", inTune: true };
  if (Math.abs(cents) > 60) return { text: `That's ${playing}. Tune ${cents < 0 ? "up" : "down"} to ${target}`, inTune: false };
  return { text: `${Math.abs(c)} cents ${c < 0 ? "flat, tune up" : "sharp, tune down"}`, inTune: false };
}
