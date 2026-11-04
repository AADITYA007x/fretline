import { describe, expect, it } from "vitest";
import { notesFromSpeech } from "../../src/tabs/speech";

/** Words spoken one every 0.3 s from `start`. */
const say = (text: string, start = 0) => text.split(/\s+/).map((w, i) => ({ t: start + i * 0.3, w }));
const brief = (text: string) =>
  notesFromSpeech(say(text)).map((n) => [n.string, n.fret, n.finger ?? null, n.tech ?? null, n.chord ?? null]);

describe("notes from what the teacher says", () => {
  it("string then fret, with the finger", () => {
    expect(brief("the first chord we take like this middle finger fourth string second fret and ring fifth string third fret and here we")).toEqual([
      [4, 2, "middle", null, null],
      [5, 3, "ring", null, null],
    ]);
  });

  it("reads YouTube's mishearings", () => {
    expect(brief("so third string second fred with index an egg hammer on to the fourth fret")).toEqual([
      [3, 2, "index", null, null],
      [3, 4, null, "hammer", null],
    ]);
    expect(brief("the first court we take is fifth string third threat")).toEqual([[5, 3, null, null, null]]);
  });

  it("fret then string, open strings, letter names", () => {
    expect(brief("put your index on the second fret of the g string")).toEqual([[3, 2, "index", null, null]]);
    expect(brief("then open d string and the open fourth string")).toEqual([
      [4, 0, null, null, null],
      [4, 0, null, null, null],
    ]);
    expect(brief("low e string third fret then high e string open")).toEqual([
      [6, 3, null, null, null],
      [1, 0, null, null, null],
    ]);
    expect(brief("2nd string 3rd fret")).toEqual([[2, 3, null, null, null]]);
    expect(brief("fret five on the b string")).toEqual([[2, 5, null, null, null]]);
  });

  it("techniques move along the same string", () => {
    expect(brief("fifth string third fret slide up to the fifth fret then pull off to third fret")).toEqual([
      [5, 3, null, null, null],
      [5, 5, null, "slide", null],
      [5, 3, null, "pull", null],
    ]);
    expect(brief("second string first fret and hammer on")).toEqual([[2, 1, null, "hammer", null]]);
  });

  it("notes said together make a chord", () => {
    expect(brief("fourth string second fret and third string open together")).toEqual([
      [4, 2, null, null, 1],
      [3, 0, null, null, 1],
    ]);
  });

  it("doesn't invent notes from ordinary talk", () => {
    expect(brief("hey guys welcome back in the second part we play the first verse")).toEqual([]);
    expect(brief("wait a second and play it again five times")).toEqual([]);
    expect(brief("this is the third string")).toEqual([]);
  });

  it("keeps when each note was said", () => {
    const notes = notesFromSpeech(say("hello fourth string second fret", 10));
    expect(notes[0].t).toBeCloseTo(10.3, 5);
    expect(notes[0].said).toContain("fourth string second fret");
  });
});

describe("plucking the chord he just showed, by string number", () => {
  // From the Fingerstyle Club "Demons" lesson, 3:54–4:36.
  const lesson = [
    "the first chord we take like this middle finger fourth string second fret and ring fifth string third fret and here we",
    "play five then four and then again five",
    "let's play it again five five three five four five then we",
    "take off middle finger and we play open fourth string",
    "after that we play two times fifth string",
  ].join(" ");

  it("uses the frets of the shape for each string", () => {
    const got = brief(lesson).map(([s, f]) => `${s}:${f}`);
    expect(got).toEqual([
      "4:2", "5:3", // the chord
      "5:3", "4:2", "5:3", // five then four … five
      "5:3", "5:3", "3:0", "5:3", "4:2", "5:3", // five five three five four five
      "4:0", // open fourth string
      "5:3", "5:3", // two times fifth string
    ]);
  });

  it("a new chord forgets the old shape", () => {
    expect(brief("fifth string third fret play five now the next chord we play five").map(([s, f]) => `${s}:${f}`)).toEqual([
      "5:3",
      "5:3",
      "5:0",
    ]);
  });

  it("'together' only joins notes said just before it", () => {
    const w = [...say("fourth string second fret fifth string third fret"), { t: 30, w: "and" }, { t: 30.3, w: "together" }];
    expect(notesFromSpeech(w).every((n) => n.chord === undefined)).toBe(true);
  });

  it("still ignores numbers in ordinary talk", () => {
    expect(brief("practice this five minutes a day for two weeks")).toEqual([]);
    expect(brief("in part two we learn the chorus")).toEqual([]);
    expect(brief("there are six strings on the guitar")).toEqual([]);
  });
});
