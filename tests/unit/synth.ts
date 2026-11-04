// Test signals: plucked-string-like tones with a known fundamental.

/** Simple seeded random so tests are repeatable. */
export function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface PluckOptions {
  freq: number;
  sampleRate: number;
  seconds: number;
  /** Amplitude of each harmonic (index 0 = fundamental). */
  harmonics?: number[];
  /** String stiffness: partials drift sharp like a real string. */
  inharmonicity?: number;
  /** White noise level relative to the tone. */
  noise?: number;
  seed?: number;
  /** A pick attack starts the note sharp by this much, settling over ~0.15 s. */
  glideCents?: number;
  /** Phone mics lose bass: a 2nd-order low cut at this frequency. */
  lowCutHz?: number;
}

/** What a tuner should show: the first partial once the attack has settled. */
export function firstPartial(o: Pick<PluckOptions, "freq" | "inharmonicity">): number {
  return o.freq * Math.sqrt(1 + (o.inharmonicity ?? 0.00008));
}

export function pluck(o: PluckOptions): Float32Array {
  const n = Math.round(o.seconds * o.sampleRate);
  const out = new Float32Array(n);
  const harmonics = o.harmonics ?? [1, 0.6, 0.4, 0.25, 0.15, 0.1];
  const B = o.inharmonicity ?? 0.00008;
  const rand = rng(o.seed ?? 7);
  const phases = harmonics.map(() => rand() * Math.PI * 2);
  for (let h = 0; h < harmonics.length; h++) {
    const k = h + 1;
    const f = k * o.freq * Math.sqrt(1 + B * k * k);
    if (f > o.sampleRate / 2) break;
    const decay = 1.2 + 0.6 * k; // higher partials die faster
    let amp = harmonics[h];
    if (o.lowCutHz) {
      const r = (f / o.lowCutHz) ** 2;
      amp *= r / Math.sqrt(1 + r * r);
    }
    const glide = o.glideCents ?? 0;
    let phase = phases[h];
    for (let i = 0; i < n; i++) {
      const t = i / o.sampleRate;
      const fi = glide ? f * Math.pow(2, (glide * Math.exp(-t / 0.15)) / 1200) : f;
      phase += (2 * Math.PI * fi) / o.sampleRate;
      out[i] += amp * Math.exp(-decay * t) * Math.sin(phase);
    }
  }
  // Pick attack: a short click of noise at the start.
  for (let i = 0; i < Math.min(n, o.sampleRate * 0.01); i++) out[i] += (rand() * 2 - 1) * 0.5;
  if (o.noise) for (let i = 0; i < n; i++) out[i] += (rand() * 2 - 1) * o.noise;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.5;
  return out;
}

/** Cut `size` samples starting at `seconds`. */
export function frameAt(buf: Float32Array, sampleRate: number, seconds: number, size: number): Float32Array {
  const start = Math.round(seconds * sampleRate);
  return buf.slice(start, start + size);
}

/** Mix signals (e.g. a played string plus other strings ringing along). */
export function mix(...parts: [Float32Array, number][]): Float32Array {
  const n = Math.min(...parts.map(([p]) => p.length));
  const out = new Float32Array(n);
  for (const [p, gain] of parts) for (let i = 0; i < n; i++) out[i] += p[i] * gain;
  return out;
}
