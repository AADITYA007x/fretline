// Aaditya's real guitar, recorded on his iQOO lying next to the strings:
// each open string of standard tuning, plucked with a pick and left to
// ring. The "truth" per string was measured separately with a very long,
// high-resolution FFT of the ringing part (see scripts/analyze.ts).
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PitchSmoother, centsOff, detectPitch, frameSizeFor, rms } from "../../src/tuner/pitch";
import { nearestString } from "../../src/tuner/logic";
import { PRESETS, listenRange } from "../../src/tuner/tunings";

const SR = 48000;
const FILE = "tests/fixtures/audio/standard-tuning-iqoo.m4a";

function decode(): Float32Array | null {
  try {
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", FILE, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  } catch {
    return null;
  }
}

const audio = decode();
const standard = PRESETS.find((t) => t.id === "g-standard")!;
// [string index, sustain start, end, true frequency]
const RINGS: [number, number, number, number][] = [
  [0, 1.95, 3.6, 82.066],
  [1, 4.85, 6.3, 110.207],
  [2, 7.5, 9.6, 146.564],
  [3, 11.0, 11.4, 196.735], // the G's pitch glides for its first ~0.6 s
  [4, 13.8, 14.1, 247.101], // the B also starts a few cents sharp
  [5, 15.95, 16.5, 330.368],
];

describe.skipIf(!audio)("real recording (iQOO, standard tuning)", () => {
  const x = audio!;
  const range = listenRange(standard);
  const size = frameSizeFor(range.minFreq, SR);

  /** Replays the tuner over the whole file like the app does. */
  function replay(): { t: number; freq: number }[] {
    const out: { t: number; freq: number }[] = [];
    const sm = new PitchSmoother(7);
    let last = 0;
    let onset = -10;
    const step = Math.round(0.045 * SR);
    for (let end = size; end <= x.length; end += step) {
      const t = end / SR;
      const frame = x.subarray(end - size, end);
      const level = rms(frame.subarray(frame.length - 2048));
      if (level > last * 1.6 && level > 0.008) {
        sm.reset();
        onset = t;
      }
      last = level;
      if (level < 0.004 || t - onset < 0.26) continue;
      const r = detectPitch(frame, { sampleRate: SR, ...range });
      if (!r || r.clarity < 0.8) continue;
      out.push({ t, freq: sm.push(r.freq, t - onset < 0.9) });
    }
    return out;
  }

  const shown = audio ? replay() : [];

  it("reads every string within 2.5 cents while it rings", () => {
    for (const [s, a, b, truth] of RINGS) {
      const during = shown.filter((r) => r.t >= a && r.t <= b);
      expect(during.length, `string ${s}`).toBeGreaterThan(5);
      for (const r of during) {
        const c = centsOff(r.freq, truth);
        expect(Math.abs(c), `string ${s} @${r.t.toFixed(2)}s: ${c.toFixed(1)}c`).toBeLessThan(2.5);
      }
    }
  });

  it("never shows a wrong string", () => {
    for (const r of shown) {
      // The ring that started most recently (each pluck replaces the last).
      const ring = [...RINGS].reverse().find(([, a]) => r.t >= a - 0.7);
      if (!ring) continue;
      expect(nearestString(r.freq, standard, 440), `@${r.t.toFixed(2)}s`).toBe(ring[0]);
    }
  });
});
