// Reading on-screen tab in lesson videos: the thinking part.
//
// The phone (TabScanPlugin) supplies small grey frames, per-column
// measurements of the tab area through the whole video, and the
// characters ML Kit reads on chosen frames. This finds the tab staff, tells
// tab pages apart, follows the cursor, and turns digits into timed notes.

export interface Staff {
  /** y of the six lines, top (high e) to bottom (low E), in image pixels. */
  lines: number[];
  spacing: number;
  x0: number;
  x1: number;
  /** 0..1: how sure we are this is a tab staff. */
  score: number;
}

/**
 * Find a six-line tab staff in a grey image (w×h, one byte per pixel).
 * Tab lines are thin dark lines on a light background running across most
 * of the width; strings in the video itself are short and slanted.
 */
export function findStaff(gray: Uint8Array, w: number, h: number): Staff | null {
  const rowScore = new Float32Array(h);
  // Lines are thin and, in a small frame, faint (only ~10–20 levels darker),
  // and may smear over two rows: compare each row with rows 2–3 away.
  for (let y = 3; y < h - 3; y++) {
    let hits = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      const above = Math.max(gray[(y - 2) * w + x], gray[(y - 3) * w + x]);
      const below = Math.max(gray[(y + 2) * w + x], gray[(y + 3) * w + x]);
      const bg = Math.min(above, below);
      if (bg > 150 && v < bg - 7) hits++;
    }
    rowScore[y] = hits / w;
  }
  // Peaks (merge 1–2 px thick lines into one).
  const peaks: { y: number; s: number }[] = [];
  for (let y = 3; y < h - 3; y++) {
    if (rowScore[y] < 0.3) continue;
    const last = peaks[peaks.length - 1];
    if (last && y - last.y <= 2) {
      if (rowScore[y] > last.s) {
        last.y = y;
        last.s = rowScore[y];
      }
    } else peaks.push({ y, s: rowScore[y] });
  }
  let best: Staff | null = null;
  for (let i = 0; i + 5 < peaks.length; i++) {
    const six = peaks.slice(i, i + 6);
    const gaps = six.slice(1).map((p, k) => p.y - six[k].y);
    const mean = gaps.reduce((a, b) => a + b, 0) / 5;
    if (mean < 3 || mean > h / 8) continue;
    if (gaps.some((g) => Math.abs(g - mean) > Math.max(1.2, mean * 0.22))) continue;
    const score = six.reduce((a, p) => a + p.s, 0) / 6;
    if (!best || score > best.score) {
      const lines = six.map((p) => p.y);
      const [x0, x1] = extent(gray, w, lines);
      if (x1 - x0 < w * 0.3) continue;
      best = { lines, spacing: mean, x0, x1, score };
    }
  }
  return best;
}

/** Left and right ends of the staff lines (longest run where most lines are present). */
function extent(gray: Uint8Array, w: number, lines: number[]): [number, number] {
  const on = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (const y of lines) {
      const v = Math.min(gray[y * w + x], gray[Math.min(y + 1, lines[5] + 3) * w + x]);
      const near = Math.max(gray[(y - 3) * w + x], gray[(y + 3) * w + x]);
      if (v < near - 6) n++;
    }
    on[x] = n >= 3 ? 1 : 0;
  }
  // Close small gaps (digits sit on the lines and hide them).
  let bestA = 0;
  let bestB = 0;
  let a = -1;
  let gap = 0;
  for (let x = 0; x <= w; x++) {
    if (x < w && on[x]) {
      if (a < 0) a = x;
      gap = 0;
    } else if (a >= 0) {
      gap++;
      if (gap > w * 0.04 || x === w) {
        const b = x - gap;
        if (b - a > bestB - bestA) {
          bestA = a;
          bestB = b;
        }
        a = -1;
        gap = 0;
      }
    }
  }
  return [bestA, bestB];
}

/** The staff seen in most overview frames (it rarely moves). */
export function commonStaff(found: (Staff | null)[]): Staff | null {
  const list = found.filter((s): s is Staff => !!s);
  if (!list.length) return null;
  let best: Staff | null = null;
  let bestVotes = 0;
  for (const s of list) {
    const votes = list.filter((o) => Math.abs(o.lines[0] - s.lines[0]) <= s.spacing * 0.5 && Math.abs(o.spacing - s.spacing) <= s.spacing * 0.2).length;
    if (votes > bestVotes || (votes === bestVotes && best && s.score > best.score)) {
      best = s;
      bestVotes = votes;
    }
  }
  return bestVotes >= Math.max(2, list.length * 0.25) || list.length === 1 ? best : null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The tab area to measure and read, in video pixels. */
export function staffRect(s: Staff, scale: number, videoW: number, videoH: number): Rect {
  const pad = s.spacing * 1.3;
  const x = Math.max(0, Math.floor((s.x0 - s.spacing) * scale));
  const y = Math.max(0, Math.floor((s.lines[0] - pad) * scale));
  const x1 = Math.min(videoW, Math.ceil((s.x1 + s.spacing) * scale));
  const y1 = Math.min(videoH, Math.ceil((s.lines[5] + pad) * scale));
  return { x, y, w: x1 - x, h: y1 - y };
}

// --- Through the video: pages and the cursor -------------------------------------------

export interface FrameFeatures {
  t: number;
  /** Mean brightness per column of the tab area. */
  y: Uint8Array;
  /** Mean blue(+)/yellow(−) per column (Cb, 128 = neutral). */
  u: Uint8Array;
  /** Mean red(+)/cyan(−) per column (Cr, 128 = neutral). */
  v?: Uint8Array;
  /** 64×12 grey thumbnail of the tab area. */
  m: Uint8Array;
}

export const THUMB_W = 64;
export const THUMB_H = 12;

/**
 * How different two tab-area thumbnails are: the number of thumbnail
 * columns with a strong change, leaving out the columns where the cursor is
 * in either frame (`ignore`, 0..1 across). A new page changes digits all
 * across; the moving cursor changes one thin strip.
 */
export function changedCells(a: Uint8Array, b: Uint8Array, ignore: (number | null)[] = []): number {
  const w = a.length === THUMB_W * THUMB_H ? THUMB_W : 32;
  const h = a.length / w;
  const skip = new Set<number>();
  for (const x of ignore) {
    if (x === null) continue;
    const c = Math.round(x * (w - 1));
    for (let k = c - 1; k <= c + 1; k++) skip.add(k);
  }
  let cols = 0;
  for (let x = 0; x < w; x++) {
    if (skip.has(x)) continue;
    for (let y = 0; y < h; y++) {
      if (Math.abs(a[y * w + x] - b[y * w + x]) > 22) {
        cols++;
        break;
      }
    }
  }
  return cols;
}

/** Is there tab in this frame at all? (light background with dark marks) */
export function looksLikeTab(f: FrameFeatures): boolean {
  let light = 0;
  for (let i = 0; i < f.m.length; i++) if (f.m[i] > 150) light++;
  return light / f.m.length > 0.55;
}

export interface Page {
  start: number;
  end: number;
  /** A calm moment in the middle of the page, for reading it. */
  readAt: number;
  /** Cursor x (0..1 across the tab area) over time, when there is one. */
  cursor: { t: number; x: number }[];
  /** Thumbnail, to spot a page shown again. */
  thumb: Uint8Array;
}

/**
 * Split the measurements into pages: a page lasts while the tab area
 * looks the same (the moving cursor/highlight doesn't count).
 */
export function findPages(frames: FrameFeatures[], minSec = 1.2): Page[] {
  const pages: Page[] = [];
  let cur: { start: number; frames: FrameFeatures[] } | null = null;
  const emit = (start: number, fs: FrameFeatures[], end: number) => {
    if (end - start < minSec) return;
    const mid = fs[Math.floor(fs.length / 2)];
    pages.push({
      start,
      end,
      readAt: mid.t,
      cursor: forwardOnly(fs.map((f) => ({ t: f.t, x: cursorX(f.u, f.v) })).filter((c): c is { t: number; x: number } => c.x !== null)),
      thumb: mid.m,
    });
  };
  const close = (end: number) => {
    if (!cur) return;
    // The same line played twice looks like one page: split where the
    // cursor goes back to the start.
    const fs = cur.frames;
    let start = cur.start;
    let from = 0;
    for (const i of sweepStarts(fs)) {
      emit(start, fs.slice(from, i), fs[i].t);
      start = fs[i].t;
      from = i;
    }
    emit(start, fs.slice(from), end);
    cur = null;
  };
  for (const f of frames) {
    if (!looksLikeTab(f)) {
      close(f.t);
      continue;
    }
    if (!cur) {
      cur = { start: f.t, frames: [f] };
      continue;
    }
    const ref = cur.frames[cur.frames.length - 1];
    if (changedCells(ref.m, f.m, [cursorX(ref.u, ref.v), cursorX(f.u, f.v)]) >= 3) {
      close(f.t);
      cur = { start: f.t, frames: [f] };
    } else cur.frames.push(f);
  }
  if (cur) close((cur as { frames: FrameFeatures[] }).frames[(cur as { frames: FrameFeatures[] }).frames.length - 1].t + 0.25);
  return pages;
}

/**
 * Where the cursor jumps back from the right part to the left and carries
 * on from there (the next reading agrees), a new sweep starts. A single
 * stray reading doesn't count.
 */
export function sweepStarts(fs: FrameFeatures[]): number[] {
  const seen: { i: number; x: number }[] = [];
  for (let i = 0; i < fs.length; i++) {
    const x = cursorX(fs[i].u, fs[i].v);
    if (x !== null) seen.push({ i, x });
  }
  const out: number[] = [];
  let top = -1;
  for (let k = 1; k + 1 < seen.length; k++) {
    top = Math.max(top, seen[k - 1].x);
    const a = seen[k];
    const b = seen[k + 1];
    if (top > 0.55 && a.x < top - 0.4 && b.x < top - 0.4 && b.x >= a.x - 0.01 && b.i - a.i <= 8) {
      // Not right at the page's edges.
      if (a.i >= 4 && fs.length - a.i >= 4) out.push(a.i);
      top = -1;
    }
  }
  return out;
}

/**
 * The cursor only moves forward through a page: keep the longest run of
 * readings that never goes backwards (drops stray coloured marks).
 */
export function forwardOnly(c: { t: number; x: number }[]): { t: number; x: number }[] {
  const n = c.length;
  if (n < 2) return c;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++)
      if (c[j].x <= c[i].x + 0.01 && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
  let end = 0;
  for (let i = 1; i < n; i++) if (len[i] > len[end]) end = i;
  const out: { t: number; x: number }[] = [];
  for (let i = end; i >= 0; i = prev[i]) out.unshift(c[i]);
  return out;
}

/**
 * Where the playback cursor is (0..1): a narrow column whose colour differs
 * from the columns around it (blue in some videos, pale cyan in others),
 * also when it runs through a bar highlighted yellow or green. Colour is
 * compared as a whole (blue vs yellow are opposite, not "both coloured").
 * Wide coloured areas and their edges don't count. Null when there's none.
 */
export function cursorX(u: Uint8Array, v?: Uint8Array): number | null {
  const n = u.length;
  const med = (a: Uint8Array | undefined, i: number, win: number[]) => {
    if (!a) return 128;
    win.length = 0;
    for (let k = Math.max(0, i - 10); k <= Math.min(n - 1, i + 10); k++) win.push(a[k]);
    win.sort((p, q) => p - q);
    return win[win.length >> 1];
  };
  const win: number[] = [];
  const lift = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lift[i] = Math.abs(u[i] - med(u, i, win)) + (v ? Math.abs(v[i] - med(v, i, win)) : 0);
  }
  let best = 0;
  let at = -1;
  for (let i = 0; i < n; i++)
    if (lift[i] > best) {
      best = lift[i];
      at = i;
    }
  if (best < 6) return null;
  // Narrow: a few columns away on both sides it's back to normal.
  const away = (d: number) => {
    const j = at + d;
    return j < 0 || j >= n ? 0 : lift[j];
  };
  if (Math.max(away(-5), away(-6), away(5), away(6)) > best / 2) return null;
  // Its middle (a thick line spans 2–3 columns).
  let a = at;
  let b = at;
  while (a > 0 && lift[a - 1] > best / 2) a--;
  while (b < n - 1 && lift[b + 1] > best / 2) b++;
  return (a + b) / 2 / (n - 1);
}

// --- Characters → notes -----------------------------------------------------------------

export interface OcrChar {
  c: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf?: number;
}

export interface ScreenNote {
  /** 1 = high e … 6 = low E */
  string: number;
  fret: number;
  /** x of the note's centre, in video pixels. */
  x: number;
}

const DIGITISH: Record<string, string> = { O: "0", o: "0", D: "0", Q: "0", l: "1", I: "1", "|": "1", Z: "2", S: "5", s: "5", B: "8" };

/**
 * Digits on the staff lines become notes: each digit belongs to the line
 * through its middle; neighbours on the same line make two-digit frets.
 * `lines` are the staff lines in video pixels.
 */
export function charsToNotes(chars: OcrChar[], lines: number[]): ScreenNote[] {
  const spacing = (lines[5] - lines[0]) / 5;
  const digits = chars
    .map((ch) => ({ ...ch, d: /^\d$/.test(ch.c) ? ch.c : DIGITISH[ch.c] }))
    .filter((ch) => ch.d !== undefined && ch.h < spacing * 1.6 && ch.h > spacing * 0.3)
    .map((ch) => {
      const cy = ch.y + ch.h / 2;
      let s = 0;
      let best = Infinity;
      lines.forEach((ly, i) => {
        if (Math.abs(cy - ly) < best) {
          best = Math.abs(cy - ly);
          s = i + 1;
        }
      });
      return { ...ch, string: best < spacing * 0.45 ? s : 0 };
    })
    .filter((ch) => ch.string > 0)
    .sort((a, b) => a.string - b.string || a.x - b.x);

  const notes: ScreenNote[] = [];
  for (let i = 0; i < digits.length; i++) {
    const a = digits[i];
    const b = digits[i + 1];
    // "12": two digits close together on the same line
    if (b && b.string === a.string && b.x - (a.x + a.w) < a.h * 0.35 && b.x > a.x) {
      const fret = Number(a.d + b.d);
      if (fret <= 24) {
        notes.push({ string: a.string, fret, x: (a.x + b.x + b.w) / 2 });
        i++;
        continue;
      }
    }
    notes.push({ string: a.string, fret: Number(a.d), x: a.x + a.w / 2 });
  }
  return notes.sort((p, q) => p.x - q.x || p.string - q.string);
}

/**
 * The same page read at a few moments (the cursor or a highlight can hide a
 * digit, and the reader sometimes misses or misreads one): keep a note
 * when most readings agree it's there, with the fret most of them saw.
 * `tol` is how far apart (x, video pixels) the same digit can be read.
 */
export function mergeReadings(readings: ScreenNote[][], tol: number): ScreenNote[] {
  const used = readings.filter((r) => r.length > 0);
  if (used.length <= 1) return used[0] ?? [];
  const need = Math.ceil(readings.length / 2);
  const groups: { string: number; xs: number[]; frets: number[]; from: Set<number> }[] = [];
  readings.forEach((r, ri) => {
    for (const n of r) {
      const g = groups.find((q) => q.string === n.string && !q.from.has(ri) && Math.abs(q.xs[0] - n.x) <= tol);
      if (g) {
        g.xs.push(n.x);
        g.frets.push(n.fret);
        g.from.add(ri);
      } else groups.push({ string: n.string, xs: [n.x], frets: [n.fret], from: new Set([ri]) });
    }
  });
  const out: ScreenNote[] = [];
  for (const g of groups) {
    if (g.from.size < need) continue;
    const count = new Map<number, number>();
    for (const f of g.frets) count.set(f, (count.get(f) ?? 0) + 1);
    let fret = g.frets[0];
    for (const [f, c] of count) if (c > (count.get(fret) ?? 0)) fret = f;
    out.push({ string: g.string, fret, x: g.xs.reduce((a, b) => a + b, 0) / g.xs.length });
  }
  return out.sort((p, q) => p.x - q.x || p.string - q.string);
}

/** Notes in the same column (played together) share an x within this much. */
export function columns(notes: ScreenNote[], spacing: number): ScreenNote[][] {
  const cols: ScreenNote[][] = [];
  for (const n of notes) {
    const last = cols[cols.length - 1];
    if (last && Math.abs(n.x - last[0].x) < spacing * 0.6 && !last.some((m) => m.string === n.string)) last.push(n);
    else cols.push([n]);
  }
  return cols;
}

/**
 * When each column is played. With a cursor: the moment it reaches the
 * column. Without: spread evenly over the time the page is shown.
 * `rect` maps the cursor's 0..1 to video x.
 */
export function timeColumns(cols: ScreenNote[][], page: Page, rect: Rect): { t: number; timed: boolean }[] {
  const xs = cols.map((c) => (c.reduce((a, n) => a + n.x, 0) / c.length - rect.x) / rect.w);
  const cur = page.cursor;
  const moving = cur.length >= 3 && cur[cur.length - 1].x - cur[0].x > 0.2;
  if (moving) {
    return xs.map((x) => {
      // first sample at or past the column, interpolated with the one before
      for (let i = 0; i < cur.length; i++) {
        if (cur[i].x >= x - 0.004) {
          if (i === 0) return { t: cur[0].t, timed: true };
          const p = cur[i - 1];
          const q = cur[i];
          const k = q.x === p.x ? 0 : (x - p.x) / (q.x - p.x);
          return { t: p.t + Math.max(0, Math.min(1, k)) * (q.t - p.t), timed: true };
        }
      }
      return { t: Math.max(page.start, page.end - 0.15), timed: false };
    });
  }
  const n = xs.length;
  return xs.map((_, i) => ({ t: page.start + ((i + 0.5) / n) * (page.end - page.start), timed: false }));
}

/** Decode base64 bytes (from the phone) into a Uint8Array. */
export function bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
