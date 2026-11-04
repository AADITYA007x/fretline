// Dev tool: OCR characters (video pixels) for a frame, via Tesseract, to use
// as the fake phone's reading in tests. Usage: node … frame.png > out.json
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTab } from "../src/scan/clean";
import { findStaff, staffRect, type OcrChar } from "../src/scan/vision";

const file = process.argv[2];
const [W, H] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim().split(",").map(Number);
const ow = 640;
const oh = Math.round((H * ow) / W);
const small = new Uint8Array(execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${ow}:${oh}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]));
const staff = findStaff(small, ow, oh)!;
const scale = W / ow;
const r = staffRect(staff, scale, W, H);
const lines = staff.lines.map((y) => y * scale);
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
const clean = cleanTab(new Uint8Array(raw), r.w, r.h, lines.map((y) => y - r.y));
const dir = mkdtempSync(join(tmpdir(), "tab-"));
writeFileSync(join(dir, "a.gray"), clean);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${r.w}x${r.h}`, "-i", join(dir, "a.gray"), "-vf", "scale=iw*3:ih*3:flags=bicubic", join(dir, "a.png")]);
const tsv = execFileSync("tesseract", [join(dir, "a.png"), "-", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789", "tsv"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
const chars: OcrChar[] = [];
for (const row of tsv.split("\n").slice(1)) {
  const c = row.split("\t");
  if (c.length < 12 || c[0] !== "5" || !c[11].trim()) continue;
  const [left, top, width, height] = c.slice(6, 10).map(Number);
  const text = c[11].trim();
  const cw = width / text.length;
  [...text].forEach((ch, i) => chars.push({ c: ch, x: Math.round(r.x + (left + i * cw) / 3), y: Math.round(r.y + top / 3), w: Math.round(cw / 3), h: Math.round(height / 3) }));
}
process.stdout.write(JSON.stringify({ chars }));
