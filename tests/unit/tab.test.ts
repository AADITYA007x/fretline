import { describe, expect, it } from "vitest";
import { applyFixes, columnAt, emptyFixes, fretLabel, fromSpoken, phraseAt, toPhrases, type TabNote } from "../../src/tabs/tab";

const spoken = [
  { t: 10, string: 4, fret: 2, said: "a" },
  { t: 12, string: 5, fret: 3, said: "b" },
  { t: 13, string: 3, fret: 0, chord: 1, said: "c" },
  { t: 13.3, string: 2, fret: 1, chord: 1, said: "d" },
  { t: 40, string: 1, fret: 3, said: "e" },
];

describe("tab", () => {
  const base = fromSpoken(spoken);

  it("gives notes stable ids", () => {
    expect(base.map((n) => n.id)).toEqual(["s100-4", "s120-5", "s130-3", "s133-2", "s400-1"]);
    expect(fromSpoken([spoken[0], spoken[0]]).map((n) => n.id)).toEqual(["s100-4", "s100-4-1"]);
  });

  it("applies fixes: edit, delete, add", () => {
    const f = emptyFixes();
    f.edits["s100-4"] = { fret: 4 };
    f.edits["s400-1"] = "deleted";
    f.added.push({ id: "u1", t: 11, string: 6, fret: 0, source: "you" });
    const notes = applyFixes(base, f);
    expect(notes.map((n) => `${n.string}:${n.fret}`)).toEqual(["4:4", "6:0", "5:3", "3:0", "2:1"]);
  });

  it("groups into columns and phrases", () => {
    const phrases = toPhrases(applyFixes(base, emptyFixes()));
    expect(phrases.length).toBe(2);
    expect(phrases[0].columns.map((c) => c.notes.length)).toEqual([1, 1, 2]);
    expect(phraseAt(phrases, 5)).toEqual({ index: 0, upcoming: true });
    expect(phraseAt(phrases, 12.5)).toEqual({ index: 0, upcoming: false });
    expect(phraseAt(phrases, 30)).toEqual({ index: 1, upcoming: true }); // long after: show what's next
    expect(phraseAt(phrases, 25)).toEqual({ index: 0, upcoming: false }); // just after: keep it
    expect(columnAt(phrases[0], 12.2)).toBe(1);
    expect(columnAt(phrases[0], 9)).toBe(-1);
  });

  it("writes techniques like tab", () => {
    expect(fretLabel({ fret: 4, tech: "hammer" })).toBe("h4");
    expect(fretLabel({ fret: 2, tech: "pull" })).toBe("p2");
    expect(fretLabel({ fret: 7, tech: "slide" })).toBe("/7");
    expect(fretLabel({ fret: 12, tech: "harmonic" })).toBe("<12>");
    expect(fretLabel({ fret: 3 })).toBe("3");
  });
});

import { combine } from "../../src/tabs/tab";

describe("combining what he says with the tab on screen", () => {
  it("uses the screen tab where it's shown, his words elsewhere", () => {
    const speech = fromSpoken([
      { t: 5, string: 4, fret: 2, said: "a" },
      { t: 30, string: 5, fret: 3, said: "b" },
    ]);
    const screen = {
      at: 1,
      notes: [{ id: "v280-6", t: 28, string: 6, fret: 3, source: "screen" as const }],
      pages: [{ start: 25, end: 40, notes: 1 }],
    };
    expect(combine(speech, screen).map((n) => `${n.source}:${n.string}:${n.fret}`)).toEqual(["speech:4:2", "screen:6:3"]);
    expect(combine(speech, undefined)).toBe(speech);
  });
});

describe("phrases follow the video's tab pages", () => {
  const n = (t: number, fret: number): TabNote => ({ id: `n${t}`, t, string: 2, fret, source: "screen" });
  it("each page is its own phrase, shown from the moment the page appears", () => {
    // Pages 10–16.5 and 16.5–23, notes close together across the change.
    const notes = [n(10.5, 1), n(12, 3), n(16, 1), n(16.8, 0), n(18, 3), n(22.5, 1)];
    const ph = toPhrases(notes, 7, [10, 16.5, 16.5, 23]);
    expect(ph.map((p) => p.columns.length)).toEqual([3, 3]);
    expect(ph[1].start).toBe(16.5);
    expect(phraseAt(ph, 16.6)).toEqual({ index: 1, upcoming: false });
    expect(columnAt(ph[1], 16.6)).toBe(-1);
  });
  it("his words after the tab ends start a new phrase", () => {
    const said: TabNote = { id: "s", t: 25, string: 1, fret: 5, source: "speech" };
    const ph = toPhrases([n(20, 1), said], 7, [16.5, 23]);
    expect(ph.length).toBe(2);
  });
});
