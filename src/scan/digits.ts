// Our own digit reader: one small picture of a mark in, "0"–"9", "x" or
// "not a digit" out. Trained (scripts/train) on tab digits drawn in common
// tab fonts at the sizes tab videos use, plus digits from real lessons.
// It only ever has 12 answers, so it can't read a 0 as "O" or a 2 as "Z".

export const SIZE = 16;
/** What a mark can be. */
export const CLASSES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "x", "-"] as const;
export type DigitClass = (typeof CLASSES)[number];

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The mark as numbers the reader takes: its ink (0 = paper, 1 = darkest)
 * scaled to fit SIZE×SIZE, centred, keeping its shape; then its height
 * against the staff spacing and its width against its height.
 */
export function vectorize(gray: Uint8Array, w: number, box: Box, bg: number, spacing: number): Float32Array {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  let dark = 255;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) dark = Math.min(dark, gray[y * w + x]);
  const range = Math.max(30, bg - dark);
  const ink = (x: number, y: number) => Math.max(0, Math.min(1, (bg - gray[y * w + x]) / range));
  const out = new Float32Array(SIZE * SIZE + 2);
  const scale = (SIZE - 2) / Math.max(bw, bh);
  const ow = bw * scale;
  const oh = bh * scale;
  const ox = (SIZE - ow) / 2;
  const oy = (SIZE - oh) / 2;
  // each output pixel: the average ink of the source area it covers
  for (let Y = 0; Y < SIZE; Y++)
    for (let X = 0; X < SIZE; X++) {
      const sx0 = (X - ox) / scale;
      const sx1 = (X + 1 - ox) / scale;
      const sy0 = (Y - oy) / scale;
      const sy1 = (Y + 1 - oy) / scale;
      if (sx1 <= 0 || sy1 <= 0 || sx0 >= bw || sy0 >= bh) continue;
      let sum = 0;
      let n = 0;
      const xa = Math.max(0, Math.floor(sx0));
      const xb = Math.min(bw - 1, Math.max(xa, Math.ceil(sx1) - 1));
      const ya = Math.max(0, Math.floor(sy0));
      const yb = Math.min(bh - 1, Math.max(ya, Math.ceil(sy1) - 1));
      for (let y = ya; y <= yb; y++)
        for (let x = xa; x <= xb; x++) {
          sum += ink(box.x0 + x, box.y0 + y);
          n++;
        }
      out[Y * SIZE + X] = n ? sum / n : 0;
    }
  out[SIZE * SIZE] = bh / spacing;
  out[SIZE * SIZE + 1] = bw / bh;
  return out;
}

export interface Model {
  /** layers: weights [out][in] flattened row by row, and biases */
  layers: { w: number[]; b: number[]; in: number; out: number }[];
  /** input scaling: (x - mean) / std per input */
  mean: number[];
  std: number[];
}

/** How likely each class is, for one mark. */
export function classify(model: Model, v: Float32Array): Float32Array {
  let x = Float32Array.from(v, (val, i) => (val - model.mean[i]) / (model.std[i] || 1));
  model.layers.forEach((L, li) => {
    const y = new Float32Array(L.out);
    for (let o = 0; o < L.out; o++) {
      let s = L.b[o];
      const row = o * L.in;
      for (let i = 0; i < L.in; i++) s += L.w[row + i] * x[i];
      y[o] = li < model.layers.length - 1 ? Math.max(0, s) : s;
    }
    x = y;
  });
  let m = -Infinity;
  for (const v of x) m = Math.max(m, v);
  let sum = 0;
  const p = Float32Array.from(x, (v) => {
    const e = Math.exp(v - m);
    sum += e;
    return e;
  });
  for (let i = 0; i < p.length; i++) p[i] /= sum;
  return p;
}

/** The likeliest class and how sure. */
export function best(p: Float32Array): { c: DigitClass; p: number } {
  let k = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[k]) k = i;
  return { c: CLASSES[k], p: p[k] };
}
