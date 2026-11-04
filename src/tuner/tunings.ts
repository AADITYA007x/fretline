// Instruments, tuning presets, and the user's own tunings + song links.
// Strings are listed low → high (thickest first), as notes like "E2".
import { storage } from "../utils";
import { midiToName, noteToMidi } from "./pitch";

export type InstrumentId = "guitar" | "bass" | "ukulele";

export interface Tuning {
  id: string;
  name: string;
  instrument: InstrumentId;
  strings: string[];
  /** true for tunings the user made. */
  custom?: boolean;
}

export interface SongTuning {
  id: string;
  song: string;
  tuningId: string;
}

export const INSTRUMENTS: { id: InstrumentId; label: string }[] = [
  { id: "guitar", label: "Guitar" },
  { id: "bass", label: "Bass" },
  { id: "ukulele", label: "Ukulele" },
];

const p = (id: string, name: string, instrument: InstrumentId, notes: string): Tuning => ({
  id,
  name,
  instrument,
  strings: notes.split(" "),
});

export const PRESETS: Tuning[] = [
  p("g-standard", "Standard", "guitar", "E2 A2 D3 G3 B3 E4"),
  p("g-half-down", "Half-step down", "guitar", "D#2 G#2 C#3 F#3 A#3 D#4"),
  p("g-full-down", "Full-step down", "guitar", "D2 G2 C3 F3 A3 D4"),
  p("g-drop-d", "Drop D", "guitar", "D2 A2 D3 G3 B3 E4"),
  p("g-drop-c", "Drop C", "guitar", "C2 G2 C3 F3 A3 D4"),
  p("g-cadgbe", "CADGBE", "guitar", "C2 A2 D3 G3 B3 E4"),
  p("g-dadgad", "DADGAD", "guitar", "D2 A2 D3 G3 A3 D4"),
  p("g-open-d", "Open D", "guitar", "D2 A2 D3 F#3 A3 D4"),
  p("g-open-g", "Open G", "guitar", "D2 G2 D3 G3 B3 D4"),
  p("g-open-e", "Open E", "guitar", "E2 B2 E3 G#3 B3 E4"),
  p("g-open-c", "Open C", "guitar", "C2 G2 C3 G3 C4 E4"),
  p("b-standard", "Standard", "bass", "E1 A1 D2 G2"),
  p("b-drop-d", "Drop D", "bass", "D1 A1 D2 G2"),
  p("b-half-down", "Half-step down", "bass", "D#1 G#1 C#2 F#2"),
  p("b-five", "5-string", "bass", "B0 E1 A1 D2 G2"),
  p("u-standard", "Standard (high G)", "ukulele", "G4 C4 E4 A4"),
  p("u-low-g", "Low G", "ukulele", "G3 C4 E4 A4"),
  p("u-baritone", "Baritone", "ukulele", "D3 G3 B3 E4"),
];

const KEYS = {
  custom: "fretline:custom-tunings",
  songs: "fretline:song-tunings",
  current: "fretline:current-tuning",
  a4: "fretline:a4",
} as const;

export function customTunings(): Tuning[] {
  return storage.get<Tuning[]>(KEYS.custom, []).filter((t) => t && Array.isArray(t.strings));
}

export function allTunings(): Tuning[] {
  return [...PRESETS, ...customTunings()];
}

export function tuningsFor(instrument: InstrumentId): Tuning[] {
  return allTunings().filter((t) => t.instrument === instrument);
}

export function findTuning(id: string): Tuning | undefined {
  return allTunings().find((t) => t.id === id);
}

export function currentTuning(): Tuning {
  return findTuning(storage.get<string>(KEYS.current, "g-standard")) ?? PRESETS[0];
}

export function setCurrentTuning(id: string): void {
  storage.set(KEYS.current, id);
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Create or update a custom tuning. Returns its id. */
export function saveCustomTuning(t: Omit<Tuning, "id" | "custom"> & { id?: string }): string {
  const list = customTunings();
  const id = t.id && list.some((x) => x.id === t.id) ? t.id : newId("c");
  const next: Tuning = { id, name: t.name.trim() || "My tuning", instrument: t.instrument, strings: [...t.strings], custom: true };
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = next;
  else list.push(next);
  storage.set(KEYS.custom, list);
  return id;
}

export function deleteCustomTuning(id: string): void {
  storage.set(
    KEYS.custom,
    customTunings().filter((t) => t.id !== id),
  );
  // Songs that used it go back to the instrument's standard tuning.
  storage.set(
    KEYS.songs,
    songTunings().filter((s) => s.tuningId !== id),
  );
  if (storage.get<string>(KEYS.current, "") === id) setCurrentTuning("g-standard");
}

export function songTunings(): SongTuning[] {
  return storage.get<SongTuning[]>(KEYS.songs, []).filter((s) => s && findTuning(s.tuningId));
}

/** Remember which tuning a song uses (same song name replaces). */
export function saveSongTuning(song: string, tuningId: string): void {
  const name = song.trim();
  if (!name) return;
  const list = songTunings().filter((s) => s.song.toLowerCase() !== name.toLowerCase());
  list.push({ id: newId("s"), song: name, tuningId });
  list.sort((a, b) => a.song.localeCompare(b.song));
  storage.set(KEYS.songs, list);
}

export function deleteSongTuning(id: string): void {
  storage.set(
    KEYS.songs,
    songTunings().filter((s) => s.id !== id),
  );
}

export function getA4(): number {
  const v = storage.get<number>(KEYS.a4, 440);
  return Number.isFinite(v) && v >= 415 && v <= 466 ? v : 440;
}

export function setA4(hz: number): void {
  storage.set(KEYS.a4, Math.max(415, Math.min(466, Math.round(hz))));
}

/** "D A D G B E" — how tunings are usually written. */
export function shortNotes(t: Tuning): string {
  return t.strings.map((n) => midiToName(noteToMidi(n))).join(" ");
}

/** Range of notes the detector should listen for, with some room around. */
export function listenRange(t: Tuning): { minFreq: number; maxFreq: number } {
  const midis = t.strings.map(noteToMidi);
  const lo = Math.min(...midis) - 5; // a few semitones under the lowest string
  const hi = Math.max(...midis) + 7;
  const f = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
  return { minFreq: f(lo), maxFreq: f(hi) };
}
