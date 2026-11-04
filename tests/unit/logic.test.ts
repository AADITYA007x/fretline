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
});

group("describe hysteresis", () => {
  it("stays in tune for small wobbles", () => {
    expect(describe(4, "E2", "E2").inTune).toBe(false);
    expect(describe(4, "E2", "E2", true).inTune).toBe(true);
    expect(describe(5, "E2", "E2", true).inTune).toBe(false);
  });
});
