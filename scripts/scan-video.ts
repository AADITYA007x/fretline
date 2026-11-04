// Dev tool: run the whole tab reader over a local video file, the way the
// phone does (overview → staff → per-frame measurements → pages → OCR with
// Tesseract standing in for ML Kit). Usage: node scan-video.mjs file.mp4
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTab } from "../src/scan/clean";
import { charsToNotes, columns, commonStaff, findPages, findStaff, staffRect, timeColumns, type FrameFeatures, type OcrChar } from "../src/scan/vision";

const file = process.argv[2];
const fps = Number(process.env.FPS ?? 4);
const [W0, H0] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim().split(",").map(Number);
const W = W0 - (W0 % 2);
const H = H0 - (H0 % 2);
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

// 1. overview: 16 grey frames at 640 wide
const ow = 640;
const oh = Math.round((H * ow) / W);
const staffs = [];
for (let i = 1; i <= 16; i++) {
  const t = (dur * i) / 17;
  const g = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=${W}:${H}:0:0,scale=${ow}:${oh}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  staffs.push(findStaff(new Uint8Array(g), ow, oh));
}
console.log("staffs found:", staffs.filter(Boolean).length, "/ 16");
const staff = commonStaff(staffs);
if (!staff) throw new Error("no common staff");
const scale = W / ow;
const rect = staffRect(staff, scale, W, H);
const lines = staff.lines.map((y) => y * scale);
console.log("lines", lines.map((y) => y.toFixed(0)).join(" "), "rect", rect);

// 2. per-frame measurements (Y and Cb per column, 32×8 thumb), like the phone
const cols = 480;
// Only the tab area is needed (keeps memory small).
const RW = rect.w - (rect.w % 2);
const RH = rect.h - (rect.h % 2);
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${W}:${H}:0:0,crop=${RW}:${RH}:${rect.x - (rect.x % 2)}:${rect.y - (rect.y % 2)},fps=${fps}`, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], { maxBuffer: 1 << 30 });
const frameSize = (RW * RH * 3) / 2;
const frames: FrameFeatures[] = [];
for (let f = 0; f * frameSize < raw.length; f++) {
  const base = f * frameSize;
  const Y = raw.subarray(base, base + RW * RH);
  const U = raw.subarray(base + RW * RH, base + RW * RH + (RW * RH) / 4);
  const V = raw.subarray(base + RW * RH + (RW * RH) / 4, base + frameSize);
  const ys = new Float64Array(cols), yn = new Float64Array(cols), us = new Float64Array(cols), un = new Float64Array(cols), vs = new Float64Array(cols);
  const MW = 64, MH = 12;
  const mini = new Float64Array(MW * MH), mn = new Float64Array(MW * MH);
  for (let y = 0; y < RH; y += 2) {
    for (let x = 0; x < RW; x++) {
      const c = Math.min(cols - 1, Math.floor((x * cols) / RW));
      const v = Y[y * RW + x];
      ys[c] += v;
      yn[c]++;
      const mi = Math.min(MH - 1, Math.floor((y * MH) / RH)) * MW + Math.min(MW - 1, Math.floor((x * MW) / RW));
      mini[mi] += v;
      mn[mi]++;
      if ((x & 1) === 0) {
        us[c] += U[(y >> 1) * (RW >> 1) + (x >> 1)];
        vs[c] += V[(y >> 1) * (RW >> 1) + (x >> 1)];
        un[c]++;
      }
    }
  }
  frames.push({
    t: f / fps,
    y: Uint8Array.from(ys, (s, i) => s / (yn[i] || 1)),
    u: Uint8Array.from(us, (s, i) => (un[i] ? s / un[i] : 128)),
    v: Uint8Array.from(vs, (s, i) => (un[i] ? s / un[i] : 128)),
    m: Uint8Array.from(mini, (s, i) => s / (mn[i] || 1)),
  });
}
const pages = findPages(frames);
if (process.env.SAVE) {
  const b64 = (a?: Uint8Array) => (a ? Buffer.from(a).toString("base64") : undefined);
  writeFileSync(process.env.SAVE, JSON.stringify({ rect, frames: frames.map((f) => ({ t: f.t, y: b64(f.y), u: b64(f.u), v: b64(f.v), m: b64(f.m) })) }));
}
console.log(`frames ${frames.length}, pages ${pages.length}`);
for (const p of pages) {
  const c = p.cursor;
  console.log(`  page ${p.start.toFixed(2)}–${p.end.toFixed(2)}s cursor samples ${c.length}${c.length ? ` x ${c[0].x.toFixed(2)}→${c[c.length - 1].x.toFixed(2)}` : ""}`);
}

// 3. OCR the pages (Tesseract) and print the notes
if (process.env.OCR !== "0") {
  const dir = mkdtempSync(join(tmpdir(), "scan-"));
  for (const p of pages.slice(0, Number(process.env.PAGES ?? 3))) {
    const ox = rect.x - (rect.x % 2);
    const oy = rect.y - (rect.y % 2);
    const g = execFileSync("ffmpeg", ["-v", "error", "-ss", String(p.readAt), "-i", file, "-frames:v", "1", "-vf", `crop=${W}:${H}:0:0,crop=${RW}:${RH}:${ox}:${oy}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const clean = cleanTab(new Uint8Array(g), RW, RH, lines.map((y) => y - oy));
    writeFileSync(join(dir, "a.gray"), clean);
    const S = 3;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${RW}x${RH}`, "-i", join(dir, "a.gray"), "-vf", `scale=iw*${S}:ih*${S}:flags=bicubic`, join(dir, `p${p.start.toFixed(0)}.png`)]);
    const tsv = execFileSync("tesseract", [join(dir, `p${p.start.toFixed(0)}.png`), "-", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789xX", "tsv"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const chars: OcrChar[] = [];
    for (const row of tsv.split("\n").slice(1)) {
      const c = row.split("\t");
      if (c.length < 12 || c[0] !== "5" || !c[11].trim()) continue;
      const [left, top, width, height] = c.slice(6, 10).map(Number);
      const text = c[11].trim();
      const cw = width / text.length;
      [...text].forEach((ch, i) => chars.push({ c: ch, x: ox + (left + i * cw) / S, y: oy + top / S, w: cw / S, h: height / S }));
    }
    const cs = columns(charsToNotes(chars, lines), staff.spacing * scale);
    const ts = timeColumns(cs, p, rect);
    console.log(`  page @${p.start.toFixed(1)}s: ` + cs.map((col, i) => `${ts[i].t.toFixed(1)}:${col.map((n) => `${n.string}/${n.fret}`).join("+")}`).join(" "));
  }
  console.log("cleaned crops in", dir);
}
