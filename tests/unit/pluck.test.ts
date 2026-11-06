import { describe, expect, it } from "vitest";
import { noteFreq, rollTimes } from "../../src/tabs/pluck";
import { pluckSamples } from "../../src/tuner/tones";
import { detectPitch } from "../../src/tuner/pitch";

describe("Fretline's pluck", () => {
  it("plays the right pitch for string, fret and capo", () => {
    expect(noteFreq({ string: 6, fret: 0 })).toBeCloseTo(82.41, 1);
    expect(noteFreq({ string: 5, fret: 0 })).toBeCloseTo(110, 1);
    expect(noteFreq({ string: 1, fret: 5 })).toBeCloseTo(440, 1);
    expect(noteFreq({ string: 1, fret: 5 }, 1)).toBeCloseTo(466.16, 1);
    expect(noteFreq({ string: 1, fret: 12, tech: "harmonic" })).toBeCloseTo(659.26, 1);
  });

  it("a strum rolls across the strings in its direction", () => {
    const chord = [{ string: 5 }, { string: 4 }, { string: 3 }];
    expect(rollTimes(chord.map((n, i) => ({ ...n, strum: i === 0 ? ("down" as const) : undefined })))).toEqual([0, 0.03, 0.06]);
    expect(rollTimes(chord.map((n) => ({ ...n, strum: "up" as const })))).toEqual([0.06, 0.03, 0]);
    expect(rollTimes(chord)).toEqual([0, 0, 0]);
  });

  it("the pluck really sounds at that pitch", () => {
    const f = noteFreq({ string: 3, fret: 2 }, 1);
    const s = pluckSamples(f, 44100, 0.5);
    const got = detectPitch(s.subarray(4410, 4410 + 4096), { sampleRate: 44100, minFreq: 70, maxFreq: 1200 });
    expect(got).not.toBeNull();
    expect(Math.abs(1200 * Math.log2(got!.freq / f))).toBeLessThan(10);
  });
});
