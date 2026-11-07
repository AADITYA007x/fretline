import { describe, expect, it } from "vitest";
import { chordMatch, chromaOf, expectedMidis, hears } from "../../src/practice/listen";
import { noteFreq } from "../../src/tabs/pluck";
import { pluckSamples } from "../../src/tuner/tones";
import type { TabNote } from "../../src/tabs/tab";

const SR = 48000;
const n = (string: number, fret: number, extra: Partial<TabNote> = {}): TabNote => ({ id: `${string}`, t: 0, string, fret, source: "screen", ...extra });

/** What the mic would hear of these notes played (with a little noise). */
function play(notes: TabNote[], capo = 0): Float32Array {
  const out = new Float32Array(SR);
  for (const x of notes) {
    const s = pluckSamples(noteFreq(x, capo), SR, 1);
    for (let i = 0; i < out.length; i++) out[i] += s[i] * 0.4;
  }
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 16807) % 2147483647;
    out[i] += ((seed / 2147483647) * 2 - 1) * 0.01;
  }
  return out.subarray(Math.round(SR * 0.2), Math.round(SR * 0.2) + 8192);
}

const AM = [n(5, 0), n(4, 2), n(3, 2), n(2, 1), n(1, 0)];
const C = [n(5, 3), n(4, 2), n(3, 0), n(2, 1), n(1, 0)];
const G = [n(6, 3), n(5, 2), n(4, 0), n(3, 0), n(2, 0), n(1, 3)];
const E = [n(6, 0), n(5, 2), n(4, 2), n(3, 1), n(2, 0), n(1, 0)];

describe("hearing you play", () => {
  it("a single note: the right one yes, a wrong one no", () => {
    expect(hears(play([n(3, 2)]), SR, [n(3, 2)], 0).ok).toBe(true);
    expect(hears(play([n(3, 4)]), SR, [n(3, 2)], 0).ok).toBe(false);
    expect(hears(play([n(2, 1)]), SR, [n(3, 2)], 0).ok).toBe(false);
  });
  it("with the capo the pitch moves up", () => {
    expect(hears(play([n(1, 3)], 1), SR, [n(1, 3)], 1).ok).toBe(true);
    expect(hears(play([n(1, 3)], 0), SR, [n(1, 3)], 1).ok).toBe(false);
  });
  it("chords: the right chord matches, others don't", () => {
    for (const [chord, others] of [
      [AM, [G, E]],
      [C, [E, G]],
      [G, [AM, E]],
      [E, [C, G]],
    ] as const) {
      expect(hears(play(chord), SR, chord, 0).ok).toBe(true);
      for (const o of others) expect(hears(play(o), SR, chord, 0).ok).toBe(false);
    }
  });
  it("chroma sums to 1 and is strongest on the chord's notes", () => {
    const c = chromaOf(play(AM), SR);
    expect(c.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(chordMatch(c, expectedMidis(AM, 0))).toBeGreaterThan(0.6);
  });
});
