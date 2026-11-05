// Finding the tab's digits ourselves, then letting the text reader read
// them laid out neatly in a row.
//
// Text readers are made for lines of words; tab is scattered single digits
// sitting on lines, stacked in chords, next to stems and bar lines, and the
// reader misses many and mixes up some (3 and 8). So: find each digit-sized
// mark that sits on a staff line, copy them into a clean row ("3 2 0 12 5…")
// with space around each, read that, and put the answers back where the
// marks were.

import { best, classify, SIZE, vectorize, type Model } from "./digits";

export interface Token {
  /** Box in the area image (pixels). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 1 = high e … 6 = low E. */
  string: number;
  /** Marks joined into it: 1 for "3", 2 for "12". */
  marks: number;
  /** Each mark's box (left to right), for reading them one by one. */
  parts: { x0: number; y0: number; x1: number; y1: number }[];
  /** From the marks around it: a slide into it, a hammer-on/pull-off arc. */
  tech?: "slide" | "hammer" | "pull";
  /** A strum arrow drawn next to its chord (as drawn: ↑ or ↓). */
  strum?: "up" | "down";
}

export interface Layout {
  gray: Uint8Array;
  w: number;
  h: number;
  /** Where each token went in the layout image. */
  slots: { x0: number; x1: number; y0: number; y1: number; marks: number }[];
}

export function background(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  let seen = 0;
  const want = gray.length * 0.8;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= want) return v;
  }
  return 255;
}

/** Dark ink (digits, stems, bar lines; not the grey staff lines or a pale highlight). */
export function inkMask(gray: Uint8Array, w: number, h: number): Uint8Array {
  const bg = background(gray);
  // Between the paper and the darkest ink: light grey digits count too.
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  let seen = 0;
  let dark = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= gray.length * 0.01) {
      dark = v;
      break;
    }
  }
  const cut = Math.max(Math.min(150, bg * 0.62), Math.min(bg * 0.72, bg - (bg - dark) * 0.45));
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = gray[i] < cut ? 1 : 0;
  return m;
}

interface Blob {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  n: number;
}

function blobs(m: Uint8Array, w: number, h: number, label?: Int32Array): Blob[] {
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || seen[i]) continue;
    const b: Blob = { x0: w, y0: h, x1: -1, y1: -1, n: 0 };
    const id = out.length + 1;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      if (label) label[p] = id;
      const x = p % w;
      const y = (p - x) / w;
      b.n++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (m[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
    }
    out.push(b);
  }
  return out;
}

/**
 * A slide mark ("/" or "\\" between two frets): thin and slanted, its ink
 * on one side at the top and the other at the bottom.
 */
function isSlash(m: Uint8Array, w: number, b: { x0: number; y0: number; x1: number; y1: number; bw: number; bh: number }): boolean {
  if (b.bw < b.bh * 0.4) return false;
  const third = Math.max(1, Math.floor(b.bh / 3));
  const mid = (y0: number, y1: number) => {
    let sx = 0;
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = b.x0; x <= b.x1; x++)
        if (m[y * w + x]) {
          sx += x;
          n++;
        }
    return n ? sx / n : (b.x0 + b.x1) / 2;
  };
  let ink = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) ink += m[y * w + x];
  const density = ink / (b.bw * b.bh);
  const lean = Math.abs(mid(b.y0, b.y0 + third - 1) - mid(b.y1 - third + 1, b.y1));
  // Digits are taller than wide; a slide mark lying flatter can be thicker.
  if (b.bw >= b.bh * 1.2) return density < 0.5 && lean > b.bw * 0.4;
  return density < 0.3 && lean > b.bw * 0.45;
}

/**
 * A digit can touch its stem (the line hanging below it, or above it in
 * some tabs), making one tall mark. Keep the wider part, the digit itself;
 * marks that are already digit-sized are left alone.
 */
function withoutStems(b: Blob, id: number, label: Int32Array, w: number, sp: number): Blob[] {
  const bh = b.y1 - b.y0 + 1;
  const bw = b.x1 - b.x0 + 1;
  if (bh <= sp * 1.05 || bh > sp * 7 || bw > sp * 0.95) return [b];
  const wide = Math.max(3, sp * 0.3);
  const rows: { x0: number; x1: number; n: number }[] = [];
  for (let y = b.y0; y <= b.y1; y++) {
    let x0 = Infinity;
    let x1 = -1;
    for (let x = b.x0; x <= b.x1; x++)
      if (label[y * w + x] === id) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    rows.push({ x0, x1, n: x1 >= 0 ? x1 - x0 + 1 : 0 });
  }
  const out: Blob[] = [];
  const gapMax = Math.max(1, Math.round(sp * 0.2));
  let start = -1;
  let last = -1;
  const close = () => {
    if (start < 0) return;
    const part = rows.slice(start, last + 1);
    const ph = last - start + 1;
    // The rest must be a straight stem: narrow, upright, long enough
    // (so rests and other squiggles don't count).
    const rest = rows.filter((r, i) => (i < start || i > last) && r.n > 0);
    const mids = rest.map((r) => (r.x0 + r.x1) / 2);
    const straight =
      rest.length >= sp * 0.5 && rest.every((r) => r.n < wide) && Math.max(...mids) - Math.min(...mids) <= Math.max(1.5, sp * 0.1);
    // An arrow head on a strum arrow is a solid triangle; digits are strokes.
    let ink = 0;
    for (let y = b.y0 + start; y <= b.y0 + last; y++) for (let x = b.x0; x <= b.x1; x++) if (label[y * w + x] === id) ink++;
    const bodyW = Math.max(...part.map((r) => r.x1)) - Math.min(...part.filter((r) => r.n).map((r) => r.x0)) + 1;
    const solid = ink / (bodyW * ph) > 0.55;
    if (straight && !solid && ph >= sp * 0.45 && ph <= sp * 1.05)
      out.push({
        x0: Math.min(...part.filter((r) => r.n).map((r) => r.x0)),
        x1: Math.max(...part.map((r) => r.x1)),
        y0: b.y0 + start,
        y1: b.y0 + last,
        n: 0,
      });
    start = -1;
  };
  rows.forEach((r, i) => {
    if (r.n < wide) return;
    if (start >= 0 && i - last - 1 > gapMax) close();
    if (start < 0) start = i;
    last = i;
  });
  close();
  return out;
}

/** Which staff line a y is on (1–6), or 0 if it's not near one. */
function stringAt(y: number, lines: number[], sp: number, within: number): number {
  let s = 0;
  let best = Infinity;
  lines.forEach((ly, i) => {
    if (Math.abs(y - ly) < best) {
      best = Math.abs(y - ly);
      s = i + 1;
    }
  });
  return best <= sp * within ? s : 0;
}

/** Ink rows of one blob: leftmost/rightmost x per row and the count. */
function rowsOf(b: Blob, id: number, label: Int32Array, w: number): { x0: number; x1: number; n: number; ink: number }[] {
  const rows = [];
  for (let y = b.y0; y <= b.y1; y++) {
    let x0 = Infinity;
    let x1 = -1;
    let ink = 0;
    for (let x = b.x0; x <= b.x1; x++)
      if (label[y * w + x] === id) {
        ink++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    rows.push({ x0, x1, n: x1 >= 0 ? x1 - x0 + 1 : 0, ink });
  }
  return rows;
}

/**
 * A strum arrow: a long upright stem with a solid head at one end. Returns
 * which way it points, or null.
 */
function arrowOf(b: Blob, id: number, label: Int32Array, w: number, sp: number): "up" | "down" | null {
  const bh = b.y1 - b.y0 + 1;
  const bw = b.x1 - b.x0 + 1;
  if (bh < sp * 1.5 || bw > sp * 1.2 || bw < 3) return null;
  const rows = rowsOf(b, id, label, w);
  const stemW = Math.max(1, Math.min(...rows.filter((r) => r.n).map((r) => r.n)));
  const part = Math.max(2, Math.round(bh * 0.3));
  const top = Math.max(...rows.slice(0, part).map((r) => r.n));
  const bottom = Math.max(...rows.slice(-part).map((r) => r.n));
  const middle = rows.slice(part, -part);
  const straight = middle.every((r) => r.n <= stemW + 2);
  if (!straight) return null;
  if (bottom >= stemW * 3 && bottom >= sp * 0.35 && top <= stemW + 2) return "down";
  if (top >= stemW * 3 && top >= sp * 0.35 && bottom <= stemW + 2) return "up";
  return null;
}

/** A hammer-on/pull-off (or tie) arc: a thin curve wider than a digit, not tall. */
function isArc(m: Uint8Array, w: number, b: { x0: number; y0: number; x1: number; y1: number; bw: number; bh: number }, sp: number): boolean {
  if (b.bw < sp * 0.7 || b.bw > sp * 5 || b.bh < 2 || b.bh > sp * 0.8) return false;
  let ink = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) ink += m[y * w + x];
  if (ink / (b.bw * b.bh) > 0.5) return false;
  // Curved: the middle sits higher (∩) or lower (∪) than the ends.
  const topAt = (x: number) => {
    for (let y = b.y0; y <= b.y1; y++) if (m[y * w + x]) return y;
    return b.y1;
  };
  const ends = (topAt(b.x0) + topAt(b.x1)) / 2;
  const mid = topAt(Math.round((b.x0 + b.x1) / 2));
  return Math.abs(ends - mid) >= Math.max(1.5, b.bh * 0.4);
}

/**
 * Digits on neighbouring strings can touch (a chord written tight), making
 * one tall mark. Cut it between the strings, where the ink is thinnest.
 */
function splitStack(b: Blob, id: number, label: Int32Array, w: number, sp: number, lines: number[]): (Blob & { id: number; split?: boolean })[] {
  const bh = b.y1 - b.y0 + 1;
  const bw = b.x1 - b.x0 + 1;
  if (bh < sp * 1.3 || bh > sp * 4.5 || bw > sp * 1.4) return [{ ...b, id }];
  const cuts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const mid = (lines[i] + lines[i + 1]) / 2;
    if (mid <= b.y0 + sp * 0.3 || mid >= b.y1 - sp * 0.3) continue;
    let bestY = -1;
    let bestN = Infinity;
    for (let y = Math.round(mid - sp * 0.3); y <= Math.round(mid + sp * 0.3); y++) {
      let n = 0;
      for (let x = b.x0; x <= b.x1; x++) if (label[y * w + x] === id) n++;
      if (n < bestN) {
        bestN = n;
        bestY = y;
      }
    }
    if (bestY > 0 && bestN <= Math.max(2, bw * 0.35)) cuts.push(bestY);
  }
  if (!cuts.length) return [{ ...b, id }];
  const out: (Blob & { id: number; split: boolean })[] = [];
  let top = b.y0;
  for (const c of [...cuts, b.y1 + 1]) {
    let x0 = Infinity;
    let x1 = -1;
    let y0 = Infinity;
    let y1 = -1;
    let n = 0;
    for (let y = top; y < c; y++)
      for (let x = b.x0; x <= b.x1; x++)
        if (label[y * w + x] === id) {
          n++;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    if (n) out.push({ x0, y0, x1, y1, n, id, split: true });
    top = c + 1;
  }
  return out;
}

/**
 * The ink without long straight runs: upright ones longer than a digit
 * (stems, bar lines, arrow shafts) and flat ones longer than a wide digit
 * (beams joining stems). Digits keep their shape.
 */
function withoutLines(m: Uint8Array, w: number, h: number, sp: number): Uint8Array {
  const out = Uint8Array.from(m);
  // Where a digit's stroke crosses the line, the ink there reaches well
  // across the line: keep those pixels, take only the line itself.
  const across = Math.max(5, sp * 0.35);
  const wideAt = (x: number, y: number) => {
    let a = x;
    let b = x;
    while (a > 0 && m[y * w + a - 1]) a--;
    while (b < w - 1 && m[y * w + b + 1]) b++;
    return b - a + 1 > across;
  };
  const tallAt = (x: number, y: number) => {
    let a = y;
    let b = y;
    while (a > 0 && m[(a - 1) * w + x]) a--;
    while (b < h - 1 && m[(b + 1) * w + x]) b++;
    return b - a + 1 > across;
  };
  const vMax = sp * 1.25;
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!m[y * w + x]) {
        y++;
        continue;
      }
      const s0 = y;
      while (y < h && m[y * w + x]) y++;
      if (y - s0 > vMax) for (let k = s0; k < y; k++) if (!wideAt(x, k)) out[k * w + x] = 0;
    }
  }
  const hMax = sp * 1.6;
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!m[y * w + x]) {
        x++;
        continue;
      }
      const s0 = x;
      while (x < w && m[y * w + x]) x++;
      if (x - s0 > hMax) for (let k = s0; k < x; k++) if (!tallAt(k, y)) out[y * w + k] = 0;
    }
  }
  return out;
}

export interface Found {
  tokens: Token[];
  slides: { x0: number; x1: number; string: number }[];
  arcs: { x0: number; x1: number; y1: number }[];
  arrows: { x: number; dir: "up" | "down" }[];
}

/**
 * Everything on the staff: the digit-sized marks centred on a line (two
 * side by side, a "12", become one token), and the symbols around them —
 * slide marks, hammer-on/pull-off arcs, strum arrows. `lines` are y's in
 * the image. Techniques and strums are put on the tokens they belong to.
 */
export function findAll(gray: Uint8Array, w: number, h: number, lines: number[]): Found {
  const sp = (lines[5] - lines[0]) / 5;
  const m = inkMask(gray, w, h);
  const label = new Int32Array(w * h);
  const found = blobs(m, w, h, label);
  const arrows: Found["arrows"] = [];
  found.forEach((b, k) => {
    const dir = arrowOf(b, k + 1, label, w, sp);
    if (dir) arrows.push({ x: (b.x0 + b.x1) / 2, dir });
  });
  const arcs = found
    .map((b) => ({ ...b, bw: b.x1 - b.x0 + 1, bh: b.y1 - b.y0 + 1 }))
    .filter((b) => isArc(m, w, b, sp))
    .map((b) => ({ x0: b.x0, x1: b.x1, y1: b.y1 }));
  // Digits: first take away stems, beams and bar lines (long straight
  // runs), which can join digits to each other into one big mark.
  // Only big marks are split this way; a piece of one must look like a
  // digit (not a sliver of a wavy line or a solid arrow head).
  const m2 = withoutLines(m, w, h, sp);
  const label2 = new Int32Array(w * h);
  const fits = (b: Blob) => {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    return bh <= sp * 1.05 && bw <= sp * 1.6;
  };
  const sized = blobs(m2, w, h, label2)
    .flatMap((b, k) => splitStack(b, k + 1, label2, w, sp, lines))
    .flatMap((b) => {
      const k = b.id - 1;
      // The mark this piece came from, before lines were taken away.
      let orig = 0;
      for (let y = b.y0; y <= b.y1 && !orig; y++) for (let x = b.x0; x <= b.x1 && !orig; x++) if (label2[y * w + x] === k + 1) orig = label[y * w + x];
      const whole = orig > 0 && found[orig - 1];
      if (whole && fits(whole) && !b.split) return withoutStems(whole, orig, label, w, sp);
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      if (b.n / (bw * bh) > 0.55) return [];
      if (bw < sp * 0.35 && !b.split) return [];
      return withoutStems(b, k + 1, label2, w, sp);
    })
    .filter((b, i, all) => all.findIndex((o) => o.x0 === b.x0 && o.y0 === b.y0 && o.x1 === b.x1 && o.y1 === b.y1) === i)
    .map((b) => ({ ...b, bw: b.x1 - b.x0 + 1, bh: b.y1 - b.y0 + 1 }));
  // A narrow digit (a 1, sometimes a 7 or 4) on top of its stem is one long
  // upright line: taking lines away erases it. Its top sits about half a
  // digit above a string (a bare stem starts below one, a bar line at the
  // top string), so keep a digit's height from there.
  for (const b of found) {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    if (bh <= sp * 1.25 || bw > sp * 0.6) continue;
    const line = lines.findIndex((ly) => ly - b.y0 >= sp * 0.2 && ly - b.y0 <= sp * 0.55);
    if (line < 0 || (line === 0 && b.y1 >= lines[5] - sp * 0.2)) continue;
    const y1 = Math.min(b.y1, Math.round(lines[line] + (lines[line] - b.y0)));
    if (sized.some((o) => o.x0 <= b.x1 && o.x1 >= b.x0 && o.y0 <= y1 && o.y1 >= b.y0)) continue;
    // a stem hanging from a digit just above it is only a stem
    if (sized.some((o) => o.x0 <= b.x1 + 2 && o.x1 >= b.x0 - 2 && o.y1 <= b.y0 + 1 && b.y0 - o.y1 <= sp * 0.4)) continue;
    // and a digit has some shape at its top (a 1's flag, a 7's bar): a
    // plain stem is the same width all the way down
    const rowW = (y: number) => {
      let a = -1;
      let z = -1;
      for (let x = b.x0; x <= b.x1; x++)
        if (m[y * w + x]) {
          if (a < 0) a = x;
          z = x;
        }
      return a < 0 ? 0 : z - a + 1;
    };
    const stemW = rowW(Math.min(h - 1, y1 + Math.round(sp * 0.4)));
    let topW = 0;
    for (let y = b.y0; y < b.y0 + (y1 - b.y0) * 0.5; y++) topW = Math.max(topW, rowW(y));
    if (topW < stemW + 2) continue;
    sized.push({ x0: b.x0, x1: b.x1, y0: b.y0, y1, n: 0, bw, bh: y1 - b.y0 + 1 });
  }
  const digitSized = sized.filter((b) => b.bh >= sp * 0.45 && b.bh <= sp * 1.05 && b.bw <= sp * 0.95 && b.bw >= 1);
  // Slide marks can be shorter than a digit.
  const slides = sized
    .filter((b) => b.bh >= sp * 0.25 && b.bh <= sp * 1.05 && b.bw <= sp * 1.6 && isSlash(m, w, b))
    .map((b) => ({ x0: b.x0, x1: b.x1, string: stringAt((b.y0 + b.y1) / 2, lines, sp, 0.45) }))
    .filter((s) => s.string > 0);
  const marks = digitSized
    .filter((b) => !isSlash(m, w, b))
    .map((b) => ({ ...b, string: stringAt((b.y0 + b.y1) / 2, lines, sp, 0.3) }))
    .filter((b) => b.string > 0)
    .sort((a, b) => a.string - b.string || a.x0 - b.x0);

  const tokens: Token[] = [];
  for (const b of marks) {
    const last = tokens[tokens.length - 1];
    if (last && last.string === b.string && b.x0 - last.x1 <= sp * 0.25 && b.x1 - last.x0 <= sp * 1.4) {
      last.x1 = Math.max(last.x1, b.x1);
      last.y0 = Math.min(last.y0, b.y0);
      last.y1 = Math.max(last.y1, b.y1);
      last.marks++;
      last.parts.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
      continue;
    }
    tokens.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, string: b.string, marks: 1, parts: [{ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }] });
  }
  // A short upright line between two stacked digits (some tabs join a
  // chord's notes with one) is not a "1" on the string in between.
  const isBar = (t: Token) => {
    if (t.marks !== 1 || t.x1 - t.x0 + 1 > Math.max(3, sp * 0.22)) return false;
    let minW = Infinity;
    let maxW = 0;
    for (let y = t.y0; y <= t.y1; y++) {
      let n = 0;
      for (let x = t.x0; x <= t.x1; x++) n += m[y * w + x];
      minW = Math.min(minW, n);
      maxW = Math.max(maxW, n);
    }
    return maxW - minW <= 1;
  };
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!isBar(t)) continue;
    const cx = (t.x0 + t.x1) / 2;
    const near = (s: number) => tokens.some((o) => o !== t && o.string === s && Math.abs((o.x0 + o.x1) / 2 - cx) <= sp * 0.5);
    if (near(t.string - 1) && near(t.string + 1)) tokens.splice(i, 1);
  }
  // Two pieces close enough to be one digit (a thin "0" broken in two):
  // one digit, not a two-digit fret.
  for (const t of tokens)
    if (t.marks === 2 && t.x1 - t.x0 + 1 <= sp * 0.8) {
      t.marks = 1;
      t.parts = [{ x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 }];
    }
  tokens.sort((a, b) => a.x0 - b.x0 || a.string - b.string);

  // A slide mark between two frets on a string: the second is slid into.
  for (const sl of slides) {
    const right = tokens.find((t) => t.string === sl.string && t.x0 >= sl.x1 - 2 && t.x0 - sl.x1 <= sp * 1.2);
    const left = tokens.some((t) => t.string === sl.string && t.x1 <= sl.x0 + 2 && sl.x0 - t.x1 <= sp * 1.2);
    if (right && left) right.tech = "slide";
  }
  // An arc over two frets: from the first to the second (hammer-on or
  // pull-off, decided once the frets are read).
  for (const arc of arcs) {
    const below = tokens.filter((t) => t.y0 >= arc.y1 - 2 && t.y0 - arc.y1 <= sp * 1.3);
    const start = below.filter((t) => Math.abs((t.x0 + t.x1) / 2 - arc.x0) <= sp * 0.9);
    const end = below.filter((t) => Math.abs((t.x0 + t.x1) / 2 - arc.x1) <= sp * 0.9);
    const pair = end.find((e) => start.some((s) => s.string === e.string && s !== e));
    if (pair) pair.tech = "hammer"; // hammer or pull: set from the frets later
  }
  // A strum arrow just left of a chord: every note of that chord.
  for (const ar of arrows) {
    const next = tokens.filter((t) => t.x0 > ar.x && t.x0 - ar.x <= sp * 1.6);
    if (!next.length) continue;
    const x0 = Math.min(...next.map((t) => t.x0));
    for (const t of next) if (t.x0 - x0 <= sp * 0.5) t.strum = ar.dir;
  }
  return { tokens, slides, arcs, arrows };
}

/** Just the digit tokens (see findAll). */
export function findTokens(gray: Uint8Array, w: number, h: number, lines: number[]): Token[] {
  return findAll(gray, w, h, lines).tokens;
}

/**
 * Copy the tokens into rows of a clean white picture, `scale`× larger,
 * with a gap around each, at most `perRow` to a row. Only their ink is
 * copied (black on white).
 */
export function layOut(gray: Uint8Array, w: number, h: number, tokens: Token[], lines: number[], scale = 3, perRow = 20): Layout {
  const sp = (lines[5] - lines[0]) / 5;
  // Wide gaps, so the reader never takes two neighbours for one number.
  const gap = Math.round(sp * 2.4 * scale);
  const cellH = Math.round(sp * 1.2 * scale);
  const rowH = cellH + gap;
  const rows: Token[][] = [];
  for (let i = 0; i < tokens.length; i += perRow) rows.push(tokens.slice(i, i + perRow));
  const rowW = rows.map((r) => r.reduce((a, t) => a + (t.x1 - t.x0 + 1) * scale + gap, gap));
  const W = Math.max(gap * 2, ...rowW);
  const H = Math.max(rowH + gap, rows.length * rowH + gap);
  const out = new Uint8Array(W * H).fill(255);
  const mask = inkMask(gray, w, h);
  // Soft edges of strokes (thin, light digits) are kept too, but only
  // right next to dark ink, so staff lines and highlights stay out.
  const soft = background(gray) - 25;
  const nearInk = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) return true;
      }
    return false;
  };
  const slots: Layout["slots"] = [];
  rows.forEach((row, ri) => {
    let x = gap;
    const top = gap + ri * rowH;
    for (const t of row) {
      const tw = t.x1 - t.x0 + 1;
      const th = t.y1 - t.y0 + 1;
      const oy = top + Math.round((cellH - th * scale) / 2);
      for (let yy = 0; yy < th * scale; yy++)
        for (let xx = 0; xx < tw * scale; xx++) {
          const sx = t.x0 + Math.floor(xx / scale);
          const sy = t.y0 + Math.floor(yy / scale);
          if (mask[sy * w + sx]) out[(oy + yy) * W + x + xx] = Math.min(gray[sy * w + sx], 60);
          else if (gray[sy * w + sx] < soft && nearInk(sx, sy)) out[(oy + yy) * W + x + xx] = gray[sy * w + sx];
        }
      slots.push({ x0: x, x1: x + tw * scale, y0: top, y1: top + cellH, marks: t.marks });
      x += tw * scale + gap;
    }
  });
  return { gray: out, w: W, h: H, slots };
}

export interface ReadChar {
  c: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const DIGITISH: Record<string, string> = { O: "0", o: "0", D: "0", Q: "0", l: "1", I: "1", i: "1", "|": "1", "!": "1", Z: "2", z: "2", S: "5", s: "5", B: "8", g: "9", q: "9", A: "4", T: "7" };

/** What one token was read as. */
export interface ReadToken {
  fret: number;
  /** Shown as x: a muted/percussive hit, no fret. */
  mute?: boolean;
  harmonic?: boolean;
}

/**
 * Put what was read in the layout back on the tokens: each character
 * belongs to the slot its centre is in. null where nothing sensible was
 * read.
 */
export function readTokens(layout: Layout, chars: ReadChar[]): (ReadToken | null)[] {
  const got: { cx: number; c: string }[][] = layout.slots.map(() => []);
  const brackets = layout.slots.map(() => false);
  for (const ch of chars) {
    const cx = ch.x + ch.w / 2;
    const cy = ch.y + ch.h / 2;
    const i = layout.slots.findIndex((s) => cx >= s.x0 - 4 && cx <= s.x1 + 4 && cy >= s.y0 - 4 && cy <= s.y1 + 4);
    if (i < 0) continue;
    for (const c of ch.c) {
      if (c === "<" || c === ">") brackets[i] = true;
      const d = /\d/.test(c) ? c : (DIGITISH[c] ?? (c === "x" || c === "X" || c === "×" ? "x" : ""));
      if (d) got[i].push({ cx, c: d });
    }
  }
  return got.map((list, i) => {
    const slot = layout.slots[i];
    if (!list.length) return null;
    if (list.some((g) => g.c === "x")) return { fret: 0, mute: true };
    const digits = list.filter((g) => g.c !== "x");
    // A single mark is a single digit: keep the one nearest the middle.
    const mid = (slot.x0 + slot.x1) / 2;
    const keep = [...digits].sort((p, q) => Math.abs(p.cx - mid) - Math.abs(q.cx - mid)).slice(0, slot.marks);
    const t = keep.sort((p, q) => p.cx - q.cx).map((g) => g.c).join("");
    const n = Number(t);
    return { fret: n <= 24 ? n : Number(t[0]), harmonic: brackets[i] || undefined };
  });
}

/** A tab area from the video: grey pixels and where it sits (video pixels). */
export interface Area {
  gray: Uint8Array;
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface AreaNote {
  string: number;
  fret: number;
  /** x in video pixels. */
  x: number;
  tech?: "slide" | "hammer" | "pull" | "harmonic" | "mute";
  strum?: "up" | "down";
  /** The readers didn't agree: worth a look. */
  unsure?: boolean;
}

/** What our own reader made of a token: its text and how sure (the least sure mark). */
interface OwnRead {
  text: string;
  p: number;
  /** a font-matcher's opinion, when it had one */
  match?: string;
}

/**
 * Our digit reader on every mark, then a second opinion from this page's
 * own font: the marks it was very sure of show what each digit looks like
 * here, and every unsure mark is compared with those.
 */
function readOurselves(area: Area, tokens: Token[], sp: number, model: Model): (OwnRead | null)[] {
  const bg = background(area.gray);
  const marks = tokens.map((t) =>
    t.parts.map((p) => {
      const v = vectorize(area.gray, area.w, p, bg, sp);
      return { v, ...best(classify(model, v)) };
    }),
  );
  // this page's digits, from the sure reads
  const sums = new Map<string, { v: Float32Array; n: number }>();
  for (const ms of marks)
    for (const m of ms) {
      if (m.p < 0.97 || m.c === "-") continue;
      const s = sums.get(m.c) ?? { v: new Float32Array(SIZE * SIZE), n: 0 };
      for (let i = 0; i < SIZE * SIZE; i++) s.v[i] += m.v[i];
      s.n++;
      sums.set(m.c, s);
    }
  const looks = [...sums].filter(([, s]) => s.n >= 2);
  const cos = (a: Float32Array, b: Float32Array) => {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      ab += a[i] * b[i];
      aa += a[i] * a[i];
      bb += b[i] * b[i];
    }
    return ab / Math.sqrt(aa * bb || 1);
  };
  return marks.map((ms) => {
    const digits = ms.filter((m) => m.c !== "-");
    if (!digits.length) return { text: "-", p: Math.min(...ms.map((m) => m.p)) };
    const text = digits.map((m) => m.c).join("");
    const p = Math.min(...digits.map((m) => m.p));
    if (p >= 0.97 || !looks.length) return { text, p };
    const match = digits
      .map((m) => {
        const ranked = looks.map(([c, s]) => ({ c, sim: cos(m.v, s.v) })).sort((a, b) => b.sim - a.sim);
        const top = ranked[0];
        const second = ranked[1]?.sim ?? 0;
        return top.sim > 0.9 && top.sim - second > 0.03 ? top.c : "";
      })
      .join("");
    return { text, p, match: match.length === digits.length ? match : undefined };
  });
}

/**
 * One answer from up to three readers: ours, the page's font, ML Kit. Ours
 * when it's sure; otherwise whichever two agree; otherwise ours, marked
 * unsure. Null: not a note (or nothing readable).
 */
function decide(ours: OwnRead | null, mk: ReadToken | null): { fret: number; mute?: boolean; unsure?: boolean } | null {
  const fromText = (t: string) => (t === "x" ? { fret: 0, mute: true } : /^\d+$/.test(t) && Number(t) <= 24 ? { fret: Number(t) } : null);
  const mkText = mk ? (mk.mute ? "x" : String(mk.fret)) : null;
  if (!ours) return mk;
  if (ours.text === "-") {
    // not a digit, unless ML Kit and the page's font both say it is one
    return ours.p < 0.8 && mkText && ours.match === mkText ? { ...fromText(mkText)!, unsure: true } : null;
  }
  if (ours.p >= 0.85) return fromText(ours.text);
  const votes = [ours.text, ours.match, mkText].filter((v): v is string => !!v);
  for (const v of votes) if (votes.filter((o) => o === v).length >= 2) return fromText(v);
  const f = fromText(ours.text) ?? (mkText ? fromText(mkText) : null);
  return f ? { ...f, unsure: true } : null;
}

/**
 * All of it together: the notes in one tab area. `read` reads a layout
 * picture (ML Kit on the phone); `model` is our own digit reader.
 */
export async function notesFromArea(
  area: Area,
  lines: number[],
  read: (l: Layout) => Promise<ReadChar[]>,
  model?: Model,
): Promise<AreaNote[]> {
  const local = lines.map((y) => y - area.y);
  const sp = (local[5] - local[0]) / 5;
  const { tokens } = findAll(area.gray, area.w, area.h, local);
  if (!tokens.length) return [];
  const lay = layOut(area.gray, area.w, area.h, tokens, local);
  const got = readTokens(lay, await read(lay));
  const ours = model ? readOurselves(area, tokens, sp, model) : tokens.map(() => null);
  const out: AreaNote[] = [];
  tokens.forEach((t, i) => {
    const v = decide(ours[i], got[i]);
    if (!v) return;
    const n: AreaNote = { string: t.string, fret: v.fret, x: area.x + (t.x0 + t.x1) / 2 };
    if (v.mute) n.tech = "mute";
    else if (got[i]?.harmonic) n.tech = "harmonic";
    else if (t.tech) n.tech = t.tech;
    if (t.strum) n.strum = t.strum;
    if (v.unsure) n.unsure = true;
    out.push(n);
  });
  // An arc: hammer-on if it goes up the neck, pull-off if down.
  for (const n of out) {
    if (n.tech !== "hammer") continue;
    const before = out.filter((p) => p.string === n.string && p.x < n.x).pop();
    if (!before || before.fret === n.fret) delete n.tech;
    else n.tech = n.fret > before.fret ? "hammer" : "pull";
  }
  return out.sort((p, q) => p.x - q.x || p.string - q.string);
}
