import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { charsToNotes, columns, commonStaff, cursorX, findPages, findStaff, staffRect, timeColumns, type FrameFeatures } from "../../src/scan/vision";

/** A PNG as grey bytes at `width` (like the phone's overview frames). */
function grey(file: string, width = 640): { g: Uint8Array; w: number; h: number } | null {
  try {
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim();
    const [W, H] = probe.split(",").map(Number);
    const h = Math.round((H * width) / W);
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${width}:${h}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    return { g: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), w: width, h };
  } catch {
    return null;
  }
}

const f1 = grey("tests/fixtures/frames/love-story-1.png");
const f2 = grey("tests/fixtures/frames/love-story-2.png");

describe.skipIf(!f1 || !f2)("finding the tab staff in real frames (Love Story, yunus guitarist)", () => {
  it("finds six evenly spaced lines near the bottom, not the guitar strings", () => {
    for (const f of [f1!, f2!]) {
      const s = findStaff(f.g, f.w, f.h);
      expect(s, "staff").not.toBeNull();
      expect(s!.lines[0]).toBeGreaterThan(f.h * 0.8); // the tab band, not the fretboard
      expect(s!.spacing).toBeGreaterThan(4);
      expect(s!.x1 - s!.x0).toBeGreaterThan(f.w * 0.8);
    }
  });

  it("agrees across frames and maps to video pixels", () => {
    // (the two screenshots were cropped slightly differently, so use one twice)
    const one = findStaff(f1!.g, f1!.w, f1!.h);
    const s = commonStaff([one, one, findStaff(f2!.g, f2!.w, f2!.h), null]);
    expect(s).not.toBeNull();
    const r = staffRect(s!, 1280 / 640, 1280, 720);
    expect(r.y + r.h).toBeLessThanOrEqual(720);
    expect(r.w).toBeGreaterThan(1000);
  });

  it("finds nothing in a frame without tab", () => {
    // the guitar part only (top 60% of the frame)
    const top = f1!.g.slice(0, f1!.w * Math.floor(f1!.h * 0.6));
    expect(findStaff(top, f1!.w, Math.floor(f1!.h * 0.6))).toBeNull();
  });
});

describe("cursor, pages and timing", () => {
  const blank = (n: number, v: number) => new Uint8Array(n).fill(v);
  const frame = (t: number, cursorAt: number | null, page: number): FrameFeatures => {
    const u = blank(480, 128);
    for (let i = 0; i < 160; i++) u[i] = 110; // yellow highlight on the left
    if (cursorAt !== null) for (let i = -1; i <= 1; i++) u[Math.max(0, Math.round(cursorAt * 479) + i)] = 170; // blue line on top
    const m = blank(256, 230);
    for (let k = 0; k < 8; k++) m[(page * 7 + k * 5) % 256] = 60; // the page's digits
    return { t, y: blank(480, 225), u, m };
  };

  it("finds the cursor, ignores the yellow highlight", () => {
    expect(cursorX(frame(0, 0.25, 0).u)).toBeCloseTo(0.25, 2);
    expect(cursorX(frame(0, null, 0).u)).toBeNull();
  });

  it("splits pages when the digits change, not when the cursor moves", () => {
    const frames: FrameFeatures[] = [];
    for (let i = 0; i < 40; i++) frames.push(frame(i * 0.25, (i % 20) / 20, Math.floor(i / 20)));
    const pages = findPages(frames);
    expect(pages.length).toBe(2);
    expect(pages[0].start).toBe(0);
    expect(pages[1].start).toBe(5);
    expect(pages[0].cursor.length).toBe(20);
  });

  it("times columns by when the cursor reaches them", () => {
    const rect = { x: 0, y: 0, w: 1000, h: 100 };
    const page = { start: 10, end: 14, readAt: 12, thumb: new Uint8Array(), cursor: [0, 1, 2, 3, 4].map((k) => ({ t: 10 + k, x: k * 0.25 })) };
    const cols = [[{ string: 1, fret: 0, x: 250 }], [{ string: 2, fret: 3, x: 625 }]];
    const t = timeColumns(cols, page, rect);
    expect(t[0].t).toBeCloseTo(11, 2);
    expect(t[1].t).toBeCloseTo(12.5, 2);
    expect(t[0].timed).toBe(true);
    const still = { ...page, cursor: [] };
    expect(timeColumns(cols, still, rect).map((x) => x.t)).toEqual([11, 13]);
  });
});

describe("characters → notes", () => {
  const lines = [100, 110, 120, 130, 140, 150]; // e B G D A E
  const ch = (c: string, x: number, line: number) => ({ c, x, y: lines[line] - 4, w: 6, h: 8 });

  it("puts digits on their strings, joins two-digit frets, reads O as 0", () => {
    const notes = charsToNotes(
      [ch("3", 50, 5), ch("0", 80, 3), ch("O", 120, 0), ch("1", 160, 1), ch("2", 167, 1), ch("G", 40, 0)].concat([
        { c: "D", x: 300, y: 70, w: 8, h: 9 }, // a chord name above the staff
      ]),
      lines,
    );
    expect(notes.map((n) => [n.string, n.fret])).toEqual([
      [6, 3],
      [4, 0],
      [1, 0],
      [2, 12],
    ]);
  });

  it("stacked digits form one column", () => {
    const notes = charsToNotes([ch("2", 100, 3), ch("0", 101, 4), ch("3", 140, 2)], lines);
    expect(columns(notes, 10).map((c) => c.length)).toEqual([2, 1]);
  });
});

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

/** Tab-area measurements of Aaditya's two screen recordings, made like the phone does. */
function recorded(name: string): FrameFeatures[] {
  const j = JSON.parse(gunzipSync(readFileSync(`tests/fixtures/frames/${name}.features.json.gz`)).toString()) as {
    frames: { t: number; y: string; u: string; v?: string; m: string }[];
  };
  const dec = (s?: string) => (s ? new Uint8Array(Buffer.from(s, "base64")) : undefined);
  return j.frames.map((f) => ({ t: f.t, y: dec(f.y)!, u: dec(f.u)!, v: dec(f.v), m: dec(f.m)! }));
}

describe("pages and cursor in real lesson videos", () => {
  it("Love Story: a page every ~6.5 s, the blue cursor sweeping across each", () => {
    const pages = findPages(recorded("love-story")).filter((p) => p.start >= 1.4 && p.end <= 78.6);
    expect(pages.length).toBe(12);
    for (const p of pages) {
      expect(p.end - p.start).toBeGreaterThan(5);
      expect(p.end - p.start).toBeLessThan(7.5);
      const c = p.cursor;
      expect(c[c.length - 1].x - c[0].x, `page at ${p.start}`).toBeGreaterThan(0.6);
    }
  });

  it("the same line played twice is two pages, one per cursor sweep", () => {
    const all = recorded("love-story");
    const one = findPages(all).find((p) => p.start > 7 && p.start < 9)!;
    const fs = all.filter((f) => f.t >= one.start && f.t < one.end);
    const len = one.end - one.start;
    const twice = [...fs, ...fs.map((f) => ({ ...f, t: f.t + len }))];
    const pages = findPages(twice);
    expect(pages.length).toBe(2);
    expect(Math.abs(pages[1].start - (one.start + len))).toBeLessThan(0.6);
    for (const p of pages) expect(p.cursor[p.cursor.length - 1].x - p.cursor[0].x).toBeGreaterThan(0.6);
  });

  it("Believer: pages of 3–5.5 s, the pale cyan cursor found on most", () => {
    const pages = findPages(recorded("believer"));
    const full = pages.filter((p) => p.end - p.start > 3);
    expect(full.length).toBeGreaterThanOrEqual(12);
    const moving = full.filter((p) => p.cursor.length >= 3 && p.cursor[p.cursor.length - 1].x - p.cursor[0].x > 0.2);
    expect(moving.length).toBeGreaterThanOrEqual(10);
  });
});

import { ocrPlan } from "../../src/scan/scan";
describe("how the tab is read", () => {
  it("normal digits: one picture at 2× (as in v0.4.0)", () => {
    expect(ocrPlan(16, 1260)).toEqual({ scale: 2, tiles: 1 });
  });
  it("small digits: enlarged more, in pieces about 1600 px wide", () => {
    const p = ocrPlan(9, 1260);
    expect(p.scale).toBeGreaterThan(3);
    expect((1260 * p.scale) / p.tiles).toBeLessThanOrEqual(1600);
  });
});
