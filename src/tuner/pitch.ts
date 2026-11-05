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
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
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
 * Samples to analyse at once: about six periods of the lowest note we
 * listen for (a power of two, for the audio analyser). Each half must still
 * hold three periods for the spectrum to separate the partials.
 */
export function frameSizeFor(minFreq: number, sampleRate: number): number {
  let size = 4096;
  while (size < (12 * sampleRate) / minFreq && size < 16384) size *= 2;
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

  let freq = opts.sampleRate / better;
  const clarity = Math.max(0, Math.min(1, 1 - d[tau]));

  // The period above blends all the partials, and a guitar's upper partials
  // run sharp (stiff strings), so it reads a few cents high. Other tuners
  // show the fundamental, so measure that partial exactly from the spectrum.
  const spec = spectrumOf(buf);
  freq = fixSubharmonic(spec, freq, opts.sampleRate, opts.maxFreq);
  const exact = measureFundamental(spec, freq, opts.sampleRate);
  if (exact && Math.abs(centsOff(exact, freq)) < 35) freq = exact;

  if (freq < opts.minFreq * 0.9 || freq > opts.maxFreq * 1.1) return null;
  return { freq, clarity };
}

// --- Spectrum: exact partial frequencies ------------------------------------------

/**
 * Two Hann-windowed spectra of the buffer's halves (A = first half,
 * B = second half). Comparing their phases gives a partial's frequency far
 * more precisely than the bin spacing (the "phase vocoder" trick).
 */
interface Spectrum {
  size: number;
  hop: number;
  reA: Float64Array;
  imA: Float64Array;
  reB: Float64Array;
  imB: Float64Array;
}

let specCache: Spectrum | null = null;
let hann = new Float64Array(0);

function spectrumOf(buf: Float32Array): Spectrum {
  let size = 1;
  while (size * 2 <= buf.length) size <<= 1;
  size >>= 1; // each half
  const hop = buf.length - size; // B is the last `size` samples
  if (!specCache || specCache.size !== size) {
    specCache = {
      size,
      hop,
      reA: new Float64Array(size),
      imA: new Float64Array(size),
      reB: new Float64Array(size),
      imB: new Float64Array(size),
    };
    hann = new Float64Array(size);
    for (let i = 0; i < size; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  const s = specCache;
  s.hop = hop;
  for (let i = 0; i < size; i++) {
    s.reA[i] = buf[i] * hann[i];
    s.reB[i] = buf[i + hop] * hann[i];
  }
  s.imA.fill(0);
  s.imB.fill(0);
  fft(s.reA, s.imA, false);
  fft(s.reB, s.imB, false);
  return s;
}

function mag(s: Spectrum, k: number): number {
  return Math.hypot(s.reA[k], s.imA[k]) + Math.hypot(s.reB[k], s.imB[k]);
}

/** Strongest bin within ±`cents` of `freq`, or −1. */
function peakBin(s: Spectrum, freq: number, sampleRate: number, cents: number): number {
  const binHz = sampleRate / s.size;
  const lo = Math.max(1, Math.floor((freq * Math.pow(2, -cents / 1200)) / binHz));
  const hi = Math.min(s.size / 2 - 2, Math.ceil((freq * Math.pow(2, cents / 1200)) / binHz));
  let best = -1;
  for (let k = lo; k <= hi; k++) if (best < 0 || mag(s, k) > mag(s, best)) best = k;
  return best;
}

function princarg(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

/** Exact frequency of the partial near `approx` (Hz), from the phase change. */
function partialFreq(s: Spectrum, approx: number, sampleRate: number): number | null {
  const k = peakBin(s, approx, sampleRate, 60);
  if (k < 2) return null;
  // First a coarse estimate from the magnitude shape (within a bin)…
  const a = Math.log(mag(s, k - 1) + 1e-12);
  const b = Math.log(mag(s, k) + 1e-12);
  const c = Math.log(mag(s, k + 1) + 1e-12);
  const denom = a - 2 * b + c;
  const delta = denom < 0 ? (0.5 * (a - c)) / denom : 0;
  const coarse = ((k + delta) * sampleRate) / s.size;
  // …then the phase advance over the hop pins it down.
  const phaseA = Math.atan2(s.imA[k], s.reA[k]);
  const phaseB = Math.atan2(s.imB[k], s.reB[k]);
  const expected = (2 * Math.PI * coarse * s.hop) / sampleRate;
  const fine = coarse + (princarg(phaseB - phaseA - expected) * sampleRate) / (2 * Math.PI * s.hop);
  return Number.isFinite(fine) ? fine : null;
}

/**
 * The note's exact frequency from its lowest partials. Each partial m gives
 * an estimate (its frequency ÷ m); strong ones count more. On a phone lying
 * on the guitar, the fundamental of the higher strings fades within a second
 * while the 2nd–3rd partials ring on steadily, so using only the fundamental
 * makes the reading wander. Stiff strings make higher partials a touch
 * sharp, so only partials 1–4 are used and weak ones are ignored.
 */
function measureFundamental(s: Spectrum, f0: number, sampleRate: number): number | null {
  const est: { f: number; w: number }[] = [];
  let strongest = 0;
  for (let m = 1; m <= 4; m++) {
    if (m * f0 > sampleRate / 2 - 200) break;
    const k = peakBin(s, m * f0, sampleRate, 40);
    if (k < 2) continue;
    const w = mag(s, k);
    const f = partialFreq(s, m * f0, sampleRate);
    if (!f) continue;
    est.push({ f: f / m, w: w / m });
    strongest = Math.max(strongest, w);
  }
  const good = est.filter((e) => e.w >= strongest * 0.3);
  if (!good.length) return null;
  const mid = median(good.map((e) => e.f));
  const near = good.filter((e) => Math.abs(centsOff(e.f, mid)) < 12);
  let sum = 0;
  let wsum = 0;
  for (const e of near) {
    sum += e.f * e.w * e.w;
    wsum += e.w * e.w;
  }
  return wsum > 0 ? sum / wsum : null;
}

/**
 * The period can come out 2–5× too long (another string ringing along, the
 * guitar body, a fading note), which makes a high E look like a low C. If
 * only every k-th partial of the supposed note is really there, the note is
 * k times higher. Repeats, so ÷4 is fixed as ÷2 twice.
 */
function fixSubharmonic(s: Spectrum, f0: number, sampleRate: number, maxFreq: number): number {
  let f = f0;
  for (let round = 0; round < 4; round++) {
    const mags: number[] = [0];
    for (let m = 1; m <= 10; m++) {
      if (m * f > sampleRate / 2 - 200) break;
      const k = peakBin(s, m * f, sampleRate, 25);
      mags.push(k > 0 ? mag(s, k) : 0);
    }
    let moved = false;
    for (const k of [2, 3, 5]) {
      if (f * k > maxFreq * 1.1) continue;
      let on = 0;
      let off = 0;
      for (let m = 1; m < mags.length; m++) {
        if (m % k === 0) on = Math.max(on, mags[m]);
        else off = Math.max(off, mags[m]);
      }
      if (on > 0 && off < on * 0.08) {
        f *= k;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return f;
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

  /**
   * `canJump`: whether a different note may take over. Pass false when no
   * new pluck happened recently: a ringing string's quiet tail (or another
   * string humming along) then can't replace the note being tuned.
   */
  push(freq: number, canJump = true): number {
    if (!this.readings.length) {
      this.readings.push(freq);
      return freq;
    }
    const current = median(this.readings);
    if (Math.abs(centsOff(freq, current)) > 40) {
      if (!canJump) return current;
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
