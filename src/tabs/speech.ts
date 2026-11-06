// Turns what the teacher says into tab notes.
//
// He explains each note out loud: "middle finger fourth string second
// fret", "open D string", "hammer on to the fourth fret", "fourth and
// third together". YouTube's auto captions write that down with word
// timings, and mishear a few things ("an egg hammer on", "court" for
// "chord"). This reads the words and pulls out string + fret (+ finger and
// technique) with the moment he said it.
//
// Strings are numbered like tab: 1 = high e (thinnest) … 6 = low E.
import type { Word } from "../lessons/captions";

export type Finger = "thumb" | "index" | "middle" | "ring" | "pinky";
export type Technique = "hammer" | "pull" | "slide" | "bend" | "harmonic" | "mute" | "slideOut";

export interface SpokenNote {
  /** When he said it (seconds into the video). */
  t: number;
  string: number;
  fret: number;
  finger?: Finger;
  tech?: Technique;
  /** Notes said "together" share a chord number. */
  chord?: number;
  /** The words this came from, for the tip under the tab. */
  said: string;
  /** Only the string was said; the fret comes from the chord he's holding. */
  fromShape?: boolean;
}

const NUMBERS: Record<string, number> = {
  zero: 0, open: 0, one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5,
  six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10, eleven: 11,
  eleventh: 11, twelve: 12, twelfth: 12, thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14, fifteen: 15,
  fifteenth: 15, sixteen: 16, sixteenth: 16, seventeen: 17, seventeenth: 17, eighteen: 18, eighteenth: 18,
  nineteen: 19, nineteenth: 19, twenty: 20, twentieth: 20,
};

/** "2", "2nd", "second", "two" → 2. */
function num(tok: string | undefined): number | null {
  if (!tok) return null;
  if (tok in NUMBERS) return NUMBERS[tok];
  const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(tok);
  return m ? Number(m[1]) : null;
}

const FINGERS: Record<string, Finger> = { thumb: "thumb", index: "index", middle: "middle", ring: "ring", pinky: "pinky", pinkie: "pinky", little: "pinky" };
const ORDINAL_FINGER: Record<string, Finger> = { first: "index", second: "middle", third: "ring", fourth: "pinky" };

/** Caption mishearings seen in guitar lessons, fixed before reading. */
const FIXES: [RegExp, string][] = [
  [/\ban egg\b/g, "and"],
  [/\bhero play\b/g, "here we play"],
  [/\bfinger all\b/g, "finger roll"],
  [/\b(court|cord|chords?)\b/g, "chord"],
  [/\b(fred|freight|threat|frat|fret's|frets)\b/g, "fret"],
  [/\bstreams?\b/g, "string"],
  [/\bstrings\b/g, "string"],
  [/\bhammer-on\b/g, "hammer on"],
  [/\bhammering\b/g, "hammer on"],
  [/\bpull-off\b/g, "pull off"],
  [/\bpulling off\b/g, "pull off"],
  [/\bsliding\b/g, "slide"],
  [/\bpinky finger\b/g, "pinky"],
  [/\blittle finger\b/g, "pinky"],
  [/\bat the same time\b/g, "together"],
];

interface Tok {
  w: string;
  t: number;
}

/** Lowercase words without punctuation, with the fixes applied (times kept). */
export function normalize(words: Word[]): Tok[] {
  // Fix on the joined text, then map the words back to times by position.
  const clean = words.map((x) => ({ w: x.w.toLowerCase().replace(/[^a-z0-9'-]/g, ""), t: x.t })).filter((x) => x.w);
  let text = clean.map((x) => x.w).join(" ");
  // Track each word's start offset so fixed text can borrow times.
  let pos = 0;
  const starts = clean.map((x) => {
    const s = pos;
    pos += x.w.length + 1;
    return s;
  });
  for (const [re, to] of FIXES) {
    // Pad with markers so the text keeps its length and words keep their times.
    text = text.replace(re, (m) => to + "\u0000".repeat(Math.max(0, m.length - to.length)));
  }
  // Re-split, assigning each new word the time of the original word at its start offset.
  const out: Tok[] = [];
  let cursor = 0;
  for (const piece of text.split(" ")) {
    const w = piece.replace(/\u0000/g, "");
    const at = cursor;
    cursor += piece.length + 1;
    if (!w) continue;
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= at) k++;
    out.push({ w, t: clean[k]?.t ?? 0 });
  }
  return out;
}

const LETTER_STRING: Record<string, number> = { a: 5, d: 4, g: 3, b: 2, be: 2, bee: 2, dee: 4, gee: 3, jean: 3, gene: 3 };

/**
 * A string named at tokens[i] ("fourth string", "D string", "low E
 * string", "high e"). Returns the string number and how many tokens it used.
 */
function stringAt(toks: Tok[], i: number): { string: number; len: number } | null {
  const a = toks[i]?.w;
  const b = toks[i + 1]?.w;
  const c = toks[i + 2]?.w;
  if (!a) return null;
  // "fourth string" / "4th string"
  const n = num(a);
  if (n !== null && n >= 1 && n <= 6 && b === "string" && a !== "open" && a !== "zero") return { string: n, len: 2 };
  // "low e string", "high e string", "low e", "high e"
  if ((a === "low" || a === "thick" || a === "bass" || a === "big") && b === "e") return { string: 6, len: c === "string" ? 3 : 2 };
  if ((a === "high" || a === "thin" || a === "little" || a === "small") && b === "e") return { string: 1, len: c === "string" ? 3 : 2 };
  // "d string", "the a string"
  if (a in LETTER_STRING && b === "string") return { string: LETTER_STRING[a], len: 2 };
  return null;
}

/** "second fret" / "fret two" / "2nd fret" at tokens[i]. */
function fretAt(toks: Tok[], i: number): { fret: number; len: number } | null {
  const a = toks[i]?.w;
  const b = toks[i + 1]?.w;
  if (!a) return null;
  const n = num(a);
  if (n !== null && b === "fret" && a !== "open") return { fret: n, len: 2 };
  if (a === "fret" && b !== undefined) {
    const m = num(b);
    if (m !== null && b !== "open") return { fret: m, len: 2 };
  }
  return null;
}

const FILLER = new Set(["on", "the", "at", "of", "in", "and", "a", "to", "your", "with", "then", "now", "so", "we", "play", "this", "that", "is", "it"]);

/** Skip up to `max` filler words from index i; returns the next real index. */
function skipFiller(toks: Tok[], i: number, max = 3): number {
  let k = i;
  while (k < toks.length && k - i < max && FILLER.has(toks[k].w)) k++;
  return k;
}

/** A finger named just before index i (within a few words), e.g. "middle finger". */
function fingerBefore(toks: Tok[], i: number, stopAt: number): Finger | undefined {
  for (let k = i - 1; k >= Math.max(stopAt, i - 4); k--) {
    const w = toks[k].w;
    if (w in FINGERS && w !== "little") return FINGERS[w];
    if (w === "finger" && k > 0) {
      const prev = toks[k - 1].w;
      if (prev in FINGERS) return FINGERS[prev];
      if (prev in ORDINAL_FINGER) return ORDINAL_FINGER[prev];
    }
  }
  return undefined;
}

/** "with (the|your) index (finger)" just after index i. */
function fingerAfter(toks: Tok[], i: number): Finger | undefined {
  let k = i;
  if (toks[k]?.w !== "with" && toks[k]?.w !== "using") return undefined;
  k++;
  while (toks[k] && (toks[k].w === "the" || toks[k].w === "your" || toks[k].w === "my")) k++;
  const w = toks[k]?.w;
  if (w && w in FINGERS) return FINGERS[w];
  if (w && w in ORDINAL_FINGER && toks[k + 1]?.w === "finger") return ORDINAL_FINGER[w];
  return undefined;
}

const TECH_WORDS: [string[], Technique][] = [
  [["hammer", "on"], "hammer"],
  [["pull", "off"], "pull"],
  [["slide"], "slide"],
  [["bend"], "bend"],
  [["harmonic"], "harmonic"],
];

function techAt(toks: Tok[], i: number): { tech: Technique; len: number } | null {
  for (const [words, tech] of TECH_WORDS) {
    if (words.every((w, k) => toks[i + k]?.w === w)) return { tech, len: words.length };
  }
  if (toks[i]?.w === "hammer") return { tech: "hammer", len: 1 };
  return null;
}

const CARDINAL = new Set(["one", "two", "three", "four", "five", "six", "1", "2", "3", "4", "5", "6"]);
const LEAD_IN = new Set(["play", "plays", "playing", "then", "again", "and", "pluck", "plucking", "strings", "string", "we"]);
const NOT_A_STRING_AFTER = new Set([
  "fret", "string", "times", "time", "minutes", "minute", "seconds", "second", "more", "of", "percent", "years", "bars",
  "bar", "beats", "beat", "finger", "fingers", "notes", "note", "chords", "chord", "o'clock", "days", "people", "videos",
]);

/**
 * A plain string number in a plucking sequence: "play five", "then four",
 * "five three five". Needs a lead-in word or a neighbouring string number,
 * so ordinary talk ("five minutes", "two of them") isn't read as notes.
 */
function isBareString(toks: Tok[], i: number): boolean {
  const w = toks[i].w;
  if (!CARDINAL.has(w)) return false;
  const next = toks[i + 1]?.w;
  if (next && NOT_A_STRING_AFTER.has(next)) return false;
  const prev = toks[i - 1]?.w;
  if (prev === "fret" || prev === "the" || prev === "number" || prev === "part" || prev === "step") return false;
  const isNum = (k: number) => !!toks[k] && CARDINAL.has(toks[k].w) && !NOT_A_STRING_AFTER.has(toks[k + 1]?.w ?? "");
  const near = (k: number) => Math.abs((toks[k]?.t ?? 1e9) - toks[i].t) < 2.5;
  if (prev && LEAD_IN.has(prev)) return true;
  if (isNum(i - 1) && near(i - 1)) return true;
  // "then four and then": a number between connecting words
  if (isNum(i + 1) && near(i + 1)) return true;
  if ((prev === "then" || prev === "again") ) return true;
  return false;
}

/** All the notes he names, in order. */
export function notesFromSpeech(words: Word[]): SpokenNote[] {
  const toks = normalize(words);
  const notes: SpokenNote[] = [];
  let lastEnd = 0; // fingers can't be borrowed from before the previous note
  let chordId = 0;
  const said = (from: number, to: number) => toks.slice(Math.max(0, from), to).map((x) => x.w).join(" ");

  const shape = new Map<number, number>(); // string → fret of the chord he's holding
  let seen = 0;
  for (let i = 0; i < toks.length; i++) {
    for (; seen < notes.length; seen++) if (!notes[seen].fromShape) shape.set(notes[seen].string, notes[seen].fret);
    // Technique moving to a new fret on the same string:
    // "hammer on (to) (the) fourth fret", "slide up to seventh fret"
    const tech = techAt(toks, i);
    if (tech) {
      let k = i + tech.len;
      while (toks[k] && ["up", "down", "to", "the", "onto", "into", "on"].includes(toks[k].w) && k - i < tech.len + 3) k++;
      const fr = fretAt(toks, k);
      const prev = notes[notes.length - 1];
      if (fr && prev) {
        // "...on the third string" after it overrides the string.
        const after = skipFiller(toks, k + fr.len, 2);
        const st = stringAt(toks, after);
        notes.push({
          t: toks[i].t,
          string: st ? st.string : prev.string,
          fret: fr.fret,
          tech: tech.tech,
          finger: fingerAfter(toks, k + fr.len),
          said: said(i - 2, k + fr.len + (st ? st.len : 0)),
        });
        i = k + fr.len - 1 + (st ? st.len : 0);
        lastEnd = i + 1;
        continue;
      }
      if (prev && !prev.tech && i - lastEnd < 3 && toks[i].t - prev.t < 4) {
        // "...second fret and hammer on" with the fret said before: mark it.
        prev.tech = tech.tech;
      }
    }

    // "open D string" / "open fourth string" / "fourth string open"
    if (toks[i].w === "open") {
      const st = stringAt(toks, skipFiller(toks, i + 1, 1));
      if (st) {
        const j = skipFiller(toks, i + 1, 1);
        notes.push({ t: toks[i].t, string: st.string, fret: 0, finger: undefined, said: said(i, j + st.len) });
        i = j + st.len - 1;
        lastEnd = i + 1;
        continue;
      }
    }

    // "fourth string second fret" (string first)
    const st = stringAt(toks, i);
    if (st) {
      const j = skipFiller(toks, i + st.len);
      const fr = fretAt(toks, j);
      if (fr) {
        const end = j + fr.len;
        notes.push({
          t: toks[i].t,
          string: st.string,
          fret: fr.fret,
          finger: fingerBefore(toks, i, lastEnd) ?? fingerAfter(toks, end),
          said: said(i - 3, end + 3),
        });
        i = end - 1;
        lastEnd = end;
        continue;
      }
      if (toks[j]?.w === "open") {
        notes.push({ t: toks[i].t, string: st.string, fret: 0, said: said(i, j + 1) });
        i = j;
        lastEnd = j + 1;
        continue;
      }
    }

    // "second fret (on the) fourth string" (fret first)
    const fr = fretAt(toks, i);
    if (fr) {
      const j = skipFiller(toks, i + fr.len);
      const st2 = stringAt(toks, j);
      if (st2) {
        const end = j + st2.len;
        notes.push({
          t: toks[i].t,
          string: st2.string,
          fret: fr.fret,
          finger: fingerBefore(toks, i, lastEnd) ?? fingerAfter(toks, end),
          said: said(i - 3, end + 3),
        });
        i = end - 1;
        lastEnd = end;
        continue;
      }
    }

    // A new chord is being shown: forget the old shape.
    if (toks[i].w === "chord") shape.clear();

    // "two times fifth string": that string, twice (fret from the shape).
    const reps = num(toks[i].w);
    if (reps !== null && reps >= 2 && reps <= 8 && (toks[i + 1]?.w === "times" || toks[i + 1]?.w === "time")) {
      const j = skipFiller(toks, i + 2, 2);
      const stR = stringAt(toks, j);
      if (stR) {
        for (let r = 0; r < reps; r++)
          notes.push({ t: toks[i].t + r * 0.01, string: stR.string, fret: shape.get(stR.string) ?? 0, fromShape: true, said: said(i - 2, j + stR.len) });
        i = j + stR.len - 1;
        lastEnd = i + 1;
        continue;
      }
    }

    // Plucking the shape he just showed, by string number:
    // "we play five then four and then again five", "five five three five four".
    if (isBareString(toks, i)) {
      const n = num(toks[i].w)!;
      notes.push({ t: toks[i].t, string: n, fret: shape.get(n) ?? 0, fromShape: true, said: said(i - 3, i + 4) });
      lastEnd = i + 1;
      continue;
    }

    // "...together" / "both together": the last notes (said within ~4 s) sound at once.
    if (toks[i].w === "together" && notes.length >= 2 && toks[i].t - notes[notes.length - 1].t < 4) {
      const last = notes[notes.length - 1];
      const group = notes.filter((n) => last.t - n.t < 4 && n.chord === undefined);
      if (group.length >= 2) {
        chordId++;
        for (const n of group) n.chord = chordId;
      }
    }
  }
  return notes;
}
