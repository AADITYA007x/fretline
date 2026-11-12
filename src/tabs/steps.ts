// A talk-through lesson as steps. He teaches a phrase by naming its notes,
// then goes over it again (and again, and once more with the next phrase).
// Each stretch of note-naming is a "telling"; tellings with (nearly) the
// same notes are one step. So fifty minutes of talking become a short
// numbered list: the notes of each step, his words for it, and every moment
// in the video where he goes through it.
import { together, toPhrases, type Phrase, type TabNote } from "./tab";

export interface Step {
  n: number;
  /** The telling the notes are taken from: where it is in the video. */
  t: number;
  end: number;
  notes: TabNote[];
  /** Every telling of it, in order. */
  tellings: { start: number; end: number }[];
  /** What he says while teaching it. */
  words: string;
}

/** Each moment of a telling as "string:fret" (+ for notes together). */
function signature(notes: TabNote[]): string[] {
  return together(notes).map((g) =>
    g
      .map((n) => `${n.string}:${n.tech === "mute" ? "x" : n.fret}`)
      .sort()
      .join("+"),
  );
}

/** How many moments two tellings share, in order (longest common subsequence). */
function shared(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

/**
 * The same phrase told again? Most of the longer one must be in the other
 * (captions mishear a note now and then, so not all of it).
 */
export function sameTelling(a: string[], b: string[]): boolean {
  const longer = Math.max(a.length, b.length);
  if (!longer) return false;
  // short ones must match exactly: one note out of three is a different phrase
  const need = longer <= 3 ? longer : Math.ceil(longer * 0.75);
  return Math.abs(a.length - b.length) <= longer - need && shared(a, b) >= need;
}

interface Group {
  tellings: { phrase: Phrase; sig: string[] }[];
}

/**
 * Steps from the lesson's notes. `gap`: a pause this long in his
 * note-naming ends a telling. `said(from, to)`: his words in that stretch.
 */
export function toSteps(notes: TabNote[], said: (from: number, to: number) => string = () => "", gap = 7): Step[] {
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  const groups: Group[] = [];
  for (const phrase of toPhrases(sorted, gap)) {
    const sig = signature(phrase.columns.flatMap((c) => c.notes));
    // one note said in passing isn't a phrase to practise
    if (sig.length < 2) continue;
    const g = groups.find((x) => x.tellings.some((t) => sameTelling(t.sig, sig)));
    if (g) g.tellings.push({ phrase, sig });
    else groups.push({ tellings: [{ phrase, sig }] });
  }
  return groups.map((g, i) => {
    // the telling to show: the way he says it most often (a misheard note
    // is the odd one out), the fuller one if that's a tie, the first of those
    const count = (sig: string[]) => g.tellings.filter((t) => t.sig.join(" ") === sig.join(" ")).length;
    const best = [...g.tellings].sort((a, b) => count(b.sig) - count(a.sig) || b.sig.length - a.sig.length || a.phrase.start - b.phrase.start)[0];
    const notesOf = best.phrase.columns.flatMap((c) => c.notes);
    const t = Math.min(...notesOf.map((n) => n.t));
    const end = Math.max(...notesOf.map((n) => n.t));
    return {
      n: i + 1,
      t,
      end,
      notes: notesOf,
      tellings: g.tellings.map((x) => ({ start: x.phrase.start, end: x.phrase.end })),
      words: said(t - 2, end + 3).trim(),
    };
  });
}
