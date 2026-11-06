// "My notes": the lesson's tab written the way you write it in your notebook.
// Fret on top, string number below; "+" = together; [frets / strings] = a
// held shape; roll = a strummed chord; 5→7 = slide; pull; ‖ ‖ = hammer-on.
// 8–10 notes per line, each line numbered so you can tick off a few a day.
import { escapeHtml, storage } from "../utils";
import type { TabNote } from "./tab";

export interface Cell {
  /** What goes on top (frets, "roll", …). */
  top: string;
  /** What goes below (string numbers). */
  bottom: string;
  /** A small word above it ("pull", "slide out"). */
  mark?: string;
  hammer?: boolean;
  chord?: string;
  unsure?: boolean;
  t: number;
}

export interface NoteLine {
  n: number;
  t: number;
  end: number;
  cells: Cell[];
  chords: string[];
}

const TOGETHER = 0.03;
const MIN = 8;
const MAX = 10;

const FINGER_MARK: Record<string, string> = { thumb: "T", index: "i", middle: "m", ring: "r", pinky: "p" };

function fingerMark(n: TabNote): string {
  return n.finger ? FINGER_MARK[n.finger] ?? "" : "";
}

/** One cell per moment: a single note, notes together, or a strummed chord. */
export function toCells(notes: TabNote[], chords: { t: number; name: string }[] = []): Cell[] {
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.string - b.string);
  const groups: TabNote[][] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && n.t - g[0].t < TOGETHER) g.push(n);
    else groups.push([n]);
  }
  const last = new Map<number, number>();
  let held = "";
  const cells: Cell[] = [];
  for (const g of groups) {
    g.sort((a, b) => b.string - a.string);
    const chord = chords.find((c) => Math.abs(c.t - g[0].t) < TOGETHER)?.name;
    const unsure = g.some((n) => n.unsure);
    const strings = g.map((n) => String(n.string));
    if (g.length === 1) {
      const n = g[0];
      const before = last.get(n.string);
      let top = n.tech === "mute" ? "x" : n.tech === "harmonic" ? `<${n.fret}>` : n.tech === "bend" ? `${n.fret}b` : String(n.fret);
      let mark: string | undefined;
      if (n.tech === "slide") top = before !== undefined ? `${before}→${n.fret}` : `→${n.fret}`;
      if (n.tech === "slideOut") top = `${n.fret}↘`;
      if (n.tech === "pull") mark = "pull";
      const f = fingerMark(n);
      if (f) top += `·${f}`;
      cells.push({ top, bottom: strings[0], mark, hammer: n.tech === "hammer", chord, unsure, t: n.t });
    } else if (g.some((n) => n.strum)) {
      // A strummed chord: the shape held (once), then "roll" over the strings.
      const fretted = g.filter((n) => n.tech !== "mute" && n.fret > 0);
      const shape = fretted.length ? `[${fretted.map((n) => n.fret).join(" ")} / ${fretted.map((n) => n.string).join(" ")}]` : "";
      if (shape && shape !== held) cells.push({ top: shape, bottom: "", mark: "hold", chord, unsure: false, t: g[0].t - 0.001 });
      held = shape;
      const arrow = g.find((n) => n.strum)?.strum === "up" ? "↑" : "";
      cells.push({ top: `roll${arrow}`, bottom: strings.join(""), chord: shape ? undefined : chord, unsure, t: g[0].t });
    } else {
      const tops = g.map((n) => (n.tech === "mute" ? "x" : String(n.fret)));
      cells.push({ top: tops.join("+"), bottom: strings.join("+"), chord, unsure, t: g[0].t });
    }
    for (const n of g) if (n.tech !== "mute") last.set(n.string, n.fret);
  }
  return cells;
}

/** Cells into numbered lines of 8–10, breaking at the longest pause. */
export function toLines(cells: Cell[]): NoteLine[] {
  const lines: NoteLine[] = [];
  let i = 0;
  while (i < cells.length) {
    let end = Math.min(cells.length, i + MAX);
    // a long pause (a new part of the song) ends a line early
    for (let k = i + 3; k < end; k++) {
      if (cells[k].t - cells[k - 1].t > 2.5) {
        end = k;
        break;
      }
    }
    if (end - i > MIN && end < cells.length) {
      let best = i + MIN;
      for (let k = i + MIN; k <= end; k++) if (cells[k].t - cells[k - 1].t > cells[best].t - cells[best - 1].t) best = k;
      end = best;
    }
    const part = cells.slice(i, end);
    const names = [...new Set(part.map((c) => c.chord).filter((c): c is string => !!c))];
    lines.push({ n: lines.length + 1, t: part[0].t, end: part[part.length - 1].t, cells: part, chords: names });
    i = end;
  }
  return lines;
}

export function notebookLines(notes: TabNote[], chords: { t: number; name: string }[] = []): NoteLine[] {
  return toLines(toCells(notes, chords));
}

// --- Lines done (your progress), per lesson ------------------------------------

const DONE = (id: string) => `fretline:notebook-done:${id}`;

export function doneLines(videoId: string): number[] {
  const v = storage.get<number[]>(DONE(videoId), []);
  return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
}

export function setDone(videoId: string, line: number, done: boolean): number[] {
  const set = new Set(doneLines(videoId));
  if (done) set.add(line);
  else set.delete(line);
  const list = [...set].sort((a, b) => a - b);
  storage.set(DONE(videoId), list);
  return list;
}

// --- Writing it out ------------------------------------------------------------

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function cellHtml(c: Cell): string {
  const cls = ["nb-cell", c.hammer ? "hammer" : "", c.unsure ? "unsure" : "", c.mark === "hold" ? "hold" : ""].filter(Boolean).join(" ");
  const chord = c.chord ? `<span class="nb-chord">[${escapeHtml(c.chord)}]</span>` : "";
  const mark = c.mark && c.mark !== "hold" ? `<span class="nb-mark">${escapeHtml(c.mark)}</span>` : "";
  return `<span class="${cls}">${chord}${mark}<span class="nb-top">${escapeHtml(c.top)}</span><span class="nb-bottom">${escapeHtml(c.bottom) || "&nbsp;"}</span></span>`;
}

/** Plain text, to paste anywhere: "3. 0:41 [Am]  5/1  3→5/2  0+2/4+3 …" */
export function toText(title: string, lines: NoteLine[]): string {
  const body = lines.map((l) => {
    const cells = l.cells.map((c) => {
      const core = c.bottom ? `${c.top}/${c.bottom}` : c.top;
      return `${c.chord ? `[${c.chord}] ` : ""}${c.mark && c.mark !== "hold" ? `${c.mark} ` : ""}${c.hammer ? `||${core}||` : core}`;
    });
    return `${l.n}. ${clock(l.t)}  ${cells.join("  ")}`;
  });
  return [title, "fret/string · + together · [frets / strings] hold · roll strum · → slide · ||n|| hammer-on", "", ...body].join("\n");
}

/** A page to print or save as PDF, like a notebook page. */
export function toPrintHtml(title: string, lines: NoteLine[], done: number[] = []): string {
  const rows = lines
    .map(
      (l) => `<div class="line"><span class="no">${l.n}</span><span class="box">${done.includes(l.n) ? "✓" : ""}</span><span class="time">${clock(l.t)}</span><span class="cells">${l.cells.map(cellHtml).join("")}</span></div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { size: A4; margin: 14mm 12mm; }
body { font-family: "Segoe Print", "Comic Sans MS", "Bradley Hand", cursive, sans-serif; color: #1f2a44; margin: 0; }
h1 { font-size: 18pt; margin: 0 0 2mm; }
.key { font-family: sans-serif; font-size: 8.5pt; color: #555; margin-bottom: 5mm; }
.line { display: flex; align-items: flex-end; gap: 3mm; border-bottom: 1px solid #9fb6d6; padding: 2.5mm 0 1.5mm; break-inside: avoid; }
.no { width: 7mm; font-weight: bold; color: #b0413e; font-family: sans-serif; font-size: 10pt; }
.box { width: 4mm; height: 4mm; border: 1px solid #777; font-size: 8pt; line-height: 4mm; text-align: center; }
.time { width: 11mm; font-family: sans-serif; font-size: 8.5pt; color: #666; }
.cells { display: flex; flex-wrap: wrap; gap: 1mm 4.5mm; align-items: flex-end; }
.nb-cell { display: inline-flex; flex-direction: column; align-items: center; min-width: 6mm; }
.nb-top { font-size: 13pt; line-height: 1.1; }
.nb-bottom { font-size: 9pt; color: #555; border-top: 1px solid #333; padding: 0 1mm; }
.nb-chord { font-family: sans-serif; font-size: 8.5pt; font-weight: bold; color: #b0413e; }
.nb-mark { font-size: 7.5pt; color: #555; }
.hammer { border-left: 3px double #333; border-right: 3px double #333; padding: 0 1mm; }
.hold .nb-bottom { border-top: 0; }
.unsure .nb-top { text-decoration: underline dotted #c80; }
</style></head><body><h1>${escapeHtml(title)}</h1>
<div class="key">fret on top, string below &middot; + together &middot; [frets / strings] hold this shape &middot; roll = strum &middot; 5→7 slide &middot; ‖ ‖ hammer-on &middot; dotted = check this one</div>
${rows}</body></html>`;
}
