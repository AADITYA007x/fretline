import { describe, expect, it } from "vitest";
import { bookShape, chordBoxSvg, chordSheetHtml, describeShape } from "../../src/tabs/chords";
import { toCells } from "../../src/tabs/notebook";
import type { TabNote } from "../../src/tabs/tab";

const n = (t: number, string: number, fret: number, extra: Partial<TabNote> = {}): TabNote => ({ id: `${t}-${string}`, t, string, fret, source: "screen", ...extra });

describe("chord shapes", () => {
  it("knows the usual open shapes (string 1 first)", () => {
    expect(bookShape("Am")).toEqual([0, 1, 2, 2, 0, -1]);
    expect(bookShape("Fmaj7")).toEqual([0, 1, 2, 3, -1, -1]);
    expect(bookShape("E7")).toEqual([0, 0, 1, 0, 2, 0]);
    expect(bookShape("Xyz")).toBeNull();
  });
  it("draws a box with finger numbers, × and ○", () => {
    const svg = chordBoxSvg([0, 1, 2, 2, 0, -1]);
    expect(svg).toContain("cb-mark");
    expect((svg.match(/class="cb-dot"/g) ?? []).length).toBe(3);
    expect((svg.match(/class="cb-open"/g) ?? []).length).toBe(2);
    expect(describeShape([0, 1, 2, 2, 0, -1])).toBe("D fret 2, G fret 2, B fret 1 · open A e");
  });
  it("a chord name gets the shape as played here, from the notes while it lasts", () => {
    const notes = [n(1, 5, 0), n(1.3, 3, 2), n(1.6, 2, 1), n(1.9, 1, 0), n(2.2, 3, 2), n(2.5, 4, 2), n(5, 5, 3)];
    const cells = toCells(notes, [{ t: 1, name: "Am" }, { t: 5, name: "C" }]);
    expect(cells[0].chordShape).toEqual([0, 1, 2, 2, 0, -1]);
    // same as the book: only one box
    expect((chordSheetHtml("Am", cells[0].chordShape!).match(/<figure/g) ?? []).length).toBe(1);
  });
  it("a held shape carries its frets", () => {
    const cells = toCells([n(1, 5, 3, { strum: "down" }), n(1, 4, 2), n(1, 3, 0), n(1, 2, 1)]);
    expect(cells[0].shape).toEqual([-1, 1, 0, 2, 3, -1]);
  });
});
