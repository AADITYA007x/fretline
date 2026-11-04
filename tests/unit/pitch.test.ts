import { describe, expect, it } from "vitest";
import { PitchSmoother, centsOff, detectPitch, frameSizeFor, freqToMidi, midiToFreq, midiToNote, noteToMidi, rms } from "../../src/tuner/pitch";
import { PRESETS, listenRange } from "../../src/tuner/tunings";
import { frameAt, pluck } from "./synth";

const SR = 48000;
const FRAME = 4096;

describe("notes", () => {
  it("converts note names", () => {
    expect(noteToMidi("E2")).toBe(40);
    expect(noteToMidi("A4")).toBe(69);
    expect(noteToMidi("F#3")).toBe(54);
    expect(noteToMidi("Bb2")).toBe(46);
    expect(noteToMidi("B0")).toBe(23);
    expect(midiToNote(61)).toBe("C#4");
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(midiToFreq(69, 432)).toBeCloseTo(432, 6);
    expect(freqToMidi(82.4069)).toBeCloseTo(40, 3);
    expect(centsOff(440 * Math.pow(2, 5 / 1200), 440)).toBeCloseTo(5, 6);
  });

  it("every preset has valid notes", () => {
    for (const t of PRESETS) for (const s of t.strings) expect(Number.isNaN(noteToMidi(s)), `${t.id} ${s}`).toBe(false);
  });
});

describe("PitchSmoother", () => {
  it("ignores one stray reading, follows a real note change", () => {
    const sm = new PitchSmoother(5);
    for (let i = 0; i < 5; i++) sm.push(110);
    expect(sm.push(220)).toBeCloseTo(110, 6); // octave glitch
    expect(sm.push(110)).toBeCloseTo(110, 6);
    sm.push(147);
    expect(sm.push(147.2)).toBeCloseTo(147.1, 1); // new string plucked
  });
});

describe("detectPitch", () => {
  // Every string of every preset, in tune and 12 cents off, at several
  // moments of the pluck (attack, ring, fading).
  for (const tuning of PRESETS) {
    it(`${tuning.instrument} ${tuning.name}: within 2 cents per reading, 1.2 cents smoothed`, () => {
      const range = listenRange(tuning);
      const size = frameSizeFor(range.minFreq, SR);
      for (const note of tuning.strings) {
        for (const detune of [0, 12, -12]) {
          const f0 = midiToFreq(noteToMidi(note)) * Math.pow(2, detune / 1200);
          const sig = pluck({ freq: f0, sampleRate: SR, seconds: 2.2, noise: 0.01, seed: Math.round(f0) });
          for (const t of [0.15, 0.6, 1.5]) {
            const r = detectPitch(frameAt(sig, SR, t, size), { sampleRate: SR, ...range });
            expect(r, `${tuning.id} ${note} ${detune}c @${t}s`).not.toBeNull();
            const err = centsOff(r!.freq, f0);
            expect(Math.abs(err), `${tuning.id} ${note} ${detune}c @${t}s: off by ${err.toFixed(2)}c`).toBeLessThan(2);
            // What the needle shows: the median of 5 readings, ~20 ms apart.
            // (1.2 c allows for the quiet, noisy tail of a fading note.)
            const sm = new PitchSmoother(5);
            let shown = 0;
            for (let j = 0; j < 5; j++) {
              const rr = detectPitch(frameAt(sig, SR, t + j * 0.021, size), { sampleRate: SR, ...range });
              if (rr) shown = sm.push(rr.freq);
            }
            const sErr = centsOff(shown, f0);
            expect(Math.abs(sErr), `${tuning.id} ${note} ${detune}c @${t}s smoothed: ${sErr.toFixed(2)}c`).toBeLessThan(1.2);
          }
        }
      }
    });
  }

  it("does not jump an octave up on a weak fundamental (low E)", () => {
    const f0 = midiToFreq(40);
    const sig = pluck({ freq: f0, sampleRate: SR, seconds: 1.5, harmonics: [0.25, 1, 0.5, 0.35, 0.2], seed: 3 });
    const r = detectPitch(frameAt(sig, SR, 0.4, FRAME), { sampleRate: SR, minFreq: 60, maxFreq: 450 });
    expect(r).not.toBeNull();
    expect(Math.abs(centsOff(r!.freq, f0))).toBeLessThan(2);
  });

  it("is fast enough for a phone (bass frame)", () => {
    const sig = pluck({ freq: 41.2, sampleRate: SR, seconds: 1, seed: 5 });
    const frame = frameAt(sig, SR, 0.3, 8192);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) detectPitch(frame, { sampleRate: SR, minFreq: 23, maxFreq: 120 });
    const each = (performance.now() - t0) / 50;
    expect(each).toBeLessThan(8); // ms on this machine; phones ~3-5× slower, still fine at 15/s
  });

  it("works at 44.1 kHz too", () => {
    const sr = 44100;
    const f0 = midiToFreq(45); // A2
    const sig = pluck({ freq: f0, sampleRate: sr, seconds: 1, seed: 9 });
    const r = detectPitch(frameAt(sig, sr, 0.3, FRAME), { sampleRate: sr, minFreq: 60, maxFreq: 450 });
    expect(Math.abs(centsOff(r!.freq, f0))).toBeLessThan(1.5);
  });

  it("ignores pure noise", () => {
    let seed = 11;
    const noise = new Float32Array(FRAME).map(() => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 4294967296) * 2 - 1;
    });
    expect(detectPitch(noise, { sampleRate: SR, minFreq: 60, maxFreq: 450 })).toBeNull();
    expect(rms(noise)).toBeGreaterThan(0.5);
  });
});
