import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ladder } from "../../src/practice/ladder";
import { beatsBetween, estimateBeat, tapBpm } from "../../src/practice/tempo";
import { suggestFingers } from "../../src/practice/fingers";

describe("practice ladder", () => {
  it("1 by 1 → 0.25× with the pluck, then the video at 0.5×, 0.75×, 1×", () => {
    const s = ladder({ start: "step", goal: 1, pace: "normal", sound: "auto" });
    expect(s.map((x) => [x.speed, x.sound])).toEqual([
      ["step", "pluck"],
      [0.25, "pluck"],
      [0.5, "video"],
      [0.75, "video"],
      [1, "video"],
    ]);
    expect(s.every((x) => x.loops === 2)).toBe(true);
  });
  it("stops at the goal you set (0.75×)", () => {
    expect(ladder({ start: "step", goal: 0.75, pace: "quick", sound: "auto" }).map((x) => x.speed)).toEqual(["step", 0.25, 0.5, 0.75]);
  });
  it("our own pluck can speed up in small steps", () => {
    const s = ladder({ start: 0.5, goal: 0.8, pace: "normal", sound: "pluck" });
    expect(s.map((x) => x.speed)).toEqual([0.5, 0.6, 0.7, 0.8]);
    expect(s.every((x) => x.sound === "pluck")).toBe(true);
  });
  it("slow pace goes round more times", () => {
    expect(ladder({ start: 0.5, goal: 1, pace: "slow", sound: "auto" })[0].loops).toBe(4);
  });
});

describe("the song's beat", () => {
  it("finds a steady beat from note times (eighth notes at 96 BPM)", () => {
    const times: number[] = [];
    for (let i = 0; i < 64; i++) if (i % 8 !== 7) times.push(3 + i * (60 / 96 / 2));
    const b = estimateBeat(times)!;
    expect(Math.abs(b.bpm - 96)).toBeLessThanOrEqual(1);
    const beats = beatsBetween(b, 3, 6);
    expect(beats.some((t) => Math.abs(t - 3) < 0.03)).toBe(true);
  });
  it("Love Story's notes give a sensible tempo", () => {
    const notes = JSON.parse(readFileSync("tests/fixtures/love-story.notes.json", "utf8")) as { t: number }[];
    const b = estimateBeat(notes.map((n) => n.t))!;
    expect(b.bpm).toBeGreaterThan(60);
    expect(b.bpm).toBeLessThan(180);
  });
  it("tap tempo", () => {
    expect(tapBpm([0, 500, 1000, 1500])).toBe(120);
    expect(tapBpm([0, 500])).toBeNull();
  });
});

describe("fingers", () => {
  it("one finger per fret from the lowest", () => {
    expect(suggestFingers([{ string: 5, fret: 3 }, { string: 4, fret: 2 }, { string: 3, fret: 0 }, { string: 2, fret: 1 }])).toEqual([3, 2, null, 1]);
  });
  it("open chords get their usual fingers (Am, D, E, C)", () => {
    const f = (shape: string) => suggestFingers([...shape].reverse().map((c, i) => ({ string: i + 1, fret: c === "x" ? 0 : Number(c), tech: c === "x" ? ("mute" as const) : undefined })));
    expect(f("x02210")).toEqual([null, 1, 3, 2, null, null]);
    expect(f("xx0232")).toEqual([2, 3, 1, null, null, null]);
    expect(f("022100")).toEqual([null, null, 1, 3, 2, null]);
    expect(f("x32010")).toEqual([null, 1, null, 2, 3, null]);
  });
  it("a barre is the 1st finger", () => {
    expect(suggestFingers([{ string: 3, fret: 1 }, { string: 2, fret: 1 }, { string: 1, fret: 1 }, { string: 4, fret: 3 }])).toEqual([1, 1, 1, 3]);
  });
  it("a single note follows where the hand is (fret 3 with fret 2 nearby: 2nd finger)", () => {
    expect(suggestFingers([{ string: 1, fret: 3 }], [3, 2, 0, 1])).toEqual([3]);
    expect(suggestFingers([{ string: 1, fret: 3 }], [2])).toEqual([2]);
    expect(suggestFingers([{ string: 1, fret: 7 }], [2])).toEqual([1]);
  });
  it("muted strings get no finger", () => {
    expect(suggestFingers([{ string: 6, fret: 0, tech: "mute" }, { string: 3, fret: 5 }])).toEqual([null, 1]);
  });
});
