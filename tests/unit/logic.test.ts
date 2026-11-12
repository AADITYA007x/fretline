import { describe as group, expect, it } from "vitest";
import { describe, nearestString } from "../../src/tuner/logic";
import { midiToFreq } from "../../src/tuner/pitch";
import { PRESETS } from "../../src/tuner/tunings";

const standard = PRESETS.find((t) => t.id === "g-standard")!;
const dropD = PRESETS.find((t) => t.id === "g-drop-d")!;

group("nearestString", () => {
  it("finds the string being played", () => {
    expect(nearestString(82.4, standard, 440)).toBe(0);
    expect(nearestString(110.9, standard, 440)).toBe(1);
    expect(nearestString(329, standard, 440)).toBe(5);
    expect(nearestString(midiToFreq(38), dropD, 440)).toBe(0); // low D
  });
});

group("describe", () => {
  it("talks plainly", () => {
    expect(describe(1.2, "E2", "E2")).toEqual({ text: "In tune", inTune: true });
    expect(describe(-12.4, "E2", "E2").text).toBe("12 cents flat, tune up");
    expect(describe(8, "E2", "E2").text).toBe("8 cents sharp, tune down");
    expect(describe(-180, "C#2", "D2").text).toBe("That's C#2. Tune up to D2");
  });
});

import { StringPicker } from "../../src/tuner/logic";

group("StringPicker", () => {
  it("ignores a stray reading, follows a real change", () => {
    const p = new StringPicker();
    const e2 = 82.4;
    const e4 = 329.6;
    expect(p.pick(e4, standard, 440)).toBe(5);
    expect(p.pick(e2, standard, 440)).toBe(5); // one odd reading
    expect(p.pick(e4, standard, 440)).toBe(5);
    p.pick(e2, standard, 440);
    p.pick(e2, standard, 440);
    expect(p.pick(e2, standard, 440)).toBe(0); // three in a row: switched
  });

  /** One mic frame: the level is always heard; a reading comes when there's a pitch. */
  const player = () => {
    const p = new StringPicker();
    return (f: number | null, level: number) => {
      p.hear(level);
      return f === null ? null : p.pick(f, standard, 440, level);
    };
  };

  it("high e dying away: A, low E and B ringing along don't take over", () => {
    const frame = player();
    frame(null, 0.002);
    expect(frame(329.6, 0.08)).toBe(5); // the pluck
    expect(frame(329.6, 0.07)).toBe(5);
    expect(frame(329.6, 0.05)).toBe(5);
    // the e fades; the hum of the other strings is what's left (much quieter than the pluck)
    for (const [f, lv] of [[110, 0.03], [82.4, 0.025], [246.9, 0.02], [110, 0.015], [110, 0.012], [110, 0.011], [110, 0.01], [82.4, 0.009]] as const) {
      expect(frame(f, lv)).toBe(-1);
    }
    // plucking the A string: three readings and it's A
    frame(110, 0.09);
    frame(110, 0.085);
    expect(frame(110, 0.08)).toBe(1);
  });

  it("the next string plucked while the last still rings takes over (they're a fourth apart)", () => {
    const frame = player();
    frame(null, 0.002);
    expect(frame(110, 0.1)).toBe(1); // A plucked
    for (let i = 0; i < 12; i++) frame(110, 0.09 - i * 0.002); // ringing on
    // D plucked over it, no louder than the A was (no jump in level to go
    // by): but it's as loud as a pluck, so three readings and it's D
    frame(146.8, 0.07);
    frame(146.8, 0.07);
    expect(frame(146.8, 0.068)).toBe(2);
  });

  it("a soft pluck of the next string after a loud one still takes over (the level jumps)", () => {
    const frame = player();
    frame(null, 0.002);
    expect(frame(110, 0.3)).toBe(1); // A, loud
    for (const lv of [0.2, 0.1, 0.05, 0.02, 0.01]) frame(110, lv); // dies away
    // D, plucked softly: far below the A's pluck, but it starts with a jump
    frame(146.8, 0.06);
    frame(146.8, 0.055);
    expect(frame(146.8, 0.05)).toBe(2);
  });

  it("after a short silence, the next string is taken in three readings", () => {
    const frame = player();
    expect(frame(108, 0.2)).toBe(1);
    for (let i = 0; i < 4; i++) frame(108, 0.2);
    for (let i = 0; i < 3; i++) frame(null, 0.0005); // too short for the readout to reset
    frame(82.4, 0.2);
    frame(82.4, 0.2);
    expect(frame(82.4, 0.2)).toBe(0);
  });
});

group("describe hysteresis", () => {
  it("stays in tune for small wobbles", () => {
    expect(describe(4, "E2", "E2").inTune).toBe(false);
    expect(describe(4, "E2", "E2", true).inTune).toBe(true);
    expect(describe(5, "E2", "E2", true).inTune).toBe(false);
  });
});
