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
  /** A strum arrow drawn by the chord in the video's tab (as drawn). */
  strum?: "up" | "down";
  /** Read from the video, but the readers didn't agree: worth checking. */
  unsure?: boolean;
  source: "speech" | "screen" | "you";
  said?: string;
}

/** Your fixes for one lesson: changed or deleted notes, and notes you added. */
export interface Fixes {
  edits: Record<string, Partial<Pick<TabNote, "string" | "fret" | "finger" | "tech" | "t">> | "deleted">;
  added: TabNote[];
  updatedAt: number;
  /** Tab read from the video itself (see src/scan). */
  screen?: ScreenTab;
}

export interface ScreenTab {
  at: number;
  notes: TabNote[];
  pages: { start: number; end: number; image?: string; notes: number }[];
  none?: string;
  /** Which version of the reader made it (older ones can be read again). */
  v?: number;
  /** Chord names written above the tab, at the note under each. */
  chords?: { t: number; name: string }[];
}

/**
 * The lesson's notes before fixes: what was read off the screen where there
 * is on-screen tab, and what he says everywhere else.
 */
export function combine(speech: TabNote[], screen: ScreenTab | undefined): TabNote[] {
  if (!screen?.notes.length) return speech;
  const covered = (t: number) => screen.pages.some((p) => t >= p.start - 1 && t <= p.end + 1);
  return [...speech.filter((n) => !covered(n.t)), ...screen.notes].sort((a, b) => a.t - b.t);
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
 * than `gap` seconds in his note-naming starts a new phrase, and so does
 * each new page of on-screen tab (`breaks`, its start times), so the strip
 * shows the same notes as the video.
 */
export function toPhrases(notes: TabNote[], gap = 7, breaks: number[] = []): Phrase[] {
  const columns: Column[] = [];
  for (const n of notes) {
    const last = columns[columns.length - 1];
    if (last && n.chord !== undefined && last.notes.some((x) => x.chord === n.chord)) last.notes.push(n);
    else columns.push({ t: n.t, notes: [n] });
  }
  const starts = [...breaks].sort((a, b) => a - b);
  /** The latest page start at or before t (−Infinity if none). */
  const pageOf = (t: number) => {
    let b = -Infinity;
    for (const s of starts) if (s <= t + 0.05) b = s;
    return b;
  };
  const phrases: Phrase[] = [];
  let page = -Infinity;
  for (const c of columns) {
    const p = phrases[phrases.length - 1];
    const pg = pageOf(c.t);
    if (p && c.t - p.end <= gap && pg === page) {
      p.columns.push(c);
      p.end = c.t;
    } else phrases.push({ start: pg > -Infinity && pg !== page ? Math.min(pg, c.t) : c.t, end: c.t, columns: [c] });
    page = pg;
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
  if (n.tech === "mute") return "x";
  if (n.tech === "slideOut") return `${n.fret}\\`;
  if (n.tech === "bend") return `${n.fret}b`;
  return `${mark}${n.fret}`;
}
