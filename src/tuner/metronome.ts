// A plain metronome under the tuner: beats a minute (−/+, slider, tap),
// beats in a bar with the first one louder, and dots that follow the beat.
// Clicks are scheduled ahead on the audio clock, so they stay steady.
import { $, storage } from "../utils";
import { audio, scheduleClick } from "../tabs/pluck";
import { tapBpm } from "../practice/tempo";

const KEY = "fretline:metronome";
let bpm = 90;
let beats = 4;
let running = false;
let timer: ReturnType<typeof setInterval> | undefined;
let nextAt = 0;
let count = 0;
let taps: number[] = [];
let ac: AudioContext | null = null;
const shown: { at: number; beat: number }[] = [];
let raf = 0;

function save(): void {
  storage.set(KEY, { bpm, beats });
}

function render(): void {
  $("metro-bpm").textContent = String(bpm);
  ($("metro-slider") as HTMLInputElement).value = String(bpm);
  document.querySelectorAll<HTMLButtonElement>("#metro-beats button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === beats)));
  $("metro-dots").innerHTML = Array.from({ length: beats }, (_, i) => `<i class="${i === 0 ? "first" : ""}"></i>`).join("");
  $("metro-go").textContent = running ? "Stop" : "Start";
}

function setBpm(v: number): void {
  bpm = Math.max(40, Math.min(220, Math.round(v)));
  save();
  render();
}

/** Schedule the clicks due in the next ~120 ms. */
function schedule(): void {
  if (!ac) return;
  const period = 60 / bpm;
  while (nextAt < ac.currentTime + 0.12) {
    const beat = count % beats;
    scheduleClick(ac, nextAt, beat === 0, 0.7);
    shown.push({ at: nextAt, beat });
    nextAt += period;
    count++;
  }
}

function lightDots(): void {
  raf = requestAnimationFrame(lightDots);
  if (!ac) return;
  let beat = -1;
  while (shown.length && shown[0].at <= ac.currentTime) beat = shown.shift()!.beat;
  if (beat < 0) return;
  document.querySelectorAll<HTMLElement>("#metro-dots i").forEach((d, i) => d.classList.toggle("on", i === beat));
}

async function start(): Promise<void> {
  ac = await audio();
  running = true;
  count = 0;
  shown.length = 0;
  nextAt = ac.currentTime + 0.1;
  schedule();
  timer = setInterval(schedule, 25);
  raf = requestAnimationFrame(lightDots);
  render();
}

export function stopMetronome(): void {
  running = false;
  clearInterval(timer);
  cancelAnimationFrame(raf);
  shown.length = 0;
  document.querySelectorAll<HTMLElement>("#metro-dots i").forEach((d) => d.classList.remove("on"));
  render();
}

export function initMetronome(): void {
  const saved = storage.get<{ bpm?: number; beats?: number }>(KEY, {});
  if (saved.bpm) bpm = saved.bpm;
  if (saved.beats && [2, 3, 4, 6].includes(saved.beats)) beats = saved.beats;
  render();
  $("metro-down").addEventListener("click", () => setBpm(bpm - 1));
  $("metro-up").addEventListener("click", () => setBpm(bpm + 1));
  $("metro-slider").addEventListener("input", (e) => setBpm(Number((e.target as HTMLInputElement).value)));
  $("metro-tap").addEventListener("click", () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
    taps.push(now);
    const v = tapBpm(taps);
    if (v) setBpm(v);
  });
  $("metro-beats").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
    if (!b) return;
    beats = Number(b.dataset.v);
    count = 0;
    save();
    render();
  });
  $("metro-go").addEventListener("click", () => (running ? stopMetronome() : void start()));
}

export function metronomeRunning(): boolean {
  return running;
}
