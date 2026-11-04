// Dev tool: run the tab reader on a still frame with Tesseract standing in
// for ML Kit. Usage: node ocr-frame.mjs frame.png
import { execFileSync } from "node:child_process";
import { charsToNotes, columns, findStaff, staffRect, type OcrChar } from "../src/scan/vision";

const file = process.argv[2];
const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim();
const [W, H] = probe.split(",").map(Number);
const ow = 640;
const oh = Math.round((H * ow) / W);
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${ow}:${oh}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
const staff = findStaff(new Uint8Array(raw), ow, oh);
if (!staff) throw new Error("no staff");
const scale = W / ow;
const rect = staffRect(staff, scale, W, H);
const lines = staff.lines.map((y) => y * scale);
console.log("staff lines (video px):", lines.map((y) => y.toFixed(1)).join(" "), "rect", rect);
const S = 2;
const crop = process.env.OUT ?? "/tmp/claude-0/crop.png";
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=iw*${S}:ih*${S}`, crop]);
const tsv = execFileSync("tesseract", [crop, "-", "--psm", "11", "-c", "tessedit_char_whitelist=0123456789", "tsv"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
const chars: OcrChar[] = [];
for (const row of tsv.split("\n").slice(1)) {
  const c = row.split("\t");
  if (c.length < 12 || c[0] !== "5" || !c[11].trim()) continue;
  const [left, top, width, height] = c.slice(6, 10).map(Number);
  const text = c[11].trim();
  // Tesseract gives words; split evenly into characters (ML Kit gives symbols).
  const cw = width / text.length;
  [...text].forEach((ch, i) => chars.push({ c: ch, x: rect.x + (left + i * cw) / S, y: rect.y + top / S, w: cw / S, h: height / S }));
}
const notes = charsToNotes(chars, lines);
console.log(columns(notes, staff.spacing * scale).map((col) => col.map((n) => `${n.string}:${n.fret}`).join("+")).join("  "));
