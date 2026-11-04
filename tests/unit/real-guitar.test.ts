// Harder, more guitar-like sounds than pitch.test.ts: stiff strings (sharp
// upper partials), a pick attack that starts sharp, a phone mic that loses
// bass, and other strings ringing along. Problems seen on a real iQOO.
import { describe, expect, it } from "vitest";
import { PitchSmoother, centsOff, detectPitch, frameSizeFor, midiToFreq, noteToMidi } from "../../src/tuner/pitch";
import { nearestString } from "../../src/tuner/logic";
import { PRESETS, listenRange } from "../../src/tuner/tunings";
import { firstPartial, frameAt, mix, pluck } from "./synth";

const SR = 48000;
const standard = PRESETS.find((t) => t.id === "g-standard")!;
const range = listenRange(standard);
const SIZE = frameSizeFor(range.minFreq, SR);
// Wound strings are less stiff than plain ones; the plain G is the stiffest.
const STIFF: Record<string, number> = { E2: 0.0001, A2: 0.00012, D3: 0.00015, G3: 0.0008, B3: 0.00025, E4: 0.0002 };
const BRIGHT = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2];

function readAt(sig: Float32Array, t: number): number | null {
  const sm = new PitchSmoother(7);
  let shown: number | null = null;
  for (let j = 0; j < 7; j++) {
    const r = detectPitch(frameAt(sig, SR, t + j * 0.045, SIZE), { sampleRate: SR, ...range });
    if (r) shown = sm.push(r.freq);
  }
  return shown;
}

describe("real-guitar-like sound", () => {
  for (const note of standard.strings) {
    it(`${note}: shows the first partial within 1 cent after the attack`, () => {
      const f0 = midiToFreq(noteToMidi(note));
      const o = { freq: f0, sampleRate: SR, seconds: 2.5, harmonics: BRIGHT, inharmonicity: STIFF[note], glideCents: 12, lowCutHz: 110, noise: 0.01, seed: Math.round(f0) };
      const sig = pluck(o);
      const want = firstPartial(o);
      for (const t of [0.5, 1.2]) {
        const shown = readAt(sig, t);
        expect(shown, `${note} @${t}s`).not.toBeNull();
        const err = centsOff(shown!, want);
        expect(Math.abs(err), `${note} @${t}s: ${err.toFixed(2)}c`).toBeLessThan(1);
      }
    });
  }

  it("high E with the low E ringing along is still the high E", () => {
    const e4 = midiToFreq(64);
    const e2 = midiToFreq(40);
    const played = pluck({ freq: e4, sampleRate: SR, seconds: 2, harmonics: BRIGHT, inharmonicity: 0.0002, lowCutHz: 110, seed: 3 });
    const sympathetic = pluck({ freq: e2, sampleRate: SR, seconds: 2, harmonics: BRIGHT, inharmonicity: 0.0001, lowCutHz: 110, seed: 4 });
    const sig = mix([played, 1], [sympathetic, 0.25]);
    for (const t of [0.3, 0.8, 1.4]) {
      const r = detectPitch(frameAt(sig, SR, t, SIZE), { sampleRate: SR, ...range });
      expect(r, `@${t}`).not.toBeNull();
      expect(nearestString(r!.freq, standard, 440), `@${t}s read ${r!.freq.toFixed(1)} Hz`).toBe(5);
    }
  });
});
