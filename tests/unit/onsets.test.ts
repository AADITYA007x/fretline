// Lining notes up with the sound. The fixture holds sound features (not
// the sound) of a screen recording of the Love Story lesson, and the
// columns the tab reader timed by the cursor in that recording.
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { onsetPeaks, pitchClass, syncNotes, type Sound, type SyncNote } from "../../src/scan/onsets";

const j = JSON.parse(gunzipSync(readFileSync("tests/fixtures/love-story.sound.json.gz")).toString());
const unq = (q: { scale: number; b64: string }) => Float32Array.from(Buffer.from(q.b64, "base64"), (v) => v * q.scale);
const sound: Sound = { starts: { frames: j.frames, rise: unq(j.rise) }, env: unq(j.env) };
const cols: { t: number; page: number; notes: { string: number; fret: number }[] }[] = j.cols;

function notesShifted(shift: number): { notes: SyncNote[]; pages: { start: number; end: number }[] } {
  const notes = cols.flatMap((c, i) => c.notes.map((n) => ({ t: c.t + shift, string: n.string, fret: n.fret, chord: i })));
  const starts = [...new Set(cols.map((c) => c.page))].sort((a, b) => a - b);
  return { notes, pages: starts.map((s, i) => ({ start: s + shift, end: (starts[i + 1] ?? 1e9) + shift })) };
}

describe("lining the tab up with the sound", () => {
  it("pitch classes: open strings and frets, with a capo", () => {
    expect(pitchClass(6, 0)).toBe(4); // E
    expect(pitchClass(2, 1)).toBe(0); // B + 1 = C
    expect(pitchClass(5, 3, 1)).toBe(1); // A + 3 + capo 1 = C#
  });

  it("finds plucks in the sound", () => {
    const peaks = onsetPeaks(sound.env);
    // ~37 s of fingerpicking: a few per second
    expect(peaks.length).toBeGreaterThan(80);
    expect(peaks.length).toBeLessThan(400);
  });

  it("finds how far the cursor is off from the sound, clearly, with no capo", () => {
    const { notes, pages } = notesShifted(0);
    const r = syncNotes(notes, pages, sound);
    expect(r.report.capo).toBe(0);
    expect(r.report.clarity).toBeGreaterThan(2);
    expect(Math.abs(r.report.offset - -0.2)).toBeLessThan(0.06);
    expect(r.report.snapped / r.report.columns).toBeGreaterThan(0.5);
  });

  it.each([0.7, -1.2, 2.5])("recovers a slide of %s s (the tab running late or early)", (shift) => {
    const { notes, pages } = notesShifted(shift);
    const r = syncNotes(notes, pages, sound);
    expect(Math.abs(r.report.offset - (-0.2 - shift))).toBeLessThan(0.06);
    // and the notes land where they did with no slide
    const base = syncNotes(notesShifted(0).notes, notesShifted(0).pages, sound).times;
    const close = r.times.filter((t, i) => Math.abs(t - base[i]) < 0.05).length;
    expect(close / base.length).toBeGreaterThan(0.85);
  });

  it("keeps the notes in order and chords together", () => {
    const { notes, pages } = notesShifted(0);
    const { times } = syncNotes(notes, pages, sound);
    for (let i = 1; i < notes.length; i++) if (notes[i].chord === notes[i - 1].chord) expect(times[i]).toBe(times[i - 1]);
    const byChord = new Map<number, number>();
    notes.forEach((n, i) => byChord.set(n.chord!, times[i]));
    const seq = [...byChord.values()];
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
  });

  it("leaves times alone when the sound doesn't match the notes", () => {
    const { notes, pages } = notesShifted(0);
    const noise: Sound = { starts: { frames: sound.starts.frames, rise: new Float32Array(sound.starts.rise.length).fill(1) }, env: sound.env };
    const r = syncNotes(notes, pages, noise);
    expect(r.report.skipped).toBeTruthy();
    expect(r.times).toEqual(notes.map((n) => n.t));
  });
});
