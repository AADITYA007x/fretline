// Finding the tab's digits ourselves, then letting the text reader read
// them laid out neatly in a row.
//
// Text readers are made for lines of words; tab is scattered single digits
// sitting on lines, stacked in chords, next to stems and bar lines, and the
// reader misses many and mixes up some (3 and 8). So: find each digit-sized
// mark that sits on a staff line, copy them into a clean row ("3 2 0 12 5…")
// with space around each, read that, and put the answers back where the
// marks were.

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
}

export interface Layout {
  gray: Uint8Array;
  w: number;
  h: number;
  /** Where each token went in the layout image. */
  slots: { x0: number; x1: number; y0: number; y1: number; marks: number }[];
}

function background(gray: Uint8Array): number {
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
  const cut = Math.min(150, bg * 0.62);
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

function blobs(m: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || seen[i]) continue;
    const b: Blob = { x0: w, y0: h, x1: -1, y1: -1, n: 0 };
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
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
  const thin = ink / (b.bw * b.bh) < 0.3;
  const lean = Math.abs(mid(b.y0, b.y0 + third - 1) - mid(b.y1 - third + 1, b.y1));
  return thin && lean > b.bw * 0.45;
}

/**
 * The digit-sized marks centred on a staff line. Two marks side by side on
 * the same line (a "12") become one token. `lines` are y's in the image.
 */
export function findTokens(gray: Uint8Array, w: number, h: number, lines: number[]): Token[] {
  const sp = (lines[5] - lines[0]) / 5;
  const m = inkMask(gray, w, h);
  const marks = blobs(m, w, h)
    .map((b) => ({ ...b, bw: b.x1 - b.x0 + 1, bh: b.y1 - b.y0 + 1 }))
    .filter((b) => b.bh >= sp * 0.45 && b.bh <= sp * 1.05 && b.bw <= sp * 0.95 && b.bw >= 1)
    .filter((b) => !isSlash(m, w, b))
    .map((b) => {
      const cy = (b.y0 + b.y1) / 2;
      let s = 0;
      let best = Infinity;
      lines.forEach((ly, i) => {
        if (Math.abs(cy - ly) < best) {
          best = Math.abs(cy - ly);
          s = i + 1;
        }
      });
      return { ...b, string: best <= sp * 0.3 ? s : 0 };
    })
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
      continue;
    }
    tokens.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, string: b.string, marks: 1 });
  }
  return tokens.sort((a, b) => a.x0 - b.x0 || a.string - b.string);
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
          if (mask[sy * w + sx]) out[(oy + yy) * W + x + xx] = 0;
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

/**
 * Put what was read in the layout back on the tokens: each character
 * belongs to the slot its centre is in. Returns the fret per token (null
 * where nothing sensible was read, or an X).
 */
export function readTokens(layout: Layout, chars: ReadChar[]): (number | null)[] {
  const got: { cx: number; c: string }[][] = layout.slots.map(() => []);
  for (const ch of chars) {
    const cx = ch.x + ch.w / 2;
    const cy = ch.y + ch.h / 2;
    const i = layout.slots.findIndex((s) => cx >= s.x0 - 4 && cx <= s.x1 + 4 && cy >= s.y0 - 4 && cy <= s.y1 + 4);
    if (i < 0) continue;
    for (const c of ch.c) {
      const d = /\d/.test(c) ? c : (DIGITISH[c] ?? (c === "x" || c === "X" ? "x" : ""));
      if (d) got[i].push({ cx, c: d });
    }
  }
  return got.map((list, i) => {
    const slot = layout.slots[i];
    if (!list.length || list.some((g) => g.c === "x")) return null;
    // A single mark is a single digit: keep the one nearest the middle.
    const mid = (slot.x0 + slot.x1) / 2;
    const keep = [...list].sort((p, q) => Math.abs(p.cx - mid) - Math.abs(q.cx - mid)).slice(0, slot.marks);
    const t = keep.sort((p, q) => p.cx - q.cx).map((g) => g.c).join("");
    const n = Number(t);
    return n <= 24 ? n : Number(t[0]);
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

/**
 * All of it together: the notes in one tab area. `read` reads a layout
 * picture (ML Kit on the phone). x of each note is in video pixels.
 */
export async function notesFromArea(
  area: Area,
  lines: number[],
  read: (l: Layout) => Promise<ReadChar[]>,
): Promise<{ string: number; fret: number; x: number }[]> {
  const local = lines.map((y) => y - area.y);
  const tokens = findTokens(area.gray, area.w, area.h, local);
  if (!tokens.length) return [];
  const lay = layOut(area.gray, area.w, area.h, tokens, local);
  const frets = readTokens(lay, await read(lay));
  const out: { string: number; fret: number; x: number }[] = [];
  tokens.forEach((t, i) => {
    const f = frets[i];
    if (f !== null) out.push({ string: t.string, fret: f, x: area.x + (t.x0 + t.x1) / 2 });
  });
  return out.sort((p, q) => p.x - q.x || p.string - q.string);
}
