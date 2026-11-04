// Pitch detection for the tuner: YIN (de Cheveigné & Kawahara, 2002) with
// parabolic interpolation and an octave check for guitar's strong 2nd
// harmonic. Pure functions, no DOM, so it's unit-tested with generated audio.

export interface PitchResult {
  /** Fundamental frequency in Hz. */
  freq: number;
  /** 0..1, how periodic the sound is (1 = a perfect tone). */
  clarity: number;
}

export interface DetectOptions {
  sampleRate: number;
  /** Lowest note we look for (Hz). Lower = slower; set from the instrument. */
  minFreq: number;
  /** Highest note we look for (Hz). */
  maxFreq: number;
  /** YIN threshold: lower is stricter. */
  threshold?: number;
}

/** Workspace reused between calls so the tuner doesn't allocate 20×/second. */
let scratch = new Float32Array(0);
let rawScratch = new Float32Array(0);
let energyScratch = new Float64Array(0);
let fftRe = new Float64Array(0);
let fftIm = new Float64Array(0);
let fftRe2 = new Float64Array(0);
let fftIm2 = new Float64Array(0);

/** In-place radix-2 FFT (inverse when `inverse`). Length must be a power of 2. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

/** c[τ] = Σ_{i<window} x[i]·x[i+τ] for τ = 0..maxLag, via FFT. */
function crossCorrelate(x: Float32Array, window: number, maxLag: number): Float64Array {
  let size = 1;
  while (size < window + maxLag + 1) size <<= 1;
  if (fftRe.length !== size) {
    fftRe = new Float64Array(size);
    fftIm = new Float64Array(size);
    fftRe2 = new Float64Array(size);
    fftIm2 = new Float64Array(size);
  }
  fftRe.fill(0);
  fftIm.fill(0);
  fftRe2.fill(0);
  fftIm2.fill(0);
  for (let i = 0; i < window; i++) fftRe[i] = x[i];
  const len = Math.min(x.length, window + maxLag + 1);
  for (let i = 0; i < len; i++) fftRe2[i] = x[i];
  fft(fftRe, fftIm, false);
  fft(fftRe2, fftIm2, false);
  // conj(A)·B
  for (let i = 0; i < size; i++) {
    const ar = fftRe[i];
    const ai = -fftIm[i];
    const br = fftRe2[i];
    const bi = fftIm2[i];
    fftRe[i] = ar * br - ai * bi;
    fftIm[i] = ar * bi + ai * br;
  }
  fft(fftRe, fftIm, true);
  return fftRe;
}

/**
 * Samples to analyse at once: about three periods of the lowest note we
 * listen for (a power of two, for the audio analyser).
 */
export function frameSizeFor(minFreq: number, sampleRate: number): number {
  let size = 2048;
  while (size < (3 * sampleRate) / minFreq && size < 16384) size *= 2;
  return size;
}

/** Root-mean-square level of a buffer (0..1 for normalised audio). */
export function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export function detectPitch(buf: Float32Array, opts: DetectOptions): PitchResult | null {
  const threshold = opts.threshold ?? 0.12;
  const tauMin = Math.max(2, Math.floor(opts.sampleRate / opts.maxFreq));
  const tauMax = Math.min(Math.ceil(opts.sampleRate / opts.minFreq), Math.floor(buf.length / 2) - 2);
  // Compare as much of the buffer as we have: more samples = less noise.
  const window = buf.length - tauMax - 2;
  if (tauMax <= tauMin + 2 || window < tauMax) return null;

  if (scratch.length < tauMax + 2) {
    scratch = new Float32Array(tauMax + 2);
    rawScratch = new Float32Array(tauMax + 2);
  }
  const d = scratch;
  const raw = rawScratch;

  // Difference function d(τ) = Σ (x[i] − x[i+τ])², i < window, expanded as
  // energy(0) + energy(τ) − 2·correlation(τ). The correlation comes from one
  // FFT, so this stays fast on a phone even for long bass frames.
  const corr = crossCorrelate(buf, window, tauMax + 1);
  // Running sums of x² give each energy term in O(1).
  const n = buf.length;
  if (energyScratch.length < n + 1) energyScratch = new Float64Array(n + 1);
  const cum = energyScratch;
  cum[0] = 0;
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + buf[i] * buf[i];
  const e0 = cum[window];

  // Then the cumulative mean normalised version d'(τ).
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    const sum = Math.max(0, e0 + (cum[tau + window] - cum[tau]) - 2 * corr[tau]);
    raw[tau] = sum;
    running += sum;
    d[tau] = running > 0 ? (sum * tau) / running : 1;
  }

  // First dip below the threshold. Take the lowest point of the whole dip,
  // not the first little wiggle: noise makes the bottom jagged.
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < threshold) {
      tau = t;
      while (t + 1 <= tauMax && (d[t + 1] < threshold || d[t + 1] < d[t])) {
        t++;
        if (d[t] < d[tau]) tau = t;
      }
      break;
    }
  }
  if (tau < 0) {
    // Nothing clearly periodic: take the global minimum if it's still decent.
    let best = tauMin;
    for (let t = tauMin + 1; t <= tauMax; t++) if (d[t] < d[best]) best = t;
    if (d[best] > 0.35) return null;
    tau = best;
  }

  // Octave check: a much deeper dip at twice the period means we locked onto
  // the 2nd harmonic (common on a guitar's low strings).
  const twice = tau * 2;
  if (twice + 2 <= tauMax && d[tau] > 0.03) {
    let t2 = twice - 2;
    for (let t = twice - 2; t <= twice + 2; t++) if (d[t] < d[t2]) t2 = t;
    if (d[t2] < d[tau] * 0.5) tau = t2;
  }

  // Sub-sample accuracy: fit a parabola to the bottom of the dip in the raw
  // difference function (the normalised one is tilted, which biases the
  // fit). A wider fit (least squares over ±k samples) averages out noise.
  const k = Math.max(1, Math.min(tau - 1, tauMax - tau, Math.round(tau * 0.015)));
  let better = tau;
  if (k >= 1) {
    // Fit y = a·x² + b·x + c with x = t − tau, x ∈ [−k, k] (symmetric, so
    // Σx = Σx³ = 0 and the normal equations simplify).
    let s2 = 0;
    let s4 = 0;
    let sy = 0;
    let sxy = 0;
    let sx2y = 0;
    const n = 2 * k + 1;
    for (let x = -k; x <= k; x++) {
      const y = raw[tau + x];
      s2 += x * x;
      s4 += x * x * x * x;
      sy += y;
      sxy += x * y;
      sx2y += x * x * y;
    }
    const a = (n * sx2y - s2 * sy) / (n * s4 - s2 * s2);
    const b = sxy / s2;
    if (a > 0) {
      const shift = -b / (2 * a);
      if (Math.abs(shift) <= k) better = tau + shift;
    }
  }

  const freq = opts.sampleRate / better;
  if (freq < opts.minFreq * 0.9 || freq > opts.maxFreq * 1.1) return null;
  return { freq, clarity: Math.max(0, Math.min(1, 1 - d[tau])) };
}

// --- Notes ----------------------------------------------------------------------

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** MIDI note number → frequency, with A4 (MIDI 69) at `a4` Hz. */
export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** Frequency → fractional MIDI note number. */
export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

/** Cents from `target` Hz to `freq` Hz (+ = sharp, − = flat). */
export function centsOff(freq: number, target: number): number {
  return 1200 * Math.log2(freq / target);
}

/** "E2" → 40, "F#3" → 54, "Bb2" → 46. Returns NaN when unreadable. */
export function noteToMidi(note: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note.trim());
  if (!m) return NaN;
  const base = NOTE_NAMES.indexOf(m[1].toUpperCase() as (typeof NOTE_NAMES)[number]);
  const shift = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + shift;
}

/** 40 → "E2" (sharps). */
export function midiToNote(midi: number): string {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** 40 → "E" (no octave). */
export function midiToName(midi: number): string {
  return NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12];
}

/** Median of a small list (the tuner smooths the last few readings). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Steadies the needle: keeps the last few readings of the same note and
 * reports their median. A new note (more than ~40 cents away) takes over
 * after two readings in a row agree, so a stray reading can't jerk it around.
 */
export class PitchSmoother {
  private readings: number[] = [];
  private pending: number[] = [];

  constructor(private size = 5) {}

  push(freq: number): number {
    if (!this.readings.length) {
      this.readings.push(freq);
      return freq;
    }
    const current = median(this.readings);
    if (Math.abs(centsOff(freq, current)) > 40) {
      this.pending.push(freq);
      const p = this.pending;
      if (p.length >= 2 && Math.abs(centsOff(p[p.length - 1], p[p.length - 2])) < 40) {
        this.readings = p.slice(-2);
        this.pending = [];
      }
      return median(this.readings);
    }
    this.pending = [];
    this.readings.push(freq);
    if (this.readings.length > this.size) this.readings.shift();
    return median(this.readings);
  }

  reset(): void {
    this.readings = [];
    this.pending = [];
  }
}
