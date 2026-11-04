// Finding the digits in real tab pictures (Believer, from the phone's
// "Send reading details"), laying them out, and reading them back.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { findTokens, layOut, notesFromArea, readTokens, type ReadChar } from "../../src/scan/glyphs";

const W = 1116;
const H = 134;
const LINES = [23, 41, 59, 77, 93, 111];
const pic = (name: string) => new Uint8Array(gunzipSync(readFileSync(`tests/fixtures/frames/${name}.1116x134.gray.gz`)));

describe("finding the digits on the staff", () => {
  it("bar 31: eight three-note chords, each digit on its own string", () => {
    const tokens = findTokens(pic("believer-bar31"), W, H, LINES);
    const chords = tokens.filter((t) => t.x0 > 90 && t.x0 < 350 && t.string <= 3);
    expect(chords.length).toBe(24);
    for (const s of [1, 2, 3]) expect(chords.filter((t) => t.string === s).length).toBe(8);
  });

  it("slide marks between frets aren't taken for digits", () => {
    const tokens = findTokens(pic("believer-bar7"), W, H, LINES);
    // "3 / 5" and "2 / 4" at the start of bar 7: four digits, no slashes
    const start = tokens.filter((t) => t.x0 > 40 && t.x0 < 100);
    expect(start.map((t) => t.string).sort()).toEqual([2, 2, 3, 3]);
  });

  it("the layout keeps one slot per digit, in order", () => {
    const g = pic("believer-bar31");
    const tokens = findTokens(g, W, H, LINES);
    const lay = layOut(g, W, H, tokens, LINES);
    expect(lay.slots.length).toBe(tokens.length);
    // A made-up reading: one character per slot, placed in its middle.
    const chars: ReadChar[] = lay.slots.map((s, i) => ({ c: String(i % 10), x: s.x0 + 2, y: s.y0 + 4, w: s.x1 - s.x0 - 4, h: s.y1 - s.y0 - 8 }));
    expect(readTokens(lay, chars)).toEqual(lay.slots.map((_, i) => i % 10));
    expect(readTokens(lay, [{ ...chars[0], c: "X" }])[0]).toBeNull();
  });
});

const hasTesseract = (() => {
  try {
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTesseract)("reading the laid-out digits (Tesseract standing in for ML Kit)", () => {
  it("bar 31 chords read right", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glyph-"));
    const notes = await notesFromArea({ gray: pic("believer-bar31"), w: W, h: H, x: 0, y: 0 }, LINES, async (lay) => {
      writeFileSync(join(dir, "l.gray"), lay.gray);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${lay.w}x${lay.h}`, "-i", join(dir, "l.gray"), join(dir, "l.png")]);
      const box = execFileSync("tesseract", [join(dir, "l.png"), "-", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789xX", "makebox"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      return box
        .split("\n")
        .map((r) => r.split(" "))
        .filter((c) => c.length >= 5)
        .map((c) => {
          const [l, b, r, t] = c.slice(1, 5).map(Number);
          return { c: c[0], x: l, y: lay.h - t, w: r - l, h: t - b };
        });
    });
    const want = [8, 8, 7, 5, 8, 8, 7, 5];
    const chordNotes = notes.filter((n) => n.x > 90 && n.x < 360 && n.string <= 3).sort((a, b) => a.x - b.x || a.string - b.string);
    let right = 0;
    chordNotes.forEach((n) => {
      const col = Math.round((n.x - 100) / 34.7);
      if ((n.string === 1 ? want[col] : 5) === n.fret) right++;
    });
    expect(right).toBeGreaterThanOrEqual(20);
  });
});

describe("one mark, one digit", () => {
  it("a single mark read as \"22\" (two neighbours run together) keeps one digit", () => {
    const g = pic("believer-bar31");
    const tokens = findTokens(g, W, H, LINES);
    const lay = layOut(g, W, H, tokens, LINES);
    const s = lay.slots[0];
    const mid = (s.x0 + s.x1) / 2;
    const chars: ReadChar[] = [
      { c: "2", x: mid - 6, y: s.y0 + 4, w: 8, h: 20 },
      { c: "2", x: mid + 3, y: s.y0 + 4, w: 8, h: 20 },
    ];
    expect(s.marks).toBe(1);
    expect(readTokens(lay, chars)[0]).toBe(2);
  });
});
