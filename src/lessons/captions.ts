// YouTube captions → timed words and readable lines.
//
// Auto-generated captions ("json3" format) time every word; uploaded ones
// only time each caption. Both become the same shape: words with a start
// time, grouped into short lines for reading along.

export interface Word {
  /** Start, seconds. */
  t: number;
  w: string;
}

export interface Line {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

interface Json3 {
  events?: { tStartMs?: number; dDurationMs?: number; aAppend?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[];
}

/** Words from YouTube's json3 caption format. */
export function wordsFromJson3(text: string): { words: Word[]; ends: number[] } {
  let data: Json3;
  try {
    data = JSON.parse(text) as Json3;
  } catch {
    return { words: [], ends: [] };
  }
  const words: Word[] = [];
  const ends: number[] = []; // where each caption event ends (for line breaks)
  for (const ev of data.events ?? []) {
    if (!ev.segs || ev.tStartMs === undefined) continue;
    const start = ev.tStartMs / 1000;
    let added = false;
    for (const seg of ev.segs) {
      const raw = seg.utf8 ?? "";
      if (raw === "\n") continue;
      const t = ((ev.tStartMs ?? 0) + (seg.tOffsetMs ?? 0)) / 1000;
      const pieces = raw.split(/\s+/).filter(Boolean);
      // A segment with several words (uploaded captions): spread them over
      // the event so reading along still moves.
      const step = Math.min(((ev.dDurationMs ?? 0) / 1000) / Math.max(1, pieces.length), 0.6);
      pieces.forEach((w, i) => {
        words.push({ t: t + step * i, w });
        added = true;
      });
    }
    if (added && ev.dDurationMs) ends.push(start + ev.dDurationMs / 1000);
  }
  words.sort((a, b) => a.t - b.t);
  return { words, ends };
}

/** Group words into lines: break on a pause, at sentence ends, or when long. */
export function toLines(words: Word[], maxWords = 12, pause = 1.1): Line[] {
  const lines: Line[] = [];
  let cur: Word[] = [];
  const flush = (end: number) => {
    if (!cur.length) return;
    lines.push({ start: cur[0].t, end, text: cur.map((w) => w.w).join(" "), words: cur });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev && (w.t - prev.t > pause || cur.length >= maxWords)) flush(w.t);
    cur.push(w);
    if (/[.!?]$/.test(w.w) && cur.length >= 3) flush(words[i + 1]?.t ?? w.t + 1.5);
  }
  if (cur.length) flush(cur[cur.length - 1].t + 1.5);
  // A line ends when the next begins (but not later than 4 s after its last word).
  for (let i = 0; i < lines.length; i++) {
    const lastWord = lines[i].words[lines[i].words.length - 1].t;
    lines[i].end = Math.min(lines[i + 1]?.start ?? lastWord + 2, lastWord + 4);
  }
  return lines;
}

/** Index of the line playing at `t`, or the last one before it (−1 if none yet). */
export function lineAt(lines: Line[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Index of the word being said at `t` within a line (−1 before it starts). */
export function wordAt(line: Line, t: number): number {
  let ans = -1;
  for (let i = 0; i < line.words.length; i++) if (line.words[i].t <= t) ans = i;
  return ans;
}

export interface CaptionTrack {
  lang: string;
  name: string;
  auto: boolean;
  url: string;
}

/**
 * Which caption track to show: English typed by the uploader, then English
 * auto captions, then anything typed, then anything auto.
 */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const en = (t: CaptionTrack) => /^en\b/i.test(t.lang);
  return tracks.find((t) => en(t) && !t.auto) ?? tracks.find((t) => en(t)) ?? tracks.find((t) => !t.auto) ?? tracks[0] ?? null;
}
