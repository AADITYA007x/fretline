// The practice screen: the app takes over from the video. Pick some lines of
// My notes and climb the ladder: 1 by 1 with Fretline's pluck, slow, then
// the video's own sound faster each time round, with the fingers shown on
// a fretboard and a click on the beat if you want one.
import { bus } from "../state";
import { pushStep, removeStep } from "../ui/back";
import { $, storage } from "../utils";
import { cellHtml, clock, doneLines, notebookLines, type NoteLine } from "../tabs/notebook";
import { audio, scheduleClick, scheduleColumn, stopPluck } from "../tabs/pluck";
import { STRING_NAMES, type TabNote } from "../tabs/tab";
import { currentTab, currentCapo } from "../tabs/strip";
import { fretboardSvg, fretWindow, type Window } from "./fretboard";
import { ladder, stageLabel, type LadderOptions, type Stage } from "./ladder";
import { beatsBetween, estimateBeat, tapBpm, type Beat } from "./tempo";

export interface PracticeControls {
  time(): number;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  setRate(rate: number): void;
  mute(on: boolean): void;
  /** Practice closed: the lesson takes the player back. */
  done(): void;
}

interface Col {
  t: number;
  notes: TabNote[];
}

const OPTS_KEY = "fretline:practice";
const BEAT_KEY = (id: string) => `fretline:beat:${id}`;
const STEP_SECONDS = 1.6;
const GAP_MS = 900;

let ctl: PracticeControls | null = null;
let videoId: string | null = null;
let lines: NoteLine[] = [];
let allCols: Col[] = [];
let cols: Col[] = [];
let opts: LadderOptions = { start: "step", goal: 1, pace: "normal", sound: "auto", ...storage.get<Partial<LadderOptions>>(OPTS_KEY, {}) };
let stages: Stage[] = [];
let stageIdx = 0;
let loopIdx = 0;
let running = false;
let clickOn = storage.get<boolean>("fretline:practice-click", false) === true;
let beat: Beat | null = null;
let taps: number[] = [];
let win: Window = { from: 0, to: 7 };

type Pass =
  | { kind: "pluck"; times: number[]; end: number; ac: AudioContext }
  | { kind: "video"; lastT: number; ac: AudioContext | null };
let pass: Pass | null = null;
let gapTimer: ReturnType<typeof setTimeout> | undefined;
let raf = 0;
let shownCol = -2;

/** Notes at one moment (never two on one string). */
function toCols(notes: TabNote[]): Col[] {
  const out: Col[] = [];
  for (const n of [...notes].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && n.t - last.t < 0.03 && !last.notes.some((o) => o.string === n.string)) last.notes.push(n);
    else out.push({ t: n.t, notes: [n] });
  }
  return out;
}

function isOpen(): boolean {
  return !$("practice").hidden;
}

function stage(): Stage {
  return stages[Math.min(stageIdx, stages.length - 1)];
}

// --- Part, ladder and beat -------------------------------------------------------------

function pickPart(): void {
  const from = Number(($("pr-from") as HTMLSelectElement).value) || 1;
  const to = Math.max(from, Number(($("pr-to") as HTMLSelectElement).value) || from);
  const a = lines[from - 1];
  const b = lines[to - 1];
  cols = a && b ? allCols.filter((c) => c.t >= a.t - 0.001 && c.t <= b.end + 0.001) : [];
  win = fretWindow(cols.flatMap((c) => c.notes.map((n) => n.fret)));
  shownCol = -2;
}

function buildLadder(): void {
  stages = ladder(opts);
  stageIdx = Math.min(stageIdx, stages.length - 1);
  renderLadder();
}

function renderLadder(): void {
  $("pr-ladder").innerHTML = stages
    .map((s, i) => `<span class="pr-rung${i === stageIdx ? " now" : i < stageIdx ? " done" : ""}">${stageLabel(s)}</span>`)
    .join("");
  const s = stage();
  const sound = s.sound === "pluck" ? "Fretline's pluck" : "video sound";
  $("pr-stage").textContent = `Step ${stageIdx + 1} of ${stages.length} · ${stageLabel(s)} · ${sound} · round ${Math.min(loopIdx + 1, s.loops)} of ${s.loops}${stageIdx === stages.length - 1 ? " (goal: keeps going)" : ""}`;
}

function renderOpts(): void {
  document.querySelectorAll<HTMLElement>(".pr-seg").forEach((g) => {
    const key = g.dataset.opt as keyof LadderOptions;
    g.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(String(opts[key]) === b.dataset.v)));
  });
}

function loadBeat(): void {
  const saved = videoId ? storage.get<Beat | null>(BEAT_KEY(videoId), null) : null;
  beat = saved && saved.bpm > 0 ? saved : estimateBeat(allCols.map((c) => c.t));
  renderBeat();
}

function saveBeat(): void {
  if (videoId && beat) storage.set(BEAT_KEY(videoId), beat);
  renderBeat();
}

function renderBeat(): void {
  $("pr-bpm").textContent = beat ? `${Math.round(beat.bpm)} BPM` : "— BPM";
  const b = $("pr-click");
  b.setAttribute("aria-pressed", String(clickOn));
  b.textContent = clickOn ? "Click: on" : "Click: off";
}

// --- Showing the note ------------------------------------------------------------------

function describe(c: Col | undefined): string {
  if (!c) return "";
  const strum = c.notes.find((n) => n.strum);
  const parts = [...c.notes]
    .sort((a, b) => b.string - a.string)
    .map((n) => (n.tech === "mute" ? `${STRING_NAMES[n.string]}: slap ✋` : `${STRING_NAMES[n.string]} ${n.fret === 0 ? "open" : n.fret}`));
  return (strum ? "Roll · " : "") + parts.join(" + ");
}

function renderCol(i: number): void {
  if (i === shownCol) return;
  shownCol = i;
  const c = i >= 0 ? cols[i] : undefined;
  const next = cols[i + 1] ?? (i < 0 ? cols[0] : undefined);
  $("pr-now").textContent = c ? describe(c) : cols.length ? "Ready" : "No notes in these lines";
  $("pr-next").textContent = next ? `next: ${describe(next)}` : "";
  const around = c ? cols.filter((o) => Math.abs(o.t - c.t) <= 1.2).flatMap((o) => o.notes.filter((n) => n.tech !== "mute").map((n) => n.fret)) : [];
  $("pr-board").innerHTML = fretboardSvg(c?.notes ?? [], next?.notes ?? [], win, around);
  // the My notes line it's in, with this moment lit
  const t = c?.t ?? cols[0]?.t ?? 0;
  const line = lines.find((l) => t >= l.t - 0.001 && t <= l.end + 0.001) ?? lines[0];
  if (!line) {
    $("pr-line").innerHTML = "";
    return;
  }
  let lit = -1;
  line.cells.forEach((cell, k) => {
    if (c && cell.t <= c.t + 0.02) lit = k;
  });
  $("pr-line").innerHTML = `<span class="pr-line-no">${line.n}</span>` + line.cells.map((cell, k) => cellHtml(cell).replace('class="nb-cell', `class="nb-cell${k === lit ? " lit" : ""}`)).join("");
}

// --- Running the ladder ------------------------------------------------------------------

function setPlaying(on: boolean): void {
  $("pr-play").classList.toggle("is-playing", on);
  $("pr-play").setAttribute("aria-label", on ? "Stop" : "Start");
}

function clearPass(): void {
  clearTimeout(gapTimer);
  gapTimer = undefined;
  stopPluck();
  pass = null;
}

async function startPass(): Promise<void> {
  if (!running || !ctl || !cols.length) return;
  clearPass();
  const s = stage();
  const t0 = cols[0].t;
  const t1 = cols[cols.length - 1].t;
  renderLadder();
  if (s.sound === "pluck") {
    ctl.pause();
    ctl.mute(true);
    const ac = await audio();
    if (!running) return;
    const base = ac.currentTime + 0.3;
    const capo = currentCapo();
    const times = cols.map((c, i) => base + (s.speed === "step" ? i * STEP_SECONDS : (c.t - t0) / s.speed));
    cols.forEach((c, i) => scheduleColumn(ac, c.notes, capo, times[i]));
    if (clickOn && beat && s.speed !== "step") {
      const r = s.speed;
      for (const b of beatsBetween(beat, t0 - 0.01, t1 + 0.5)) scheduleClick(ac, base + (b - t0) / r, isBar(b));
    }
    const end = times[times.length - 1] + (s.speed === "step" ? STEP_SECONDS : 1.2);
    pass = { kind: "pluck", times, end, ac };
  } else {
    const r = s.speed === "step" ? 0.5 : s.speed;
    ctl.mute(false);
    ctl.setRate(r);
    const from = Math.max(0, t0 - 0.6 * r);
    ctl.seek(from);
    ctl.play();
    pass = { kind: "video", lastT: from, ac: clickOn ? await audio() : null };
  }
}

function isBar(t: number): boolean {
  if (!beat) return false;
  const k = Math.round((t - beat.phase) / (60 / beat.bpm));
  return ((k % 4) + 4) % 4 === 0;
}

function finishPass(): void {
  if (!running) return;
  pass = null;
  loopIdx++;
  const s = stage();
  if (loopIdx >= s.loops && stageIdx < stages.length - 1) {
    stageIdx++;
    loopIdx = 0;
    bus.emit("toast", `Up a step: ${stageLabel(stage())}`);
  }
  renderLadder();
  gapTimer = setTimeout(() => void startPass(), GAP_MS);
}

function tick(): void {
  raf = requestAnimationFrame(tick);
  if (!isOpen() || !ctl) return;
  let idx = -1;
  if (pass?.kind === "pluck") {
    const now = pass.ac.currentTime;
    for (let i = 0; i < pass.times.length; i++) if (pass.times[i] <= now + 0.02) idx = i;
    if (now >= pass.end) finishPass();
  } else if (pass?.kind === "video") {
    const t = ctl.time();
    for (let i = 0; i < cols.length; i++) if (cols[i].t <= t + 0.02) idx = i;
    // the click: a beat passed since the last frame
    if (pass.ac && beat && t > pass.lastT && t - pass.lastT < 0.5) for (const b of beatsBetween(beat, pass.lastT + 1e-4, t)) scheduleClick(pass.ac, pass.ac.currentTime, isBar(b));
    pass.lastT = t;
    if (cols.length && t >= cols[cols.length - 1].t + 0.6) {
      ctl.pause();
      finishPass();
    }
  } else if (!running) idx = shownCol >= 0 ? shownCol : -1;
  else idx = -1;
  renderCol(idx);
}

function start(): void {
  if (!cols.length) {
    bus.emit("toast", "No notes in these lines");
    return;
  }
  running = true;
  loopIdx = 0;
  setPlaying(true);
  void startPass();
}

function stop(): void {
  running = false;
  clearPass();
  ctl?.pause();
  setPlaying(false);
}

function move(by: number): void {
  stageIdx = Math.max(0, Math.min(stages.length - 1, stageIdx + by));
  loopIdx = 0;
  renderLadder();
  if (running) void startPass();
}

// --- Open / close ------------------------------------------------------------------------

function fillLines(fromLine: number): void {
  const opt = (l: NoteLine) => `<option value="${l.n}">${l.n} · ${clock(l.t)}</option>`;
  const html = lines.map(opt).join("");
  ($("pr-from") as HTMLSelectElement).innerHTML = html;
  ($("pr-to") as HTMLSelectElement).innerHTML = html;
  ($("pr-from") as HTMLSelectElement).value = String(fromLine);
  ($("pr-to") as HTMLSelectElement).value = String(fromLine);
}

/** Open practice on a line of My notes (or the one at `t`, or the first not ticked). */
export function openPractice(title: string, at: { line?: number; t?: number } = {}): void {
  const tab = currentTab();
  videoId = tab.videoId;
  lines = notebookLines(tab.notes, tab.chords);
  allCols = toCols(tab.notes);
  if (!lines.length) {
    bus.emit("toast", "No notes yet: read the tab from the video first");
    return;
  }
  let n = at.line ?? 0;
  if (!n && at.t !== undefined) n = (lines.filter((l) => l.t <= at.t! + 0.05).pop() ?? lines[0]).n;
  if (!n) {
    const done = videoId ? doneLines(videoId) : [];
    n = (lines.find((l) => !done.includes(l.n)) ?? lines[0]).n;
  }
  $("pr-title").textContent = title;
  fillLines(n);
  pickPart();
  stageIdx = 0;
  loopIdx = 0;
  buildLadder();
  renderOpts();
  loadBeat();
  shownCol = -2;
  $("practice").hidden = false;
  document.documentElement.classList.add("in-practice");
  // Android back closes practice first
  pushStep("practice", () => closePractice(false));
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function closePractice(fromCode = true): void {
  if (!isOpen()) return;
  if (fromCode) removeStep("practice");
  stop();
  cancelAnimationFrame(raf);
  $("practice").hidden = true;
  document.documentElement.classList.remove("in-practice");
  ctl?.mute(false);
  ctl?.done();
}

export function practiceOpen(): boolean {
  return isOpen();
}

export function initPractice(controls: PracticeControls): void {
  ctl = controls;
  $("pr-close").addEventListener("click", () => closePractice());
  $("pr-play").addEventListener("click", () => (running ? stop() : start()));
  $("pr-up").addEventListener("click", () => move(1));
  $("pr-back").addEventListener("click", () => move(-1));
  for (const id of ["pr-from", "pr-to"]) {
    $(id).addEventListener("change", () => {
      const from = $("pr-from") as HTMLSelectElement;
      const to = $("pr-to") as HTMLSelectElement;
      if (Number(to.value) < Number(from.value)) to.value = from.value;
      pickPart();
      if (running) void startPass();
    });
  }
  document.querySelectorAll<HTMLElement>(".pr-seg").forEach((g) =>
    g.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
      if (!b) return;
      const key = g.dataset.opt as keyof LadderOptions;
      const v = b.dataset.v!;
      (opts as unknown as Record<string, unknown>)[key] = key === "pace" || key === "sound" || v === "step" ? v : Number(v);
      storage.set(OPTS_KEY, opts);
      renderOpts();
      const was = stage();
      buildLadder();
      // stay on the same speed if it's still on the ladder
      const same = stages.findIndex((s) => s.speed === was?.speed);
      stageIdx = same >= 0 ? same : 0;
      loopIdx = 0;
      renderLadder();
      if (running) void startPass();
    }),
  );
  $("pr-click").addEventListener("click", () => {
    clickOn = !clickOn;
    storage.set("fretline:practice-click", clickOn);
    if (clickOn && !beat) bus.emit("toast", "Tap the beat a few times to set the click");
    renderBeat();
    if (running) void startPass();
  });
  const nudge = (by: number) => {
    if (!beat) beat = { bpm: 100, phase: cols[0]?.t ?? 0 };
    beat = { ...beat, bpm: Math.max(40, Math.min(220, Math.round(beat.bpm) + by)) };
    saveBeat();
  };
  $("pr-bpm-down").addEventListener("click", () => nudge(-1));
  $("pr-bpm-up").addEventListener("click", () => nudge(1));
  $("pr-tap").addEventListener("click", () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
    taps.push(now);
    const bpm = tapBpm(taps);
    if (bpm) {
      beat = { bpm, phase: beat?.phase ?? cols[0]?.t ?? 0 };
      saveBeat();
    }
  });
  bus.on("viewchange", () => closePractice());
}

export const _forTests = { toCols };
