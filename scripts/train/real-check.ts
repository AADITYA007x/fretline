// Dev tool: run the digit reader over pictures from a "Send reading
// details" zip and draw what it read under each picture.
// Usage: node real-check.mjs <unzipped dir> <reading indexes> OUT.png
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { background, findAll } from "../../src/scan/glyphs";
import { best, classify, vectorize, type Model } from "../../src/scan/digits";

const [dir, idxArg, out] = process.argv.slice(2);
const model: Model = JSON.parse(readFileSync("src/scan/digits-model.json", "utf8"));
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const rows: string[] = [];
for (const k of idxArg.split(",").map(Number)) {
  const r = report.readings[k];
  const img = join(dir, r.image);
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", img]).toString().trim().split(",").map(Number);
  const gray = new Uint8Array(execFileSync("ffmpeg", ["-v", "error", "-i", img, "-f", "rawvideo", "-pix_fmt", "gray", "-"]));
  const lines = report.lines.map((y: number) => y - report.rect.y);
  const sp = (lines[5] - lines[0]) / 5;
  const bg = background(gray);
  const { tokens } = findAll(gray, w, h, lines);
  const labels = tokens.map((t) => {
    const reads = t.parts.map((p) => best(classify(model, vectorize(gray, w, p, bg, sp))));
    return { x: t.x0, y: t.y0, text: reads.map((r) => r.c).join(""), p: Math.min(...reads.map((r) => r.p)) };
  });
  rows.push(JSON.stringify({ image: img, w, h, labels }));
}
writeFileSync(out + ".json", rows.join("\n"));
