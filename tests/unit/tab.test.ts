import { describe, expect, it } from "vitest";
import { applyFixes, columnAt, emptyFixes, fretLabel, fromSpoken, phraseAt, toPhrases } from "../../src/tabs/tab";

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
