// "My notes": the lesson's tab written the way you write it in your notebook.
// Fret on top, string number below; "+" = together; [frets / strings] = a
// held shape; roll = a strummed chord; 5→7 = slide; pull; ‖ ‖ = hammer-on;
// ✋ = slap.
// 8–10 notes per line, each line numbered so you can tick off a few a day.
import { escapeHtml } from "../utils";
import { getProgress, setLineDone } from "../practice/progress";
import { together, type TabNote } from "./tab";
import { toSteps, type Step } from "./steps";

export interface Cell {
  /** What goes on top (frets, "roll", …). */
  top: string;
  /** What goes below (string numbers). */
  bottom: string;
  /** A small word above it ("pull", "slide out"). */
  mark?: string;
  hammer?: boolean;
  chord?: string;
  /** The chord's shape as played here (frets for strings 1..6, -1 = not played). */
  chordShape?: number[];
  /** A held shape's frets (strings 1..6, -1 = not played). */
  shape?: number[];
  unsure?: boolean;
  t: number;
}

export interface NoteLine {
  n: number;
  t: number;
  end: number;
  cells: Cell[];
  chords: string[];
  /** A step of a talk-through lesson (see steps.ts): which one this line is from. */
  step?: number;
  /** His words while he teaches it (on the step's first line). */
  words?: string;
  /** Every stretch of the video where he goes through this step. */
  tellings?: { start: number; end: number }[];
}

const TOGETHER = 0.03;
/** Your sign for a slap (muted x's in the video). */
const SLAP = "✋";
const MIN = 8;
const MAX = 10;

const FINGER_MARK: Record<string, string> = { thumb: "T", index: "i", middle: "m", ring: "r", pinky: "p" };

function fingerMark(n: TabNote): string {
  return n.finger ? FINGER_MARK[n.finger] ?? "" : "";
}

/** A fret with its own sign: ✋ slap, <12> harmonic, 7b bend, 7↘ slide out. */
function fretMark(n: TabNote): string {
  if (n.tech === "mute") return SLAP;
  if (n.tech === "harmonic") return `<${n.fret}>`;
  if (n.tech === "bend") return `${n.fret}b`;
  if (n.tech === "slideOut") return `${n.fret}↘`;
  return String(n.fret);
}

/** A slide from the fret before on that string: "1→5" (or "→5"). */
function slid(n: TabNote, before: number | undefined): string {
  return before !== undefined && before !== n.fret ? `${before}→${n.fret}` : `→${n.fret}`;
}

/** One cell per moment: a single note, notes together, or a strummed chord. */
export function toCells(notes: TabNote[], chords: { t: number; name: string }[] = []): Cell[] {
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.string - b.string);
  // together = same moment (or said "together"), and never two notes on one string
  const groups = together(notes);
  const last = new Map<number, number>();
  let held = "";
  // a chord name's shape as played: on each string, the fret used most
  // while that chord lasts (until the next name, at most 4 s)
  const names = [...chords].sort((a, b) => a.t - b.t);
  const playedShape = (t: number): number[] => {
    const next = names.find((c) => c.t > t + 0.05)?.t ?? Infinity;
    const end = Math.min(next, t + 4);
    const counts = Array.from({ length: 6 }, () => new Map<number, number>());
    for (const n of sorted) if (n.t >= t - 0.05 && n.t < end - 0.02 && n.tech !== "mute") counts[n.string - 1].set(n.fret, (counts[n.string - 1].get(n.fret) ?? 0) + 1);
    return counts.map((m) => (m.size ? [...m].sort((a, b) => b[1] - a[1])[0][0] : -1));
  };
  const cells: Cell[] = [];
  for (const g of groups) {
    g.sort((a, b) => b.string - a.string);
    const chord = chords.find((c) => Math.abs(c.t - g[0].t) < TOGETHER)?.name;
    const chordShape = chord ? playedShape(g[0].t) : undefined;
    const unsure = g.some((n) => n.unsure);
    const strings = g.map((n) => String(n.string));
    if (g.length === 1) {
      const n = g[0];
      const before = last.get(n.string);
      let top = fretMark(n);
      let mark: string | undefined;
      if (n.tech === "slide") top = slid(n, before);
      if (n.tech === "pull") mark = "pull";
      const f = fingerMark(n);
      if (f) top += `·${f}`;
      cells.push({ top, bottom: strings[0], mark, hammer: n.tech === "hammer", chord, chordShape, unsure, t: n.t });
    } else if (g.some((n) => n.tech === "mute") && (g.every((n) => n.tech === "mute") || !g.some((n) => n.strum))) {
      // Slap (the video's x's): one hand for all the muted strings, then
      // anything played with it: ✋+2 over 21+3.
      const muted = g.filter((n) => n.tech === "mute");
      const rest = g.filter((n) => n.tech !== "mute");
      cells.push({
        top: [SLAP, ...rest.map((n) => (n.tech === "slide" ? slid(n, last.get(n.string)) : fretMark(n)))].join("+"),
        bottom: [muted.map((n) => n.string).join(""), ...rest.map((n) => String(n.string))].join("+"),
        chord,
        chordShape,
        unsure,
        t: g[0].t,
      });
    } else if (g.some((n) => n.strum)) {
      // A strummed chord: the shape held (once), then "roll" over the strings.
      const fretted = g.filter((n) => n.tech !== "mute" && n.fret > 0);
      const shape = fretted.length ? `[${fretted.map((n) => n.fret).join(" ")} / ${fretted.map((n) => n.string).join(" ")}]` : "";
      const frets = [-1, -1, -1, -1, -1, -1];
      for (const n of g) if (n.tech !== "mute") frets[n.string - 1] = n.fret;
      if (shape && shape !== held) cells.push({ top: shape, bottom: "", mark: "hold", chord, chordShape, shape: frets, unsure: false, t: g[0].t - 0.001 });
      held = shape;
      const arrow = g.find((n) => n.strum)?.strum === "up" ? "↑" : "";
      cells.push({ top: `roll${arrow}`, bottom: strings.join(""), chord: shape ? undefined : chord, chordShape: shape ? undefined : chordShape, unsure, t: g[0].t });
    } else {
      const tops = g.map((n) => (n.tech === "slide" ? slid(n, last.get(n.string)) : fretMark(n)));
      cells.push({ top: tops.join("+"), bottom: strings.join("+"), chord, chordShape, unsure, t: g[0].t });
    }
    for (const n of g) if (n.tech !== "mute") last.set(n.string, n.fret);
  }
  return cells;
}

/** Cells into numbered lines of 8–10, breaking at the longest pause; each new chord starts a line. */
export function toLines(cells: Cell[]): NoteLine[] {
  const lines: NoteLine[] = [];
  let i = 0;
  while (i < cells.length) {
    let end = Math.min(cells.length, i + MAX);
    // a new chord (name or held shape) starts a new line
    let chordBreak = false;
    for (let k = i + 1; k < end; k++) {
      if (cells[k].chord || cells[k].mark === "hold") {
        end = k;
        chordBreak = true;
        break;
      }
    }
    // a long pause (a new part of the song) ends a line early
    for (let k = i + 3; k < end; k++) {
      if (cells[k].t - cells[k - 1].t > 2.5) {
        end = k;
        break;
      }
    }
    if (!chordBreak && end - i > MIN && end < cells.length) {
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

/**
 * A talk-through lesson's steps as lines: one line a step (a long step is
 * split evenly into lines of at most 10), numbered straight through.
 */
export function stepLines(steps: Step[]): NoteLine[] {
  const lines: NoteLine[] = [];
  for (const st of steps) {
    const cells = toCells(st.notes);
    const parts = Math.max(1, Math.ceil(cells.length / MAX));
    const size = Math.ceil(cells.length / parts);
    for (let k = 0; k < parts; k++) {
      const part = cells.slice(k * size, (k + 1) * size);
      if (!part.length) continue;
      lines.push({
        n: lines.length + 1,
        t: part[0].t,
        end: part[part.length - 1].t,
        cells: part,
        chords: [],
        step: st.n,
        words: k === 0 ? st.words : undefined,
        tellings: st.tellings,
      });
    }
  }
  return lines;
}

/** What a lesson's My notes and Practice work from. */
export interface LessonTab {
  notes: TabNote[];
  chords: { t: number; name: string }[];
  /** No tab on screen: the notes are the ones he names, so it's steps. */
  talk: boolean;
  /** His words between two moments of the video. */
  said?: (from: number, to: number) => string;
}

export function lessonLines(tab: LessonTab): NoteLine[] {
  return tab.talk ? stepLines(toSteps(tab.notes, tab.said)) : notebookLines(tab.notes, tab.chords);
}

// --- Lines done (your progress), per lesson ------------------------------------

export function doneLines(videoId: string): number[] {
  return getProgress(videoId).done;
}

export function setDone(videoId: string, line: number, done: boolean): number[] {
  return setLineDone(videoId, line, done);
}

// --- Writing it out ------------------------------------------------------------

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function cellHtml(c: Cell, extra = ""): string {
  const cls = ["nb-cell", extra, c.hammer ? "hammer" : "", c.unsure ? "unsure" : "", c.mark === "hold" ? "hold" : ""].filter(Boolean).join(" ");
  // The chord name sits in the line before its first note: "[D] 1/1 2/2 …"
  const chord = c.chord ? `<span class="nb-cell nb-chordtag" role="button" tabindex="0" data-chord="${escapeHtml(c.chord)}" data-shape="${(c.chordShape ?? []).join(",")}" aria-label="Chord ${escapeHtml(c.chord)}: show the shape"><span class="nb-top">[${escapeHtml(c.chord)}]</span><span class="nb-bottom">&nbsp;</span></span>` : "";
  const mark = c.mark && c.mark !== "hold" ? `<span class="nb-mark">${escapeHtml(c.mark)}</span>` : "";
  const shapeAttr = c.shape ? ` role="button" tabindex="0" data-shape="${c.shape.join(",")}" aria-label="Held shape: show it"` : "";
  return `${chord}<span class="${cls}"${shapeAttr}>${mark}<span class="nb-top">${escapeHtml(c.top)}</span><span class="nb-bottom">${escapeHtml(c.bottom) || "&nbsp;"}</span></span>`;
}

/** His words, cut to a line or two. */
export function shorten(text: string, max = 150): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, t.lastIndexOf(" ", max) > max * 0.6 ? t.lastIndexOf(" ", max) : max)}…`;
}

/** Plain text, to paste anywhere: "3. 0:41 [Am]  5/1  3→5/2  0+2/4+3 …" */
export function toText(title: string, lines: NoteLine[]): string {
  const body = lines.map((l) => {
    const cells = l.cells.map((c) => {
      const core = c.bottom ? `${c.top}/${c.bottom}` : c.top;
      return `${c.chord ? `[${c.chord}] ` : ""}${c.mark && c.mark !== "hold" ? `${c.mark} ` : ""}${c.hammer ? `||${core}||` : core}`;
    });
    return `${l.n}. ${clock(l.t)}  ${cells.join("  ")}${l.words ? `\n   “${shorten(l.words, 200)}”` : ""}`;
  });
  return [title, "fret/string · + together · [frets / strings] hold · roll strum · → slide · ||n|| hammer-on · ✋ slap", "", ...body].join("\n");
}

/** A page to print or save as PDF, like a notebook page. */
export function toPrintHtml(title: string, lines: NoteLine[], done: number[] = []): string {
  const rows = lines
    .map(
      (l) =>
        `<div class="line"><span class="no">${l.n}</span><span class="box">${done.includes(l.n) ? "✓" : ""}</span><span class="time">${clock(l.t)}</span><span class="cells">${l.cells.map((c) => cellHtml(c)).join("")}</span>${l.words ? `<span class="words">“${escapeHtml(shorten(l.words, 220))}”</span>` : ""}</div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { size: A4; margin: 14mm 12mm; }
body { font-family: "Segoe Print", "Comic Sans MS", "Bradley Hand", cursive, sans-serif; color: #1f2a44; margin: 0; }
h1 { font-size: 18pt; margin: 0 0 2mm; }
.key { font-family: sans-serif; font-size: 8.5pt; color: #555; margin-bottom: 5mm; }
.line { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 3mm; border-bottom: 1px solid #9fb6d6; padding: 2.5mm 0 1.5mm; break-inside: avoid; }
.no { width: 7mm; font-weight: bold; color: #b0413e; font-family: sans-serif; font-size: 10pt; }
.box { width: 4mm; height: 4mm; border: 1px solid #777; font-size: 8pt; line-height: 4mm; text-align: center; }
.time { width: 11mm; font-family: sans-serif; font-size: 8.5pt; color: #666; }
.cells { display: flex; flex-wrap: wrap; gap: 1mm 4.5mm; align-items: flex-end; }
.nb-cell { display: inline-flex; flex-direction: column; align-items: center; min-width: 6mm; }
.nb-top { font-size: 13pt; line-height: 1.1; }
.nb-bottom { font-size: 9pt; color: #555; border-top: 1px solid #333; padding: 0 1mm; }
.nb-chordtag .nb-top { font-family: sans-serif; font-weight: bold; color: #b0413e; }
.nb-chordtag .nb-bottom { border-top: 0; }
.nb-mark { font-size: 7.5pt; color: #555; }
.hammer { border-left: 3px double #333; border-right: 3px double #333; padding: 0 1mm; }
.hold .nb-bottom { border-top: 0; }
.unsure .nb-top { text-decoration: underline dotted #c80; }
.words { flex-basis: 100%; padding-left: 28mm; font-family: sans-serif; font-size: 8.5pt; color: #555; }
</style></head><body><h1>${escapeHtml(title)}</h1>
<div class="key">fret on top, string below &middot; + together &middot; [frets / strings] hold this shape &middot; roll = strum &middot; 5→7 slide &middot; ‖ ‖ hammer-on &middot; ✋ slap &middot; dotted = check this one</div>
${rows}</body></html>`;
}
