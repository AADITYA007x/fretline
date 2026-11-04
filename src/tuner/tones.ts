// Reference tone samples, generated in code (no audio files).

/**
 * A plucked-string sound (Karplus-Strong) at exactly `freq`, with an
 * all-pass filter for the fractional part of the period.
 */
export function pluckSamples(freq: number, sampleRate: number, seconds = 3): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  // Loop delay = line length − ½ (two-point average) + δ (all-pass).
  // Pick the line length so δ lands in 0.1–1.1, where the all-pass is accurate.
  const x = sampleRate / freq + 0.5;
  const lineLen = Math.max(2, Math.floor(x - 0.1));
  const delta = x - lineLen;
  const apC = (1 - delta) / (1 + delta);
  const line = new Float32Array(lineLen);
  let seed = 12345;
  for (let i = 0; i < lineLen; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    line[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  const decay = Math.pow(0.001, 1 / (freq * 2.6)); // rings for ~2.6 s
  let idx = 0;
  let apX = 0;
  let apY = 0;
  for (let i = 0; i < n; i++) {
    const cur = line[idx];
    const next = line[(idx + 1) % lineLen];
    const avg = 0.5 * (cur + next) * decay;
    const y = apC * avg + apX - apC * apY; // y = c·x + x₋₁ − c·y₋₁
    apX = avg;
    apY = y;
    line[idx] = y;
    out[i] = cur * 0.5;
    idx = (idx + 1) % lineLen;
  }
  const fadeIn = Math.round(sampleRate * 0.003);
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  const fadeOut = Math.round(sampleRate * 0.2);
  for (let i = 0; i < fadeOut && i < n; i++) out[n - 1 - i] *= i / fadeOut;
  return out;
}

/** A steady tone that loops without a click (whole number of cycles). */
export function sustainSamples(freq: number, sampleRate: number, seconds = 1): Float32Array {
  // A whole number of cycles in a whole number of samples, so the loop is
  // seamless; the tiny rounding shifts the pitch by under 0.05 cents.
  const cycles = Math.max(1, Math.ceil(freq * seconds));
  const n = Math.round((cycles * sampleRate) / freq);
  const f = (cycles * sampleRate) / n;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * f * i) / sampleRate;
    out[i] = 0.32 * (Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph) + 0.08 * Math.sin(4 * ph));
  }
  return out;
}
