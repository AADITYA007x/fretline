// A lesson's tab: notes from his words, with your fixes on top, grouped
// into the phrases he explains one at a time.
import type { Finger, SpokenNote, Technique } from "./speech";

export interface TabNote {
  id: string;
  /** When he said it / when it happens (seconds into the video). */
  t: number;
  /** 1 = high e … 6 = low E. */
  string: number;
  fret: number;
  finger?: Finger;
  tech?: Technique;
  chord?: number;
  source: "speech" | "you";
  said?: string;
}

/** Your fixes for one lesson: changed or deleted notes, and notes you added. */
export interface Fixes {
  edits: Record<string, Partial<Pick<TabNote, "string" | "fret" | "finger" | "tech" | "t">> | "deleted">;
  added: TabNote[];
  updatedAt: number;
}

export const emptyFixes = (): Fixes => ({ edits: {}, added: [], updatedAt: 0 });

export function fromSpoken(spoken: SpokenNote[]): TabNote[] {
  const seen = new Map<string, number>();
  return spoken.map((n) => {
    const base = `s${Math.round(n.t * 10)}-${n.string}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return { ...n, id: k ? `${base}-${k}` : base, source: "speech" as const };
  });
}

export function applyFixes(base: TabNote[], fixes: Fixes): TabNote[] {
  const out: TabNote[] = [];
  for (const n of base) {
    const e = fixes.edits[n.id];
    if (e === "deleted") continue;
    out.push(e ? { ...n, ...e } : n);
  }
  for (const n of fixes.added) {
    const e = fixes.edits[n.id];
    if (e === "deleted") continue;
    out.push(e ? { ...n, ...e } : n);
  }
  return out.sort((a, b) => a.t - b.t || b.string - a.string);
}

export interface Column {
  t: number;
  notes: TabNote[];
}

export interface Phrase {
  start: number;
  end: number;
  columns: Column[];
}

/**
 * Columns (notes said together share one), then phrases: a pause of more
 * than `gap` seconds in his note-naming starts a new phrase.
 */
export function toPhrases(notes: TabNote[], gap = 7): Phrase[] {
  const columns: Column[] = [];
  for (const n of notes) {
    const last = columns[columns.length - 1];
    if (last && n.chord !== undefined && last.notes.some((x) => x.chord === n.chord)) last.notes.push(n);
    else columns.push({ t: n.t, notes: [n] });
  }
  const phrases: Phrase[] = [];
  for (const c of columns) {
    const p = phrases[phrases.length - 1];
    if (p && c.t - p.end <= gap) {
      p.columns.push(c);
      p.end = c.t;
    } else phrases.push({ start: c.t, end: c.t, columns: [c] });
  }
  return phrases;
}

/**
 * The phrase to show at time t: the one being explained (or just
 * finished, for `hold` seconds); otherwise the next one coming up.
 */
export function phraseAt(phrases: Phrase[], t: number, hold = 15): { index: number; upcoming: boolean } | null {
  let idx = -1;
  for (let i = 0; i < phrases.length; i++) if (phrases[i].start <= t + 0.05) idx = i;
  if (idx >= 0 && t - phrases[idx].end <= hold) return { index: idx, upcoming: false };
  const next = phrases.findIndex((p) => p.start > t);
  return next >= 0 ? { index: next, upcoming: true } : idx >= 0 ? { index: idx, upcoming: false } : null;
}

/** Index of the column being played/explained at t within a phrase (−1 before it). */
export function columnAt(p: Phrase, t: number): number {
  let ans = -1;
  p.columns.forEach((c, i) => {
    if (c.t <= t + 0.05) ans = i;
  });
  return ans;
}

let counter = 0;
export function newNoteId(): string {
  counter = (counter + 1) % 1000;
  return `u${Date.now().toString(36)}${counter}`;
}

export const STRING_NAMES = ["", "e", "B", "G", "D", "A", "E"];

/** "h4", "p2", "/7": a fret with its technique mark, as tab writes it. */
export function fretLabel(n: Pick<TabNote, "fret" | "tech">): string {
  const mark = n.tech === "hammer" ? "h" : n.tech === "pull" ? "p" : n.tech === "slide" ? "/" : "";
  if (n.tech === "harmonic") return `<${n.fret}>`;
  if (n.tech === "bend") return `${n.fret}b`;
  return `${mark}${n.fret}`;
}
