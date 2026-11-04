import { describe, expect, it } from "vitest";
import { centsOff, detectPitch, frameSizeFor, midiToFreq, noteToMidi } from "../../src/tuner/pitch";
import { pluckSamples, sustainSamples } from "../../src/tuner/tones";

describe("reference tones are in tune", () => {
  for (const sr of [44100, 48000]) {
    for (const note of ["B0", "E1", "C2", "E2", "A2", "D3", "G3", "B3", "E4", "A4"]) {
      it(`${note} @ ${sr} Hz`, () => {
        const f0 = midiToFreq(noteToMidi(note));
        const minFreq = f0 * 0.7;
        const size = frameSizeFor(minFreq, sr);
        for (const [name, sig] of [
          ["pluck", pluckSamples(f0, sr, 1.5)],
          ["sustain", sustainSamples(f0, sr, 1)],
        ] as const) {
          const start = Math.round(sr * 0.3);
          const r = detectPitch(sig.slice(start, start + size), { sampleRate: sr, minFreq, maxFreq: f0 * 1.5 });
          expect(r, `${name}`).not.toBeNull();
          expect(Math.abs(centsOff(r!.freq, f0)), `${name} ${centsOff(r!.freq, f0).toFixed(2)}c`).toBeLessThan(1);
        }
      });
    }
  }
});
