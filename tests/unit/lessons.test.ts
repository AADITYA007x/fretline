import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lineAt, pickTrack, toLines, wordAt, wordsFromJson3 } from "../../src/lessons/captions";
import { parseVideoRef } from "../../src/lessons/links";

describe("parseVideoRef", () => {
  it("reads the links Aaditya shares", () => {
    expect(parseVideoRef("https://youtu.be/ZeeuvgrDUeQ?si=Kp_ShbnS0mtypFd9")).toEqual({ videoId: "ZeeuvgrDUeQ", startSec: 0 });
    expect(parseVideoRef("https://www.youtube.com/watch?v=2Lq784V-KPw&t=95s")).toEqual({ videoId: "2Lq784V-KPw", startSec: 95 });
    expect(parseVideoRef("https://m.youtube.com/watch?v=c0JsZN9w_ME&t=1m5s")?.startSec).toBe(65);
    expect(parseVideoRef("https://youtube.com/shorts/xQeTnbcCvLQ?feature=share")?.videoId).toBe("xQeTnbcCvLQ");
    expect(parseVideoRef("Neon intro lesson 🎸 https://youtu.be/xQeTnbcCvLQ?si=t1eguFZrEyFjBq9I")?.videoId).toBe("xQeTnbcCvLQ");
    expect(parseVideoRef("youtu.be/ZeeuvgrDUeQ")?.videoId).toBe("ZeeuvgrDUeQ");
    expect(parseVideoRef("ZeeuvgrDUeQ")?.videoId).toBe("ZeeuvgrDUeQ");
  });

  it("ignores other links", () => {
    expect(parseVideoRef("https://example.com/watch?v=ZeeuvgrDUeQ")).toBeNull();
    expect(parseVideoRef("hello")).toBeNull();
    expect(parseVideoRef("https://youtu.be/short")).toBeNull();
  });
});

describe("captions", () => {
  const { words } = wordsFromJson3(readFileSync("tests/fixtures/auto-captions.json3", "utf8"));

  it("reads timed words from auto captions", () => {
    expect(words.map((w) => w.w).join(" ")).toBe("hey guys welcome back so third string second fret an egg hammer on");
    expect(words[1]).toEqual({ t: 1.68, w: "guys" });
    expect(words[5].t).toBeCloseTo(4.23, 2);
  });

  it("groups words into lines at pauses", () => {
    const lines = toLines(words);
    expect(lines.map((l) => l.text)).toEqual(["hey guys welcome back", "so third string second fret", "an egg hammer on"]);
    expect(lineAt(lines, 0.5)).toBe(-1);
    expect(lineAt(lines, 5)).toBe(1);
    expect(lineAt(lines, 100)).toBe(2);
    expect(wordAt(lines[1], 4.6)).toBe(2);
  });

  it("splits long talk into readable lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ t: i * 0.3, w: `w${i}` }));
    const lines = toLines(many);
    expect(lines.length).toBe(3);
    expect(lines.every((l) => l.words.length <= 12)).toBe(true);
  });

  it("reads uploaded captions (one piece per caption)", () => {
    const json = JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Place your index on the third fret." }] }] });
    const { words: w } = wordsFromJson3(json);
    expect(w.length).toBe(7);
    expect(w[0].t).toBe(1);
    expect(w[6].t).toBeGreaterThan(2.5);
    expect(toLines(w)[0].text).toBe("Place your index on the third fret.");
  });

  it("survives junk", () => {
    expect(wordsFromJson3("<html>").words).toEqual([]);
  });

  it("prefers English typed captions, then English auto", () => {
    const t = (lang: string, auto: boolean) => ({ lang, auto, name: lang, url: lang });
    expect(pickTrack([t("hi", false), t("en", true), t("en", false)])).toEqual(t("en", false));
    expect(pickTrack([t("hi", true), t("en", true)])).toEqual(t("en", true));
    expect(pickTrack([t("hi", true), t("hi", false)])).toEqual(t("hi", false));
    expect(pickTrack([])).toBeNull();
  });
});
