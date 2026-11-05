// Turn made-up tab strips (gen_tab.py) into examples for the digit reader:
// find the marks exactly the way the app does, and label each from the
// truth. Usage: node extract.mjs DIR OUT.bin
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { background, findAll } from "../../src/scan/glyphs";
import { CLASSES, SIZE, vectorize } from "../../src/scan/digits";

const [dir, out, missOut] = process.argv.slice(2);
const missed: { image: string; x: number; y: number; sp: number; text: string; why: string }[] = [];
const items: { image: string; lines: number[]; spacing: number; truth: { string: number; x: number; text: string }[] }[] = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8"));
const D = SIZE * SIZE + 2;
const vecs: Float32Array[] = [];
const labels: number[] = [];
let skipped = 0;
let truthAll = 0;
let truthFound = 0;
for (const it of items) {
  const file = join(dir, it.image);
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim().split(",").map(Number);
  const gray = new Uint8Array(execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"]));
  const bg = background(gray);
  const { tokens } = findAll(gray, w, h, it.lines);
  const used = new Set<number>();
  truthAll += it.truth.length;
  const tokensAll = tokens;
  for (const t of tokens) {
    const cx = (t.x0 + t.x1) / 2;
    const k = it.truth.findIndex((g, i) => !used.has(i) && g.string === t.string && Math.abs(g.x - cx) < it.spacing * 0.6);
    let texts: string[];
    // a two-digit fret found as two separate marks: each is one of its digits
    const two = it.truth.find((g) => g.string === t.string && g.text.length === 2 && Math.abs(g.x - cx) < it.spacing * 0.9);
    if (two && t.parts.length === 1) {
      texts = [cx < two.x ? two.text[0] : two.text[1]];
    } else if (k < 0) {
      // not a digit, unless it's right by one (then it's a piece of one: leave it out)
      const near = it.truth.some((g) => g.string === t.string && Math.abs(g.x - cx) < it.spacing * 1.0);
      texts = near ? [] : t.parts.map(() => "-");
    } else {
      used.add(k);
      truthFound++;
      const g = it.truth[k];
      if (g.text === "x") texts = t.parts.length === 1 ? ["x"] : [];
      else texts = g.text.length === t.parts.length ? [...g.text] : [];
    }
    if (!texts.length) {
      skipped++;
      continue;
    }
    t.parts.forEach((p, i) => {
      vecs.push(vectorize(gray, w, p, bg, it.spacing));
      labels.push(CLASSES.indexOf(texts[i] as (typeof CLASSES)[number]));
    });
  }
  it.truth.forEach((g, i) => {
    if (used.has(i)) return;
    const near = tokensAll.find((t) => Math.abs((t.x0 + t.x1) / 2 - g.x) < it.spacing * 0.6);
    missed.push({ image: it.image, x: g.x, y: it.lines[g.string - 1], sp: it.spacing, text: g.text, why: near ? `token on string ${near.string}` : "none" });
  });
}
if (missOut) writeFileSync(missOut, JSON.stringify(missed));
const buf = Buffer.alloc(4 + vecs.length * (D * 4 + 1));
buf.writeUInt32LE(vecs.length, 0);
let o = 4;
vecs.forEach((v, i) => {
  for (let j = 0; j < D; j++, o += 4) buf.writeFloatLE(v[j], o);
  buf.writeUInt8(labels[i], o++);
});
writeFileSync(out, buf);
const count = CLASSES.map((c, i) => `${c}:${labels.filter((l) => l === i).length}`).join(" ");
console.log(`examples ${vecs.length} (skipped tokens ${skipped}) ${count}`);
console.log(`marks found: ${truthFound} of ${truthAll} (${((100 * truthFound) / Math.max(1, truthAll)).toFixed(1)}%)`);
