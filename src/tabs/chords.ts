// Chord shapes: tap a chord name ([Am]) or a held shape ([2 1 / 3 2]) to see
// where the fingers go, as a chord box. "As played here" comes from the tab
// itself; the usual open shape comes from a small built-in list.
import { escapeHtml } from "../utils";
import { suggestFingers } from "../practice/fingers";

/** Frets for strings 1..6 (index 0 = high e): -1 = don't play, 0 = open. */
export type Shape = number[];

/** Usual shapes, written low E → high e like chord books ("x02210" = Am). */
const BOOK: Record<string, string> = {
  A: "x02220", Am: "x02210", A7: "x02020", Am7: "x02010", Amaj7: "x02120", Asus2: "x02200", Asus4: "x02230",
  B7: "x21202", Bm: "x24432", B: "x24442",
  C: "x32010", C7: "x32310", Cmaj7: "x32000", Cadd9: "x32030",
  D: "xx0232", Dm: "xx0231", D7: "xx0212", Dmaj7: "xx0222", Dm7: "xx0211", Dsus2: "xx0230", Dsus4: "xx0233",
  E: "022100", Em: "022000", E7: "020100", Em7: "022030", Emaj7: "021100", Esus4: "022200",
  F: "133211", Fmaj7: "xx3210", Fm: "133111", F7: "131211",
  G: "320003", G7: "320001", Gmaj7: "320002", Em9: "024000",
  Bb: "x13331", Bm7: "x20202", "F#m": "244222", "C#m": "x46654", "G#m": "466444",
};

export function bookShape(name: string): Shape | null {
  const s = BOOK[name] ?? BOOK[name.replace(/maj$/, "")];
  if (!s) return null;
  // book string is low E first; ours is string 1 (high e) first
  return [...s].reverse().map((c) => (c === "x" ? -1 : Number(c)));
}

export function shapeFrom(notes: { string: number; fret: number }[]): Shape {
  const out: Shape = [-1, -1, -1, -1, -1, -1];
  for (const n of notes) if (n.string >= 1 && n.string <= 6) out[n.string - 1] = n.fret;
  return out;
}

export function sameShape(a: Shape, b: Shape): boolean {
  return a.every((f, i) => f === b[i]);
}

/** A chord box: strings top to bottom of the page as they face you (low E left). */
export function chordBoxSvg(shape: Shape): string {
  const W = 150;
  const H = 170;
  const left = 22;
  const top = 34;
  const sw = (W - left - 16) / 5;
  const fh = 26;
  const fretted = shape.filter((f) => f > 0);
  const hi = fretted.length ? Math.max(...fretted) : 0;
  const lo = fretted.length ? Math.min(...fretted) : 0;
  const base = hi <= 4 ? 1 : lo;
  const rows = Math.max(4, hi - base + 1);
  const x = (string: number) => left + (6 - string) * sw;
  const parts: string[] = [];
  parts.push(`<line x1="${left}" y1="${top}" x2="${left + 5 * sw}" y2="${top}" class="cb-nut${base > 1 ? " thin" : ""}"/>`);
  for (let r = 1; r <= rows; r++) parts.push(`<line x1="${left}" y1="${top + r * fh}" x2="${left + 5 * sw}" y2="${top + r * fh}" class="cb-fret"/>`);
  for (let s = 1; s <= 6; s++) parts.push(`<line x1="${x(s)}" y1="${top}" x2="${x(s)}" y2="${top + rows * fh}" class="cb-string"/>`);
  if (base > 1) parts.push(`<text x="${left - 8}" y="${top + fh * 0.65}" class="cb-base">${base}</text>`);
  const notes = shape.map((f, i) => ({ string: i + 1, fret: Math.max(0, f), tech: f < 0 ? ("mute" as const) : undefined }));
  const fingers = suggestFingers(notes.filter((n) => shape[n.string - 1] >= 0));
  const fingerOf = new Map(notes.filter((n) => shape[n.string - 1] >= 0).map((n, k) => [n.string, fingers[k]]));
  // a barre: one finger across 3+ strings on the same fret
  const barre = new Map<number, number[]>();
  shape.forEach((f, i) => {
    if (f > 0 && fingerOf.get(i + 1) === 1) barre.set(f, [...(barre.get(f) ?? []), i + 1]);
  });
  for (const [f, ss] of barre)
    if (ss.length >= 3) parts.push(`<rect x="${x(Math.max(...ss)) - 7}" y="${top + (f - base + 0.5) * fh - 7}" width="${x(Math.min(...ss)) - x(Math.max(...ss)) + 14}" height="14" rx="7" class="cb-dot"/>`);
  shape.forEach((f, i) => {
    const s = i + 1;
    if (f < 0) parts.push(`<text x="${x(s)}" y="${top - 9}" class="cb-mark">×</text>`);
    else if (f === 0) parts.push(`<circle cx="${x(s)}" cy="${top - 13}" r="5" class="cb-open"/>`);
    else {
      const cy = top + (f - base + 0.5) * fh;
      parts.push(`<circle cx="${x(s)}" cy="${cy}" r="9" class="cb-dot"/>`);
      const fg = fingerOf.get(s);
      if (fg) parts.push(`<text x="${x(s)}" y="${cy + 4}" class="cb-finger">${fg}</text>`);
    }
  });
  ["E", "A", "D", "G", "B", "e"].forEach((n, k) => parts.push(`<text x="${left + k * sw}" y="${top + rows * fh + 16}" class="cb-name">${n}</text>`));
  return `<svg viewBox="0 0 ${W} ${H + Math.max(0, rows - 4) * fh}" class="chord-box" role="img" aria-label="Chord shape">${parts.join("")}</svg>`;
}

/** "fret 2 on D, fret 1 on B …" for reading out. */
export function describeShape(shape: Shape): string {
  const names = ["e", "B", "G", "D", "A", "E"];
  const held = shape
    .map((f, i) => ({ f, s: names[i] }))
    .filter((p) => p.f > 0)
    .reverse()
    .map((p) => `${p.s} fret ${p.f}`);
  const open = shape.map((f, i) => (f === 0 ? names[i] : "")).filter(Boolean).reverse();
  return [held.join(", "), open.length ? `open ${open.join(" ")}` : ""].filter(Boolean).join(" · ");
}

export function chordSheetHtml(name: string | null, played: Shape | null): string {
  const book = name ? bookShape(name) : null;
  const box = (title: string, s: Shape) => `<figure class="cb-fig"><figcaption>${escapeHtml(title)}</figcaption>${chordBoxSvg(s)}<p class="muted cb-desc">${escapeHtml(describeShape(s))}</p></figure>`;
  const figs: string[] = [];
  if (played && played.some((f) => f >= 0)) figs.push(box("As played here", played));
  if (book && (!played || !sameShape(book, played))) figs.push(box(played ? "Usual shape" : "Shape", book));
  if (!figs.length) return `<p class="muted">No shape known for ${escapeHtml(name ?? "this")} yet.</p>`;
  return `<div class="cb-row">${figs.join("")}</div><p class="muted cb-note">Numbers are fingers (1 = index … 4 = little). A long dot is a barre. × = don't play that string, ○ = play it open.${played ? " “As played here” comes from the tab; finger numbers are a suggestion." : ""}</p>`;
}
