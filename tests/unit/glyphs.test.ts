// Finding the digits in real tab pictures (Believer, from the phone's
// "Send reading details"), laying them out, and reading them back.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { findAll, findTokens, layOut, notesFromArea, readTokens, type ReadChar } from "../../src/scan/glyphs";

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
    expect(readTokens(lay, chars).map((r) => r?.fret)).toEqual(lay.slots.map((_, i) => i % 10));
    expect(readTokens(lay, [{ ...chars[0], c: "X" }])[0]).toEqual({ fret: 0, mute: true });
    expect(readTokens(lay, [{ ...chars[0], c: "<" }, { ...chars[0], c: "7" }])[0]).toEqual({ fret: 7, harmonic: true });
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
    expect(readTokens(lay, chars)[0]?.fret).toBe(2);
  });
});

describe("digits touching their stems", () => {
  it("a 0 with its stem hanging from it is still found, on its string", () => {
    const w = 120;
    const h = 150;
    const g = new Uint8Array(w * h).fill(250);
    const lines = [20, 40, 60, 80, 100, 120];
    for (const y of lines) for (let x = 0; x < w; x++) g[y * w + x] = 190; // grey staff lines
    // a "0" (ring 12 wide, 16 tall) on the G line, and its stem down to the bottom
    for (let y = 52; y <= 67; y++)
      for (let x = 44; x <= 55; x++) {
        const dx = (x - 49.5) / 6;
        const dy = (y - 59.5) / 8;
        const r = dx * dx + dy * dy;
        if (r <= 1 && r >= 0.45) g[y * w + x] = 20;
      }
    for (let y = 68; y < 140; y++) g[y * w + 49] = g[y * w + 50] = 20;
    const tokens = findTokens(g, w, h, lines);
    expect(tokens.length).toBe(1);
    expect(tokens[0].string).toBe(3);
    expect(tokens[0].y1).toBeLessThan(72);
  });
});

describe("the symbols around the digits", () => {
  const all = (name: string) => findAll(pic(name), W, H, LINES);
  it("slide marks: \"3/5\" and \"2/4\" at the start of bar 7, \"1/5\" ×3 in bar 10", () => {
    const slid = all("believer-bar7").tokens.filter((t) => t.tech === "slide");
    expect(slid.filter((t) => t.x0 > 80 && t.x0 < 100).map((t) => t.string).sort()).toEqual([2, 3]);
    expect(slid.filter((t) => t.x0 > 1000).map((t) => t.string).sort()).toEqual([1, 2, 3]);
  });
  it("arcs over \"3⌒1\" (bar 80): marked on the second note", () => {
    const arcs = all("believer-bar80").tokens.filter((t) => t.tech === "hammer");
    expect(arcs.length).toBe(3);
    for (const t of arcs) expect(t.string).toBe(2);
  });
  it("a strum arrow by the chord in bar 34", () => {
    const f = all("believer-bar31");
    expect(f.arrows).toEqual([expect.objectContaining({ dir: "up" })]);
    expect(f.tokens.filter((t) => t.strum === "up").map((t) => t.string).sort()).toEqual([2, 3, 4, 5]);
  });
  it("an arc going down the neck (3⌒1) is a pull-off", async () => {
    const toks = all("believer-bar80").tokens;
    const notes = await notesFromArea({ gray: pic("believer-bar80"), w: W, h: H, x: 0, y: 0 }, LINES, async (lay) =>
      lay.slots.map((s, i) => ({ c: toks[i].tech === "hammer" ? "1" : "3", x: s.x0 + 2, y: s.y0 + 4, w: s.x1 - s.x0 - 4, h: s.y1 - s.y0 - 8 })),
    );
    expect(notes.filter((n) => n.tech === "pull").length).toBe(3);
  });
});

describe("digits joined by stems and beams (Love Story's tab)", () => {
  it("two 0s whose stems meet in a beam are both found", () => {
    const w = 160;
    const h = 170;
    const g = new Uint8Array(w * h).fill(250);
    const lines = [20, 40, 60, 80, 100, 120];
    for (const y of lines) for (let x = 0; x < w; x++) g[y * w + x] = 190;
    const zero = (cx: number, cy: number) => {
      for (let y = cy - 8; y <= cy + 8; y++)
        for (let x = cx - 6; x <= cx + 6; x++) {
          const r = ((x - cx) / 6) ** 2 + ((y - cy) / 8) ** 2;
          if (r <= 1 && r >= 0.45) g[y * w + x] = 20;
        }
      for (let y = cy + 8; y <= 150; y++) g[y * w + cx] = g[y * w + cx + 1] = 20; // stem down
    };
    zero(40, 20); // high e
    zero(100, 80); // D
    for (let y = 148; y <= 151; y++) for (let x = 40; x <= 101; x++) g[y * w + x] = 20; // beam
    const tokens = findTokens(g, w, h, lines);
    expect(tokens.map((t) => t.string)).toEqual([1, 4]);
    expect(tokens.every((t) => t.marks === 1)).toBe(true);
  });
});

import { best, classify, vectorize, type Model } from "../../src/scan/digits";
import { background } from "../../src/scan/glyphs";
describe("our own digit reader on real lesson tab", () => {
  const model: Model = JSON.parse(readFileSync("src/scan/digits-model.json", "utf8"));
  const readAll = (g: Uint8Array, w: number, h: number, lines: number[]) => {
    const sp = (lines[5] - lines[0]) / 5;
    const bg = background(g);
    return findTokens(g, w, h, lines).map((t) => {
      const r = t.parts.map((p) => best(classify(model, vectorize(g, w, p, bg, sp))));
      return { string: t.string, x: t.x0, text: r.map((q) => q.c).join(""), p: Math.min(...r.map((q) => q.p)) };
    });
  };
  it("Love Story bars 9–11: every note found and read right (0s, 2s and 3s)", () => {
    const g = new Uint8Array(gunzipSync(readFileSync("tests/fixtures/frames/love-story-bars9-11.1258x120.gray.gz")));
    const lines = [600, 616, 630, 646, 662, 678].map((y) => y - 579);
    const got = readAll(g, 1258, 120, lines).filter((r) => r.text !== "-" && r.p >= 0.85);
    expect(got.map((r) => r.text).join(" ")).toBe("0 2 0 3 0 3 2 3 2 2 0 3 0 3 2 3 2 2 0 3 0 3 2 3");
  });
  it("Believer bar 31: the 8/5/5 and 7/5/5 chords", () => {
    const got = readAll(pic("believer-bar31"), W, H, LINES).filter((r) => r.x > 90 && r.x < 350 && r.string <= 3);
    const top = got.filter((r) => r.string === 1).map((r) => r.text);
    expect(top).toEqual(["8", "8", "7", "5", "8", "8", "7", "5"]);
    expect(got.filter((r) => r.string > 1).every((r) => r.text === "5")).toBe(true);
  });
});

import { chordsFromChars } from "../../src/scan/glyphs";

describe("chord names above the tab", () => {
  // Boxes the reader gave on Believer's band (enlarged 2×): "Am", and
  // "Fmaj7" with the bar number "19" sitting under its letters.
  const box = (c: string, l: number, b: number, r: number, t: number) => ({ c, x: l, y: 124 - t, w: r - l, h: t - b });
  const chars: ReadChar[] = [
    box("A", 556, 70, 584, 100), box("m", 586, 70, 618, 92),
    box("F", 1730, 70, 1752, 100), box("m", 1754, 70, 1786, 92), box("a", 1776, 60, 1797, 102), box("j", 1788, 60, 1816, 102), box("7", 1822, 70, 1840, 100),
    box("1", 1716, 0, 1718, 16), box("9", 1730, 6, 1738, 16), box("1", 1092, 0, 1094, 16),
  ];
  it("joins letters into names, even with a bar number under them", () => {
    expect(chordsFromChars(chars, { gray: new Uint8Array(0), w: 0, h: 0, x: 0, y: 0 }).map((c) => c.name)).toEqual(["Am", "Fmaj7"]);
  });
});
