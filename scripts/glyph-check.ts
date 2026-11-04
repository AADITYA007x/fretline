// Dev tool: run the "find digits, lay them out, read them" reader over the
// pictures in a "Send reading details" zip, with Tesseract standing in for
// the phone's reader. Usage: node glyph-check.mjs <unzipped dir> [reading indexes]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTokens, layOut, readTokens, type ReadChar } from "../src/scan/glyphs";

const dir = process.argv[2];
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const pick = process.argv[3] ? process.argv[3].split(",").map(Number) : report.readings.map((_: unknown, i: number) => i);
const out: { k: number; t: number; notes: string }[] = [];
for (const k of pick) {
  const r = report.readings[k];
  const img = join(dir, r.image);
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", img]).toString().trim().split(",").map(Number);
  const gray = new Uint8Array(execFileSync("ffmpeg", ["-v", "error", "-i", img, "-f", "rawvideo", "-pix_fmt", "gray", "-"]));
  const lines = report.lines.map((y: number) => y - report.rect.y);
  const tokens = findTokens(gray, w, h, lines);
  const lay = layOut(gray, w, h, tokens, lines);
  const raw = join("/tmp", `lay${k}.gray`);
  writeFileSync(raw, lay.gray);
  const png = join("/tmp", `lay${k}.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${lay.w}x${lay.h}`, "-i", raw, png]);
  // Per-character boxes (like the phone's reader gives); origin bottom-left.
  const box = execFileSync("tesseract", [png, "-", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789xX", "makebox"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  const chars: ReadChar[] = [];
  for (const row of box.split("\n")) {
    const c = row.split(" ");
    if (c.length < 5) continue;
    const [l, b, rr, t] = c.slice(1, 5).map(Number);
    chars.push({ c: c[0], x: l, y: lay.h - t, w: rr - l, h: t - b });
  }
  const frets = readTokens(lay, chars);
  out.push({ k, t: r.t, notes: tokens.map((tk, i) => `${tk.string}/${frets[i] ?? "?"}@${Math.round(tk.x0)}`).join(" ") });
}
writeFileSync(process.env.OUT ?? "/tmp/glyph-check.json", JSON.stringify(out, null, 1));
console.log(out.map((o) => `${o.k} ${o.t.toFixed(1)}: ${o.notes}`).join("\n"));
