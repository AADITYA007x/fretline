import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { notebookLines, toCells, toLines, toPrintHtml, toText } from "../../src/tabs/notebook";
import type { TabNote } from "../../src/tabs/tab";

const n = (t: number, string: number, fret: number, extra: Partial<TabNote> = {}): TabNote => ({ id: `${t}-${string}`, t, string, fret, source: "screen", ...extra });

describe("notebook style", () => {
  it("fret over string, + for together, slides from the fret before", () => {
    const cells = toCells([n(1, 1, 5), n(2, 2, 3), n(2.5, 2, 5, { tech: "slide" }), n(3, 4, 2), n(3.01, 3, 0), n(4, 1, 7, { tech: "hammer" }), n(5, 1, 5, { tech: "pull" })]);
    expect(cells.map((c) => [c.top, c.bottom])).toEqual([
      ["5", "1"],
      ["3", "2"],
      ["3→5", "2"],
      ["2+0", "4+3"],
      ["7", "1"],
      ["5", "1"],
    ]);
    expect(cells[4].hammer).toBe(true);
    expect(cells[5].mark).toBe("pull");
  });

  it("a strummed chord: the held shape once, then roll over the strings", () => {
    const chord = (t: number) => [n(t, 5, 3, { strum: "down" }), n(t, 4, 2), n(t, 3, 0), n(t, 2, 1)];
    const cells = toCells([...chord(1), ...chord(2)], [{ t: 1, name: "C" }]);
    expect(cells.map((c) => c.top)).toEqual(["[3 2 1 / 5 4 2]", "roll", "roll"]);
    expect(cells[1].bottom).toBe("5432");
    expect(cells[0].chord).toBe("C");
  });

  it("8–10 per line, numbered, broken at the longest pause", () => {
    const notes: TabNote[] = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += i % 9 === 8 ? 1.2 : 0.3;
      notes.push(n(t, 1 + (i % 3), i % 5));
    }
    const lines = notebookLines(notes);
    expect(lines.map((l) => l.n)).toEqual(lines.map((_, i) => i + 1));
    for (const l of lines.slice(0, -1)) expect(l.cells.length).toBeGreaterThanOrEqual(8), expect(l.cells.length).toBeLessThanOrEqual(10);
    expect(lines.flatMap((l) => l.cells).length).toBe(40);
  });

  it("a slap (the video's x's) is your hand sign, with what's played with it", () => {
    const cells = toCells([n(1, 1, 0, { tech: "mute" }), n(1, 2, 0, { tech: "mute" }), n(2, 1, 0, { tech: "mute" }), n(2, 2, 0, { tech: "mute" }), n(2, 3, 2), n(3, 6, 0, { tech: "mute" })]);
    expect(cells.map((c) => [c.top, c.bottom])).toEqual([
      ["✋", "21"],
      ["✋+2", "21+3"],
      ["✋", "6"],
    ]);
  });

  it("a slide out shows inside notes played together too", () => {
    const cells = toCells([n(1, 6, 0), n(1, 1, 7, { tech: "slideOut" })]);
    expect(cells[0].top).toBe("0+7↘");
  });

  it("a new chord or held shape starts a new line", () => {
    const notes = [0, 1, 2, 3, 4].map((k) => n(1 + k * 0.3, 1, k));
    const strum = [n(3, 5, 3, { strum: "down" }), n(3, 4, 2), n(3, 2, 1)];
    const after = [0, 1, 2].map((k) => n(3.3 + k * 0.3, 2, k));
    const named = [n(4.5, 1, 5), n(4.8, 1, 7)];
    const lines = notebookLines([...notes, ...strum, ...after, ...named], [{ t: 4.5, name: "G" }]);
    expect(lines.map((l) => l.cells[0].top)).toEqual(["0", "[3 2 1 / 5 4 2]", "5"]);
    expect(lines[2].chords).toEqual(["G"]);
  });

  it("a long pause starts a new line early", () => {
    const cells = toCells([n(1, 1, 0), n(1.3, 1, 1), n(1.6, 1, 2), n(1.9, 1, 3), n(6, 1, 4), n(6.3, 1, 5)]);
    expect(toLines(cells).map((l) => l.cells.length)).toEqual([4, 2]);
  });

  it("the real Love Story notes make a page you can print", () => {
    const notes = JSON.parse(readFileSync("tests/fixtures/love-story.notes.json", "utf8")) as TabNote[];
    const lines = notebookLines(notes.map((x, i) => ({ ...x, id: x.id ?? String(i), source: "screen" })));
    expect(lines.length).toBeGreaterThan(5);
    const html = toPrintHtml("Love Story", lines, [1, 2]);
    expect(html).toContain("<h1>Love Story</h1>");
    expect((html.match(/class="line"/g) ?? []).length).toBe(lines.length);
    const text = toText("Love Story", lines);
    expect(text.split("\n")[3]).toMatch(/^1\. \d+:\d\d {2}/);
  });
});
