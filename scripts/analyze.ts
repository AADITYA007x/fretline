// Run the tuner's detector over a recording (raw mono f32 at 48 kHz).
// Usage: node analyze.js file.f32 [tuningId] [stepMs]
import { readFileSync } from "node:fs";
import { detectPitch, frameSizeFor, PitchSmoother, rms, centsOff, freqToMidi, midiToNote, midiToFreq } from "../src/tuner/pitch";
import { PRESETS, listenRange } from "../src/tuner/tunings";

const [file, tuningId = "g-standard", stepArg = "45"] = process.argv.slice(2);
const raw = readFileSync(file);
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const SR = 48000;
const t = PRESETS.find((p) => p.id === tuningId)!;
const range = listenRange(t);
const size = frameSizeFor(range.minFreq, SR);
const step = Math.round((Number(stepArg) / 1000) * SR);
const sm = new PitchSmoother(7);
let last = 0;
let onsetEnd = 0;
for (let end = size; end <= x.length; end += step) {
  const frame = x.subarray(end - size, end);
  const level = rms(frame.subarray(frame.length - 2048));
  if (level > last * 1.6 && level > 0.008) {
    sm.reset();
    onsetEnd = end;
  }
  last = level;
  const r = level > 0.004 ? detectPitch(frame, { sampleRate: SR, ...range }) : null;
  const shown = r && r.clarity > 0.8 ? sm.push(r.freq, (end - onsetEnd) / SR < 0.9) : null;
  const fmt = (f: number | null | undefined) => {
    if (!f) return "      -          ";
    const m = Math.round(freqToMidi(f));
    return `${f.toFixed(2).padStart(7)} ${midiToNote(m).padEnd(3)} ${centsOff(f, midiToFreq(m)).toFixed(1).padStart(6)}`;
  };
  console.log(`${(end / SR).toFixed(2).padStart(6)}s rms ${level.toFixed(3)} raw ${fmt(r?.freq)} cl ${(r?.clarity ?? 0).toFixed(2)} shown ${fmt(shown)}`);
}

// With TRUTH=name:hz,... print error stats for the stretches given in SEGS=name:a-b,...
if (process.env.SEGS) {
  const truth = Object.fromEntries(process.env.TRUTH!.split(",").map((p) => p.split(":")).map(([n, v]) => [n, Number(v)]));
  for (const seg of process.env.SEGS.split(",")) {
    const [name, span] = seg.split(":");
    const [a, b] = span.split("-").map(Number);
    const errs: number[] = [];
    const shownErrs: number[] = [];
    const s2 = new PitchSmoother(7);
    for (let end = Math.round(a * SR) + size; end <= b * SR; end += Math.round(0.045 * SR)) {
      const r = detectPitch(x.subarray(end - size, end), { sampleRate: SR, ...range });
      if (!r) continue;
      errs.push(centsOff(r.freq, truth[name]));
      shownErrs.push(centsOff(s2.push(r.freq), truth[name]));
    }
    const stat = (v: number[]) => {
      const mean = v.reduce((p, c) => p + c, 0) / v.length;
      const sd = Math.sqrt(v.reduce((p, c) => p + (c - mean) ** 2, 0) / v.length);
      const worst = Math.max(...v.map(Math.abs));
      return `mean ${mean.toFixed(2)} sd ${sd.toFixed(2)} worst ${worst.toFixed(1)}`;
    };
    console.log(`${name.padEnd(3)} n=${errs.length} raw: ${stat(errs)} | shown: ${stat(shownErrs)}`);
  }
}
