// Fretline's own pluck: plays a tab note or chord (standard tuning, with the
// capo) so 1 by 1 can sound each note clearly while the video waits.
import { pluckSamples } from "../tuner/tones";
import type { TabNote } from "./tab";

/** MIDI note of each open string (1 = high e … 6 = low E). */
const OPEN_MIDI = [0, 64, 59, 55, 50, 45, 40];
/** Natural harmonics: how far above the open string they sound. */
const HARMONIC: Record<number, number> = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28 };

export function noteFreq(n: Pick<TabNote, "string" | "fret" | "tech">, capo = 0): number {
  const up = n.tech === "harmonic" ? (HARMONIC[n.fret] ?? n.fret) : n.fret;
  const midi = OPEN_MIDI[n.string] + up + capo;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * When each note of a column starts (seconds after the first): together
 * notes at once, a strummed chord rolled across the strings (down = low to
 * high, up = high to low).
 */
export function rollTimes(notes: Pick<TabNote, "string" | "strum">[], gap = 0.03): number[] {
  const strum = notes.find((n) => n.strum)?.strum;
  if (!strum) return notes.map(() => 0);
  const order = notes.map((n, i) => ({ s: n.string, i })).sort((a, b) => (strum === "down" ? b.s - a.s : a.s - b.s));
  const at = new Array<number>(notes.length).fill(0);
  order.forEach((o, k) => (at[o.i] = k * gap));
  return at;
}

let ctx: AudioContext | null = null;
const cache = new Map<string, AudioBuffer>();
let playing: { src: AudioBufferSourceNode; gain: GainNode }[] = [];

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function pluckBuffer(ac: AudioContext, freq: number): AudioBuffer {
  const key = freq.toFixed(2);
  let buf = cache.get(key);
  if (!buf) {
    const samples = pluckSamples(freq, ac.sampleRate, 2.2);
    buf = ac.createBuffer(1, samples.length, ac.sampleRate);
    buf.getChannelData(0).set(samples);
    cache.set(key, buf);
  }
  return buf;
}

/** A slap on muted strings: a short thump. */
function slapBuffer(ac: AudioContext): AudioBuffer {
  let buf = cache.get("slap");
  if (!buf) {
    const n = Math.round(ac.sampleRate * 0.09);
    buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 777;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed / 0x7fffffff) * 2 - 1;
      lp += 0.25 * (noise - lp);
      d[i] = lp * Math.exp(-i / (ac.sampleRate * 0.018)) * 1.6;
    }
    cache.set("slap", buf);
  }
  return buf;
}

export function stopPluck(): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const p of playing) {
    p.gain.gain.setValueAtTime(p.gain.gain.value, t);
    p.gain.gain.linearRampToValueAtTime(0, t + 0.05);
    try {
      p.src.stop(t + 0.06);
    } catch {
      /* already stopped */
    }
  }
  playing = [];
}

/** Play one column of the tab (a note, notes together, or a strum). */
export async function playColumn(notes: TabNote[], capo = 0): Promise<void> {
  if (!notes.length) return;
  stopPluck();
  const ac = context();
  if (ac.state !== "running") await ac.resume().catch(() => {});
  const at = rollTimes(notes);
  const start = ac.currentTime + 0.02;
  const level = 0.85 / Math.sqrt(notes.length);
  notes.forEach((n, i) => {
    const src = ac.createBufferSource();
    src.buffer = n.tech === "mute" ? slapBuffer(ac) : pluckBuffer(ac, noteFreq(n, capo));
    const gain = ac.createGain();
    gain.gain.value = level;
    src.connect(gain).connect(ac.destination);
    src.onended = () => (playing = playing.filter((p) => p.src !== src));
    playing.push({ src, gain });
    src.start(start + at[i]);
  });
}
