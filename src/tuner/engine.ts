// Tuner audio: listens to the mic and reports pitch readings; plays
// reference tones. All browser audio (Web Audio + getUserMedia), which the
// Android app's WebView supports once the mic permission is granted.
import { detectPitch, frameSizeFor, PitchSmoother, rms } from "./pitch";
import { pluckSamples, sustainSamples } from "./tones";

export interface Reading {
  /** Smoothed frequency (Hz). */
  freq: number;
  clarity: number;
  /** Input level 0..1. */
  level: number;
}

export type MicError = "denied" | "unavailable" | "unsupported";

const SILENCE = 0.004; // below this RMS, nothing is being played
const MIN_CLARITY = 0.8;
const EVERY_MS = 45;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let frame = new Float32Array(4096);
let range = { minFreq: 60, maxFreq: 450 };
const smoother = new PitchSmoother(7);
let lastLevel = 0;
let onsetAt = 0;
// A picked note starts sharp, and the analysis frame (up to ~0.35 s) needs
// to be mostly past the pluck before a reading is fair.
let attackMs = 150;
const JUMP_MS = 900; // a different note needs a fresh pluck within this long
let quietSince = 0;
let mutedUntil = 0;
let listener: (r: Reading | null) => void = () => {};

function audioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: "interactive" });
  }
  return ctx;
}

export function isListening(): boolean {
  return stream !== null;
}

export function onReading(fn: (r: Reading | null) => void): void {
  listener = fn;
}

/** Which notes to listen for (from the tuning). Bass needs longer frames. */
export function setRange(minFreq: number, maxFreq: number): void {
  range = { minFreq, maxFreq };
  smoother.reset();
  if (analyser && ctx) {
    analyser.fftSize = frameSizeFor(minFreq, ctx.sampleRate);
    frame = new Float32Array(analyser.fftSize);
    attackMs = Math.max(150, ((analyser.fftSize / ctx.sampleRate) * 1000) * 0.75);
  }
}

export function resetSmoothing(): void {
  smoother.reset();
}

export async function startListening(): Promise<void> {
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw "unsupported" satisfies MicError;
  const ac = audioContext();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    const name = (err as DOMException)?.name ?? "";
    throw (name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable") satisfies MicError;
  }
  if (ac.state !== "running") await ac.resume().catch(() => {});
  source = ac.createMediaStreamSource(stream);
  analyser = ac.createAnalyser();
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  setRange(range.minFreq, range.maxFreq);
  smoother.reset();
  timer = setInterval(tick, EVERY_MS);
}

export function stopListening(): void {
  if (timer) clearInterval(timer);
  timer = null;
  source?.disconnect();
  source = null;
  analyser = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  smoother.reset();
}

function tick(): void {
  if (!analyser || !ctx) return;
  analyser.getFloatTimeDomainData(frame);
  // Loudness of just the last ~40 ms: the long analysis frame would blur a
  // new pluck or a mute.
  const level = rms(frame.subarray(frame.length - 2048));
  const now = performance.now();
  if (now < mutedUntil || level < SILENCE) {
    lastLevel = level;
    // Keep the last note on screen briefly, then clear it.
    if (!quietSince) quietSince = now;
    if (now - quietSince > 1200) {
      smoother.reset();
      listener(null);
    }
    return;
  }
  // A new pluck: start fresh and let the attack settle before reading.
  if (level > lastLevel * 1.6 && level > SILENCE * 2) {
    onsetAt = now;
    smoother.reset();
  }
  lastLevel = level;
  if (now - onsetAt < attackMs) return;
  const r = detectPitch(frame, { sampleRate: ctx.sampleRate, ...range });
  if (!r || r.clarity < MIN_CLARITY) return;
  quietSince = 0;
  listener({ freq: smoother.push(r.freq, now - onsetAt < JUMP_MS), clarity: r.clarity, level });
}

// --- Reference tones --------------------------------------------------------------

let toneSource: AudioBufferSourceNode | null = null;
let toneGain: GainNode | null = null;
const toneCache = new Map<string, AudioBuffer>();

function toneBuffer(ac: AudioContext, freq: number, sustain: boolean): AudioBuffer {
  const key = `${freq.toFixed(3)}:${sustain}`;
  const cached = toneCache.get(key);
  if (cached) return cached;
  const samples = sustain ? sustainSamples(freq, ac.sampleRate, 1) : pluckSamples(freq, ac.sampleRate, 3);
  const buf = ac.createBuffer(1, samples.length, ac.sampleRate);
  buf.getChannelData(0).set(samples);
  toneCache.set(key, buf);
  return buf;
}

export function isTonePlaying(): boolean {
  return toneSource !== null;
}

/** Play a reference tone. The tuner ignores the mic while it sounds. */
export async function playTone(freq: number, sustain: boolean, onEnd?: () => void): Promise<void> {
  stopTone();
  const ac = audioContext();
  if (ac.state !== "running") await ac.resume().catch(() => {});
  const src = ac.createBufferSource();
  src.buffer = toneBuffer(ac, freq, sustain);
  src.loop = sustain;
  const gain = ac.createGain();
  gain.gain.value = 0.9;
  src.connect(gain).connect(ac.destination);
  src.onended = () => {
    if (toneSource === src) {
      toneSource = null;
      toneGain = null;
      mutedUntil = performance.now() + 250;
      onEnd?.();
    }
  };
  toneSource = src;
  toneGain = gain;
  mutedUntil = Number.POSITIVE_INFINITY;
  src.start();
}

export function stopTone(): void {
  const src = toneSource;
  const gain = toneGain;
  toneSource = null;
  toneGain = null;
  if (src && gain && ctx) {
    // Quick fade so it doesn't click.
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.05);
    try {
      src.stop(t + 0.06);
    } catch {
      // already stopped
    }
  }
  mutedUntil = performance.now() + 250;
}

