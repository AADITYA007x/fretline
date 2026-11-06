// A fretboard drawing: where to put your fingers for the note(s) now, and
// faintly, the next ones. High e on top, like the tab.
import type { TabNote } from "../tabs/tab";
import { suggestFingers } from "./fingers";

const INLAYS = [3, 5, 7, 9, 15, 17];

export interface Window {
  /** First fret shown (0 = the nut). */
  from: number;
  to: number;
}

/** Enough frets to show the part, at least 5, starting at the nut when it can. */
export function fretWindow(frets: number[]): Window {
  const used = frets.filter((f) => f > 0);
  const hi = Math.max(5, ...used);
  const lo = used.length ? Math.min(...used) : 1;
  if (hi <= 12) return { from: 0, to: Math.max(hi + 1, 7) };
  const from = Math.max(0, lo - 1);
  return { from, to: Math.max(from + 6, hi + 1) };
}

export function fretboardSvg(now: TabNote[], next: TabNote[], win: Window, around: number[] = []): string {
  const W = 360;
  const H = 132;
  const left = 22;
  const right = 8;
  const top = 14;
  const gap = (H - top - 14) / 5;
  const frets = win.to - win.from;
  const fw = (W - left - right) / frets;
  const y = (s: number) => top + (s - 1) * gap;
  // the middle of the space for fret f (fret 0 = just left of the nut)
  const x = (f: number) => (f === 0 ? left - 10 : left + (f - win.from - 0.5) * fw);
  const parts: string[] = [];
  // board, inlays, frets, strings
  parts.push(`<rect x="${left}" y="${top - 6}" width="${W - left - right}" height="${gap * 5 + 12}" rx="4" class="fb-wood"/>`);
  for (let f = win.from + 1; f <= win.to; f++) {
    const cx = left + (f - win.from - 0.5) * fw;
    if (INLAYS.includes(f)) parts.push(`<circle cx="${cx}" cy="${top + gap * 2.5}" r="4" class="fb-inlay"/>`);
    if (f === 12) parts.push(`<circle cx="${cx}" cy="${top + gap * 1.5}" r="4" class="fb-inlay"/><circle cx="${cx}" cy="${top + gap * 3.5}" r="4" class="fb-inlay"/>`);
  }
  for (let f = win.from; f <= win.to; f++) {
    const fx = left + (f - win.from) * fw;
    parts.push(`<line x1="${fx}" y1="${top - 6}" x2="${fx}" y2="${top + gap * 5 + 6}" class="${f === 0 ? "fb-nut" : "fb-fret"}"/>`);
  }
  for (let s = 1; s <= 6; s++) parts.push(`<line x1="${left}" y1="${y(s)}" x2="${W - right}" y2="${y(s)}" class="fb-string" stroke-width="${0.8 + s * 0.25}"/>`);
  // fret numbers
  for (let f = Math.max(1, win.from + 1); f <= win.to; f++) if (f === win.from + 1 || INLAYS.includes(f) || f === 12) parts.push(`<text x="${left + (f - win.from - 0.5) * fw}" y="${H - 1}" class="fb-num">${f}</text>`);
  const dot = (n: TabNote, finger: number | null, cls: string) => {
    if (n.tech === "mute") return `<text x="${left - 11}" y="${y(n.string) + 4}" class="fb-x ${cls}">✕</text>`;
    if (n.fret === 0 || n.fret < win.from || n.fret > win.to) return `<circle cx="${left - 11}" cy="${y(n.string)}" r="5.5" class="fb-open ${cls}"/>`;
    const label = finger ? `<text x="${x(n.fret)}" y="${y(n.string) + 4}" class="fb-finger">${finger}</text>` : "";
    return `<circle cx="${x(n.fret)}" cy="${y(n.string)}" r="${Math.min(9, gap * 0.45)}" class="fb-dot ${cls}"/>${cls === "now" ? label : ""}`;
  };
  const nowSet = new Set(now.map((n) => `${n.string}:${n.fret}`));
  for (const n of next) if (!nowSet.has(`${n.string}:${n.fret}`)) parts.push(dot(n, null, "next"));
  const fingers = suggestFingers(now, around);
  now.forEach((n, i) => parts.push(dot(n, fingers[i], "now")));
  return `<svg viewBox="0 0 ${W} ${H}" class="fretboard" role="img" aria-label="Fretboard">${parts.join("")}</svg>`;
}
