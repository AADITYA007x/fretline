import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { wordsFromJson3 } from "../../src/lessons/captions";
import { notesFromSpeech } from "../../src/tabs/speech";
import { fromSpoken, together, type TabNote } from "../../src/tabs/tab";
import { sameTelling, toSteps } from "../../src/tabs/steps";

const n = (t: number, string: number, fret: number, extra: Partial<TabNote> = {}): TabNote => ({ id: `${t}-${string}`, t, string, fret, source: "speech", ...extra });
/** A telling: notes named a few seconds apart, starting at `t0`. */
const telling = (t0: number, frets: [number, number][]) => frets.map(([string, fret], i) => n(t0 + i * 3, string, fret));

describe("steps from a talk-through lesson", () => {
  const A: [number, number][] = [[3, 2], [3, 4], [3, 7], [2, 5]];
  const B: [number, number][] = [[4, 0], [3, 2], [2, 3], [1, 2], [2, 3]];

  it("a phrase he goes over again and again is one step, with every telling's moment", () => {
    const notes = [...telling(10, A), ...telling(40, A), ...telling(70, B), ...telling(110, A), ...telling(140, B)];
    const steps = toSteps(notes);
    expect(steps.map((s) => s.n)).toEqual([1, 2]);
    expect(steps[0].tellings.map((t) => t.start)).toEqual([10, 40, 110]);
    expect(steps[1].tellings.map((t) => t.start)).toEqual([70, 140]);
    expect(steps[0].notes.map((x) => `${x.fret}/${x.string}`)).toEqual(["2/3", "4/3", "7/3", "5/2"]);
    expect(steps[0].t).toBe(10);
    expect(steps[0].end).toBe(19);
  });

  it("a misheard note in one telling doesn't make a new step, and isn't the one shown", () => {
    const wrong: [number, number][] = [[4, 0], [3, 2], [2, 3], [1, 3], [2, 3]]; // "third fret" heard for "second"
    const steps = toSteps([...telling(10, wrong), ...telling(50, B), ...telling(90, B)]);
    expect(steps).toHaveLength(1);
    expect(steps[0].tellings).toHaveLength(3);
    expect(steps[0].notes.map((x) => x.fret)).toEqual([0, 2, 3, 2, 3]);
    expect(steps[0].t).toBe(50); // the first telling that says it the usual way
  });

  it("short phrases must match exactly; a note said in passing is no step", () => {
    expect(sameTelling(["3:2", "3:4", "3:7"], ["3:2", "3:4", "3:7"])).toBe(true);
    expect(sameTelling(["3:2", "3:4", "3:7"], ["3:2", "3:5", "3:7"])).toBe(false);
    expect(sameTelling(["3:2", "3:4"], ["3:2", "3:4", "3:7", "2:5", "2:7", "1:0"])).toBe(false);
    const steps = toSteps([...telling(10, A), n(60, 1, 3), ...telling(100, B)]);
    expect(steps).toHaveLength(2);
  });

  it("first the first half, then the second, then all of it: three steps", () => {
    const all = [...A, ...B];
    const steps = toSteps([...telling(10, A), ...telling(50, B), ...telling(100, all)]);
    expect(steps.map((s) => s.notes.length)).toEqual([4, 5, 9]);
  });

  it("notes said together are one moment", () => {
    const notes = [n(10, 3, 2), n(13, 4, 2, { chord: 1 }), n(13.6, 3, 2, { chord: 1 }), n(16, 2, 3)];
    expect(together(notes).map((g) => g.length)).toEqual([1, 2, 1]);
    const again = notes.map((x) => ({ ...x, id: x.id + "b", t: x.t + 40, chord: x.chord ? 2 : undefined }));
    expect(toSteps([...notes, ...again])).toHaveLength(1);
  });

  it("his words come with each step", () => {
    const steps = toSteps(telling(10, A), (from, to) => `words ${from}-${to}`);
    expect(steps[0].words).toBe("words 8-22");
  });

  it("the lesson fixture (the same intro explained twelve times) is one step", () => {
    const { words } = wordsFromJson3(readFileSync("tests/fixtures/lesson-captions.json3", "utf8"));
    const notes = fromSpoken(notesFromSpeech(words));
    const steps = toSteps(notes, (from, to) => words.filter((w) => w.t >= from && w.t <= to).map((w) => w.w).join(" "));
    expect(steps).toHaveLength(1);
    expect(steps[0].tellings.length).toBeGreaterThanOrEqual(12);
    expect(steps[0].notes.map((x) => `${x.fret}/${x.string}`)).toEqual(["2/3", "4/3", "7/3"]);
    expect(steps[0].words).toContain("third string second fret with index");
  });
});
