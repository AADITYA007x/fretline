// The whole tab reader on a real frame, with Tesseract standing in for the
// phone's ML Kit (skipped when Tesseract isn't installed, e.g. in CI).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTab } from "../../src/scan/clean";
import { charsToNotes, columns, findStaff, staffRect, type OcrChar } from "../../src/scan/vision";

const has = (cmd: string) => {
  try {
    execFileSync(cmd, [cmd === "ffmpeg" ? "-version" : "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function readFrame(file: string): string[] {
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim();
  const [W, H] = probe.split(",").map(Number);
  const ow = 640;
  const oh = Math.round((H * ow) / W);
  const small = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${ow}:${oh}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const staff = findStaff(new Uint8Array(small), ow, oh)!;
  const scale = W / ow;
  const r = staffRect(staff, scale, W, H);
  const lines = staff.lines.map((y) => y * scale);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const clean = cleanTab(new Uint8Array(raw), r.w, r.h, lines.map((y) => y - r.y));
  const dir = mkdtempSync(join(tmpdir(), "tab-"));
  writeFileSync(join(dir, "a.gray"), clean);
  const S = 3;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${r.w}x${r.h}`, "-i", join(dir, "a.gray"), "-vf", `scale=iw*${S}:ih*${S}:flags=bicubic`, join(dir, "a.png")]);
  const tsv = execFileSync("tesseract", [join(dir, "a.png"), "-", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789", "tsv"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  const chars: OcrChar[] = [];
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5" || !c[11].trim()) continue;
    const [left, top, width, height] = c.slice(6, 10).map(Number);
    const text = c[11].trim();
    const cw = width / text.length;
    [...text].forEach((ch, i) => chars.push({ c: ch, x: r.x + (left + i * cw) / S, y: r.y + top / S, w: cw / S, h: height / S }));
  }
  return columns(charsToNotes(chars, lines), staff.spacing * scale).flatMap((col) => col.map((n) => `${n.string}:${n.fret}`));
}

/** How many of `want` appear in `got` in the same order (longest common subsequence). */
function matched(got: string[], want: string[]): number {
  const d = Array.from({ length: got.length + 1 }, () => new Array(want.length + 1).fill(0));
  for (let i = 1; i <= got.length; i++)
    for (let j = 1; j <= want.length; j++)
      d[i][j] = got[i - 1] === want[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
  return d[got.length][want.length];
}

describe.skipIf(!has("tesseract") || !has("ffmpeg"))("reading a real tab frame (Love Story, bars 6–8)", () => {
  it("reads most notes right, in order", () => {
    const bar = (first: string) => [first, "3:2", "1:0", "2:3", "1:0", "2:3", "3:2", "2:3"];
    const want = [...bar("4:0"), ...bar("4:0"), ...bar("5:0")];
    const got = readFrame("tests/fixtures/frames/love-story-2.png");
    const ok = matched(got, want);
    // Tesseract is weaker than ML Kit on these; this guards the pipeline.
    expect(ok / want.length, `got ${got.join(" ")}`).toBeGreaterThan(0.75);
    expect(got.length).toBeLessThan(want.length * 1.3);
  });
});
