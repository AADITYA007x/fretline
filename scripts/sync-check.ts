// Dev tool: line a video's cursor-timed columns up with its sound and
// report how. Usage: node sync-check.mjs <video with sound> <times.json from scan-video TIMES=…> [shift]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { analyzeSound, syncNotes, type SyncNote } from "../src/scan/onsets";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [file, timesFile, shiftArg] = process.argv.slice(2);
const shift = Number(shiftArg ?? 0);
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const cols: { t: number; page: number; notes: { string: number; fret: number }[] }[] = JSON.parse(readFileSync(timesFile, "utf8"));
const notes: SyncNote[] = cols.flatMap((c, i) => c.notes.map((n) => ({ t: c.t + shift, string: n.string, fret: n.fret, chord: i })));
const pageStarts = [...new Set(cols.map((c) => c.page))].sort((a, b) => a - b);
const pages = pageStarts.map((s, i) => ({ start: s + shift, end: (pageStarts[i + 1] ?? 1e9) + shift }));
const t0 = Date.now();
const sound = analyzeSound(pcm, 8000);
const r = syncNotes(notes, pages, sound);
if (process.env.SAVE) {
  // features only (not the sound), each scaled to bytes
  const q = (a: Float32Array) => {
    let m = 0;
    for (const v of a) if (v > m) m = v;
    return { scale: m / 255, b64: Buffer.from(Uint8Array.from(a, (v) => Math.round((v / (m || 1)) * 255))).toString("base64") };
  };
  writeFileSync(process.env.SAVE, gzipSync(JSON.stringify({ frames: sound.starts.frames, rise: q(sound.starts.rise), env: q(sound.env), cols })));
}
console.log(JSON.stringify(r.report), "ms", Date.now() - t0);
