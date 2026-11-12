// The practice screen: the app takes over from the video. Pick some lines of
// My notes and climb the ladder: 1 by 1 with Fretline's pluck, slow, then
// the video's own sound faster each time round, with the fingers shown on
// a fretboard and a click on the beat if you want one.
import { bus } from "../state";
import { pushStep, removeStep } from "../ui/back";
import { $, storage } from "../utils";
import { cellHtml, clock, doneLines, lessonLines, setDone, type NoteLine } from "../tabs/notebook";
import { together } from "../tabs/tab";
import { audio, scheduleClick, scheduleColumn, stopPluck } from "../tabs/pluck";
import { STRING_NAMES, type TabNote } from "../tabs/tab";
import { currentTab, currentCapo } from "../tabs/strip";
import { shapeTarget, showShape } from "../tabs/notebook-ui";
import { fretboardSvg, fretWindow, type Window } from "./fretboard";
import { ladder, stageLabel, type LadderOptions, type Stage } from "./ladder";
import { beatsBetween, estimateBeat, tapBpm, type Beat } from "./tempo";
import { hears } from "./listen";
import { addSeconds, recordRound } from "./progress";
import * as mic from "../tuner/engine";
import { midiToName } from "../tuner/pitch";
import { playColumn } from "../tabs/pluck";

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
/** Seconds on each note in 1 by 1 (you choose 2, 3 or 4). */
let stepSeconds = [2, 3, 4].includes(storage.get<number>("fretline:practice-gap", 3)) ? storage.get<number>("fretline:practice-gap", 3) : 3;
const GAP_MS = 700;

let ctl: PracticeControls | null = null;
let videoId: string | null = null;
let lines: NoteLine[] = [];
let allCols: Col[] = [];
let cols: Col[] = [];
/** The first note after the part (the video stops just before it). */
let after: Col | undefined;
let opts: LadderOptions = { start: "step", goal: 1, pace: "normal", sound: "auto", ...storage.get<Partial<LadderOptions>>(OPTS_KEY, {}) };
let stages: Stage[] = [];
let stageIdx = 0;
let loopIdx = 0;
let running = false;
/** At the goal speed: keep looping, or (after its rounds) tick the lines done and go on. */
let afterGoal: "repeat" | "next" = storage.get<string>("fretline:practice-after", "repeat") === "next" ? "next" : "repeat";
let clickOn = storage.get<boolean>("fretline:practice-click", false) === true;
let beat: Beat | null = null;
let taps: number[] = [];
let win: Window = { from: 0, to: 7 };

/** Listen to me: 1 by 1 waits until you play each note; faster rounds get a score. */
let listenOn = storage.get<boolean>("fretline:practice-listen", false) === true;
let micOurs = false;

type Pass =
  | { kind: "pluck"; times: number[]; end: number; ac: AudioContext }
  | { kind: "video"; lastT: number; ac: AudioContext | null; t0: number; stopAt: number; heard: boolean; landing: Landing | null; stopping: boolean }
  | Wait
  | Echo;

/**
 * Listening, at any speed above 1 by 1: it plays a bit (half a bar or so:
 * Fretline's pluck at the slow speeds, the video at its own), goes quiet,
 * and you play it back; then the next bit. Always the same, so you always
 * know whose turn it is, and it never hears itself.
 */
interface Echo {
  kind: "echo";
  sound: "pluck" | "video";
  rate: number;
  chunks: { from: number; to: number }[];
  ci: number;
  phase: "play" | "stopping" | "you" | "next";
  /** Video: where to stop, whether the sound is on yet, the jump still landing. */
  stopAt: number;
  unmuted: boolean;
  landing: Landing | null;
  /** Pluck: the sound clock, when each note of this bit sounds, when it's over. */
  ac: AudioContext | null;
  times: number[];
  playEnd: number;
  /** Your turn: listening from, last progress, the note expected next. */
  youFrom: number;
  lastHitAt: number;
  j: number;
  hit: Set<number>;
  /** The quietest it's been since the last note heard (a new pluck rises from it). */
  quietest: number;
}

/** The same strings and frets (so one ringing note can't count twice). */
function sameNotes(a: Col, b: Col): boolean {
  const key = (c: Col) => c.notes.map((n) => `${n.string}:${n.fret}:${n.tech === "mute" ? "x" : ""}`).sort().join(",");
  return key(a) === key(b);
}

/**
 * After a jump, the player's clock still shows the old place for a moment.
 * Nothing is decided from it until it has moved the way the jump went.
 */
interface Landing {
  stale: number;
  target: number;
  at: number;
}

function jumpTo(target: number): Landing {
  const l = { stale: ctl?.time() ?? 0, target, at: performance.now() };
  ctl?.seek(target);
  return l;
}

function hasLanded(t: number, l: Landing): boolean {
  if (performance.now() - l.at > 1500) return true;
  if (Math.abs(l.target - l.stale) < 0.05) return true;
  return l.target < l.stale ? t < l.stale - 0.03 : t >= l.target - 0.05;
}

/** 1 by 1, waiting for you: shows (and plucks) a note, then listens. */
interface Wait {
  kind: "wait";
  i: number;
  /** When listening starts (after the pluck has rung). */
  listenFrom: number;
  firstTry: boolean;
  good: number;
  okFrames: number;
  lastLevel: number;
  onsetAt: number;
  doneAt: number;
  said: string;
}
let pass: Pass | null = null;
let gapTimer: ReturnType<typeof setTimeout> | undefined;
let raf = 0;
let shownCol = -2;

/** Notes at one moment (never two on one string). */
function toCols(notes: TabNote[]): Col[] {
  return together(notes).map((g) => ({ t: g[0].t, notes: g }));
}

/**
 * A talk-through lesson: the notes are timed by when he *said* them, which
 * is no rhythm at all. So a step is played evenly, one note a beat, at the
 * tempo set under Click (1× = that tempo), and only with Fretline's pluck.
 */
let talk = false;
const TALK_BPM = 80;

/** When note i of the part sounds (seconds, at 1×). */
function playAt(i: number): number {
  return talk ? (i * 60) / (beat?.bpm ?? TALK_BPM) : cols[i].t;
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
  after = cols.length ? allCols.find((c) => c.t > cols[cols.length - 1].t + 0.001) : undefined;
  win = fretWindow(cols.flatMap((c) => c.notes.map((n) => n.fret)));
  shownCol = -2;
}

function buildLadder(): void {
  stages = ladder(talk ? { ...opts, sound: "pluck" } : opts);
  stageIdx = Math.min(stageIdx, stages.length - 1);
  renderLadder();
}

function renderLadder(): void {
  $("pr-ladder").innerHTML = stages
    .map((s, i) => `<span class="pr-rung${i === stageIdx ? " now" : i < stageIdx ? " done" : ""}">${stageLabel(s)}</span>`)
    .join("");
  const s = stage();
  const who = s.sound === "pluck" ? "Fretline's pluck" : "video sound";
  const sound = !listenOn ? who : s.speed === "step" ? `${who}, then waits for you` : `${who} plays a bit, then you`;
  $("pr-stage").textContent = `Step ${stageIdx + 1} of ${stages.length} · ${stageLabel(s)} · ${sound} · round ${Math.min(loopIdx + 1, s.loops)} of ${s.loops}${stageIdx === stages.length - 1 ? " (goal: keeps going)" : ""}${listenOn && lastScore ? ` · last round: ${lastScore}` : ""}`;
}

function renderOpts(): void {
  document.querySelectorAll<HTMLButtonElement>('.pr-seg[data-opt="after"] button').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === afterGoal)));
  document.querySelectorAll<HTMLButtonElement>('.pr-seg[data-opt="listen"] button').forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.v === "on") === listenOn)));
  document.querySelectorAll<HTMLButtonElement>('.pr-seg[data-opt="gap"] button').forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === stepSeconds)));
  document.querySelectorAll<HTMLElement>(".pr-seg:not([data-opt=after]):not([data-opt=gap]):not([data-opt=listen])").forEach((g) => {
    const key = g.dataset.opt as keyof LadderOptions;
    g.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(String(opts[key]) === b.dataset.v)));
  });
}

function loadBeat(): void {
  const saved = videoId ? storage.get<Beat | null>(BEAT_KEY(videoId), null) : null;
  beat = saved && saved.bpm > 0 ? saved : talk ? { bpm: TALK_BPM, phase: 0 } : estimateBeat(allCols.map((c) => c.t));
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

/** Live marks while listening: which notes it heard (✓) or missed. */
let marks: { hit: Set<number>; missed: Set<number> } = { hit: new Set(), missed: new Set() };
let marksKey = "";

function renderCol(i: number): void {
  const key = `${marks.hit.size}/${marks.missed.size}`;
  if (i === shownCol && key === marksKey) return;
  shownCol = i;
  marksKey = key;
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
    // the note itself (not a held shape or the chord name before it)
    if (c && cell.mark !== "hold" && cell.t <= c.t + 0.02) lit = k;
  });
  const mark = (t: number) => {
    const ci = cols.findIndex((o) => Math.abs(o.t - t) < 0.02);
    return ci < 0 ? "" : marks.hit.has(ci) ? " heard" : marks.missed.has(ci) ? " missed" : "";
  };
  $("pr-line").innerHTML =
    `<span class="pr-line-no">${line.n}</span>` + line.cells.map((cell, k) => cellHtml(cell, (k === lit ? "lit" : "") + (cell.mark === "hold" ? "" : mark(cell.t)))).join("");
}

// --- Running the ladder ------------------------------------------------------------------

function setPlaying(on: boolean): void {
  $("pr-play").classList.toggle("is-playing", on);
  $("pr-play").setAttribute("aria-label", on ? "Stop" : "Start");
}

function clearPass(): void {
  stopWatch = null;
  $("pr-wait").hidden = true;
  clearTimeout(gapTimer);
  gapTimer = undefined;
  stopPluck();
  pass = null;
}

async function startPass(): Promise<void> {
  if (!running || !ctl || !cols.length) return;
  clearPass();
  marks = { hit: new Set(), missed: new Set() };
  const s = stage();
  const t0 = cols[0].t;
  const t1 = cols[cols.length - 1].t;
  renderLadder();
  if (listenOn) await ensureMic();
  if (!running) return;
  const listening = listenOn && mic.isListening();
  if (listening && s.speed === "step") {
    ctl.pause();
    ctl.mute(true);
    pass = { kind: "wait", i: -1, listenFrom: 0, firstTry: true, good: 0, okFrames: 0, lastLevel: 0, onsetAt: 0, doneAt: 0, said: "" };
    nextWait();
  } else if (listening && s.speed !== "step") {
    const r = s.speed;
    let ac: AudioContext | null = null;
    if (s.sound === "pluck") {
      ctl.pause();
      ctl.mute(true);
      ac = await audio();
      if (!running) return;
    } else ctl.setRate(r);
    pass = { kind: "echo", sound: s.sound, rate: r, chunks: chunksOf(r), ci: -1, phase: "next", stopAt: 0, unmuted: false, landing: null, ac, times: [], playEnd: 0, youFrom: 0, lastHitAt: 0, j: 0, hit: new Set(), quietest: Infinity };
    nextChunk();
  } else if (s.sound === "pluck") {
    ctl.pause();
    ctl.mute(true);
    const ac = await audio();
    if (!running) return;
    const base = ac.currentTime + 0.3;
    const capo = currentCapo();
    const times = cols.map((_, i) => base + (s.speed === "step" ? i * stepSeconds : (playAt(i) - playAt(0)) / s.speed));
    cols.forEach((c, i) => scheduleColumn(ac, c.notes, capo, times[i]));
    if (clickOn && beat && s.speed !== "step") {
      const r = s.speed;
      // (a step has a note on every beat, so the click falls on each note)
      if (talk) times.forEach((at, i) => scheduleClick(ac, at, i % 4 === 0));
      else for (const b of beatsBetween(beat, t0 - 0.01, t1 + 0.5)) scheduleClick(ac, base + (b - t0) / r, isBar(b));
    }
    const end = times[times.length - 1] + (s.speed === "step" ? stepSeconds : 1.2);
    pass = { kind: "pluck", times, end, ac };
  } else {
    const r = s.speed === "step" ? 0.5 : s.speed;
    // a short silent run-up (muted until the first note, so the notes
    // before the part aren't heard) and a stop just before the next note
    ctl.mute(true);
    ctl.setRate(r);
    const from = Math.max(0, t0 - 0.6 * r);
    const stopAt = stopPoint(t1, after?.t, r, t0);
    const landing = jumpTo(from);
    ctl.play();
    pass = { kind: "video", lastT: from, ac: clickOn ? await audio() : null, t0, stopAt, heard: false, landing, stopping: false };
  }
}

function isBar(t: number): boolean {
  if (!beat) return false;
  const k = Math.round((t - beat.phase) / (60 / beat.bpm));
  return ((k % 4) + 4) % 4 === 0;
}

function partLines(): number[] {
  const from = Number(($("pr-from") as HTMLSelectElement).value);
  const to = Number(($("pr-to") as HTMLSelectElement).value);
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** Practice time: counted while it runs, saved now and then. */
let runSince = 0;
function flushTime(): void {
  if (!runSince || !videoId) return;
  const now = performance.now();
  addSeconds(videoId, (now - runSince) / 1000);
  runSince = running ? now : 0;
}

function finishPass(): void {
  if (!running) return;
  const done = pass;
  pass = null;
  if (videoId && done) {
    const sp = stage().speed;
    recordRound(videoId, partLines(), sp === "step" ? 0 : sp);
  }
  if (listenOn && done) {
    if (done.kind === "wait") lastScore = `${done.good} of ${cols.length} right first time`;
    else if (done.kind === "echo") lastScore = `heard ${done.hit.size} of ${cols.length} notes`;
    if (lastScore) bus.emit("toast", `Round done: ${lastScore}`);
  }
  loopIdx++;
  const s = stage();
  if (loopIdx >= s.loops && stageIdx < stages.length - 1) {
    stageIdx++;
    loopIdx = 0;
    bus.emit("toast", `Up a step: ${stageLabel(stage())}`);
  } else if (loopIdx >= s.loops && afterGoal === "next") {
    // got it at the goal speed: tick these lines and start on the next ones
    const from = Number(($("pr-from") as HTMLSelectElement).value);
    const to = Number(($("pr-to") as HTMLSelectElement).value);
    if (videoId) for (let n = from; n <= to; n++) setDone(videoId, n, true);
    if (to >= lines.length) {
      bus.emit("toast", "Done: you've reached the last line");
      stop();
      return;
    }
    shiftLines(to - from + 1);
    bus.emit("toast", `Line ${from}${to > from ? `–${to}` : ""} done ✓ On to line ${from + (to - from + 1)}`);
  }
  renderLadder();
  gapTimer = setTimeout(() => void startPass(), GAP_MS);
}

function tick(): void {
  raf = requestAnimationFrame(tick);
  if (!isOpen() || !ctl) return;
  watchStop();
  if (running && runSince && performance.now() - runSince > 60_000) flushTime();
  let idx = -1;
  if (pass?.kind === "wait") {
    idx = Math.max(0, Math.min(cols.length - 1, pass.i));
    renderWait(pass);
  } else if (pass?.kind === "echo") {
    idx = tickEcho(pass);
  } else if (pass?.kind === "pluck") {
    const now = pass.ac.currentTime;
    for (let i = 0; i < pass.times.length; i++) if (pass.times[i] <= now + 0.02) idx = i;
    if (now >= pass.end) finishPass();
  } else if (pass?.kind === "video") {
    const t = ctl.time();
    if (pass.landing && !hasLanded(t, pass.landing)) {
      renderCol(-1);
      return;
    }
    pass.landing = null;
    for (let i = 0; i < cols.length; i++) if (cols[i].t <= t + 0.02) idx = i;
    // the click: a beat passed since the last frame
    if (pass.ac && beat && t > pass.lastT && t - pass.lastT < 0.5) for (const b of beatsBetween(beat, pass.lastT + 1e-4, t)) scheduleClick(pass.ac, pass.ac.currentTime, isBar(b));
    pass.lastT = t;
    if (!pass.heard && t >= pass.t0 - 0.06) {
      pass.heard = true;
      ctl.mute(false);
    }
    if (t >= pass.stopAt && !pass.stopping) {
      // the round is over once the video has really stopped (that's also
      // when it learns how long this phone takes to stop)
      const p = pass;
      p.stopping = true;
      askStop(t, stage().speed === "step" ? 0.5 : (stage().speed as number), () => {
        if (pass === p) finishPass();
      });
    }
  } else if (!running) idx = shownCol >= 0 ? shownCol : -1;
  else idx = -1;
  renderCol(idx);
}

// --- Listening to you -----------------------------------------------------------------------

let lastScore = "";

async function ensureMic(): Promise<void> {
  if (mic.isListening()) {
    mic.onFrame(onMicFrame);
    return;
  }
  try {
    await mic.startListening();
    micOurs = true;
    mic.onFrame(onMicFrame);
  } catch {
    bus.emit("toast", "Can't use the mic: allow it in Android settings to be listened to");
    listenOn = false;
    storage.set("fretline:practice-listen", false);
    renderOpts();
  }
}

function releaseMic(): void {
  mic.onFrame(null);
  $("pr-meter").style.setProperty("--level", "0");
  if (micOurs) mic.stopListening();
  micOurs = false;
}

/** Show (and pluck) the next note, then listen for it. */
function nextWait(): void {
  if (pass?.kind !== "wait") return;
  pass.i++;
  if (pass.i >= cols.length) {
    finishPass();
    return;
  }
  pass.firstTry = true;
  pass.okFrames = 0;
  pass.doneAt = 0;
  pass.onsetAt = 0;
  pass.said = "";
  stopPluck();
  void playColumn(cols[pass.i].notes, currentCapo());
  // let Fretline's pluck ring out before listening (or it hears itself)
  pass.listenFrom = performance.now() + 1300;
}

function renderWait(w: Wait): void {
  const now = performance.now();
  const el = $("pr-wait");
  el.hidden = false;
  if (w.doneAt) el.textContent = w.firstTry ? "✓ Got it" : "✓ There it is";
  else if (now < w.listenFrom) el.textContent = "Listen…";
  else el.textContent = w.said || "Your turn: play it";
  el.className = `pr-wait${w.doneAt ? " ok" : w.said ? " off" : ""}`;
}

function onMicFrame(frame: Float32Array, sampleRate: number, level: number): void {
  // how loud the mic hears you, so you can see it's listening
  const meter = $("pr-meter");
  meter.style.setProperty("--level", String(Math.min(1, level * 12)));
  if (!running || !pass) return;
  const now = performance.now();
  if (pass.kind === "wait") {
    const w = pass;
    if (w.doneAt || w.i < 0 || w.i >= cols.length || now < w.listenFrom) {
      w.lastLevel = level;
      return;
    }
    if (level > 0.012 && level > w.lastLevel * 1.7) w.onsetAt = now;
    w.lastLevel = level;
    if (!w.onsetAt || now - w.onsetAt < 50 || level < 0.006) return;
    const col = cols[w.i];
    const slaps = col.notes.every((n) => n.tech === "mute");
    const withSlap = !slaps && col.notes.some((n) => n.tech === "mute");
    const h = slaps ? { ok: now - w.onsetAt < 300 } : hears(frame, sampleRate, col.notes, currentCapo());
    if (h.ok) {
      if (++w.okFrames >= (slaps || withSlap ? 1 : 2)) {
        w.doneAt = now;
        if (w.firstTry) w.good++;
        setTimeout(() => {
          if (pass === w) nextWait();
        }, 450);
      }
    } else if (now - w.onsetAt > 350 && now - w.onsetAt < 700) {
      w.okFrames = 0;
      if (!withSlap && "midi" in h && h.midi !== undefined) {
        w.firstTry = false;
        w.said = `Heard ${midiToName(h.midi)}: try again`;
      }
    }
    return;
  }
  if (pass.kind === "echo") {
    const e = pass;
    const c = e.chunks[e.ci];
    if (e.phase !== "you" || !c || now < e.youFrom) return;
    e.quietest = Math.min(e.quietest, level);
    if (level < 0.006) return;
    // a new pluck: louder than it had sunk to since the last note heard
    const plucked = level > Math.max(0.012, e.quietest * 1.5);
    const prev = e.j > 0 ? cols[c.from + e.j - 1] : undefined;
    // the note it's waiting for, or the one after (if you skipped one)
    for (const k of [e.j, e.j + 1]) {
      const i = c.from + k;
      if (i > c.to) break;
      const col = cols[i];
      // the same note again needs a new pluck (or the one still ringing would count)
      if (prev && e.hit.has(c.from + e.j - 1) && sameNotes(prev, col) && !plucked) continue;
      const ok = col.notes.every((n) => n.tech === "mute") ? plucked && level > 0.02 : hears(frame, sampleRate, col.notes, currentCapo()).ok;
      if (ok) {
        if (k === e.j + 1) marks.missed.add(c.from + e.j);
        e.hit.add(i);
        e.j = k + 1;
        e.lastHitAt = now;
        e.quietest = level;
        if (c.from + e.j > c.to) echoTurnOver(e);
        break;
      }
    }
  }
}

/**
 * How long (real seconds) the player keeps sounding after it's asked to
 * stop. Measured each time it stops (when its clock stands still), so the
 * stop is asked that much early on this phone, at any speed.
 */
let stopLag = Math.min(1.5, Math.max(0.2, storage.get<number>("fretline:stop-lag", 0.6)));
let stopWatch: { reqT: number; rate: number; lastT: number; stillSince: number; done: (() => void) | null } | null = null;

function askStop(t: number, rate: number, then: (() => void) | null): void {
  ctl?.mute(true);
  ctl?.pause();
  stopWatch = { reqT: t, rate, lastT: t, stillSince: performance.now(), done: then };
}

/** Each frame: has the player really stopped? Learn the delay when it has. */
function watchStop(): void {
  if (!stopWatch || !ctl) return;
  const t = ctl.time();
  if (t < stopWatch.reqT - 0.02) {
    // moved on (a seek) before it settled: nothing to learn
    const done = stopWatch.done;
    stopWatch = null;
    done?.();
    return;
  }
  const now = performance.now();
  if (Math.abs(t - stopWatch.lastT) >= 0.005) stopWatch.stillSince = now;
  stopWatch.lastT = t;
  // (its clock can also just be between two updates: give it a third of a second)
  if (now - stopWatch.stillSince < 300) return;
  const lag = (t - stopWatch.reqT) / stopWatch.rate;
  if (lag >= 0 && lag < 2) {
    // slower than thought: believe it at once (an extra note is the worse
    // mistake); quicker: come down gently
    const seen = lag + 0.1;
    stopLag = Math.min(1.5, Math.max(0.2, seen > stopLag ? seen : stopLag * 0.7 + seen * 0.3));
    storage.set("fretline:stop-lag", stopLag);
  }
  const done = stopWatch.done;
  stopWatch = null;
  done?.();
}

/**
 * When to ask the video to stop (song seconds) so that it has gone quiet
 * just before the next note. It keeps sounding for `stopLag` after being
 * asked, so the ask comes that much early: even before the last note of
 * the part, as long as that note still gets to sound.
 */
function stopPoint(last: number, nextT: number | undefined, rate: number, first: number): number {
  if (nextT === undefined) return last + 0.5;
  const carry = Math.max(0, stopLag - 0.15) * rate;
  return Math.max(last + 0.08 - carry, first + 0.3 * rate - carry, nextT - stopLag * rate);
}

/** The part in bits of half a bar (a bar or two when that's too quick to take in). */
function chunksOf(rate: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (beat && !talk) {
    const period = 60 / beat.bpm;
    // half a bar, or more when that's too quick to take in (at least ~2 s)
    const beats = [2, 4, 8].find((b) => (b * period) / rate >= 2) ?? 8;
    const len = beats * period;
    let start = 0;
    let key = Math.floor((cols[0].t - beat.phase + 0.05) / len);
    for (let i = 1; i <= cols.length; i++) {
      const k = i < cols.length ? Math.floor((cols[i].t - beat.phase + 0.05) / len) : Infinity;
      if (k !== key) {
        out.push({ from: start, to: i - 1 });
        start = i;
        key = k;
      }
    }
  } else for (let i = 0; i < cols.length; i += 4) out.push({ from: i, to: Math.min(cols.length - 1, i + 3) });
  // a single note on its own joins the one before
  for (let k = out.length - 1; k > 0; k--)
    if (out[k].to === out[k].from) {
      out[k - 1].to = out[k].to;
      out.splice(k, 1);
    }
  return out;
}

function nextChunk(): void {
  if (pass?.kind !== "echo" || !ctl) return;
  const e = pass;
  e.ci++;
  if (e.ci >= e.chunks.length) {
    finishPass();
    return;
  }
  const c = e.chunks[e.ci];
  const first = cols[c.from].t;
  const last = cols[c.to].t;
  e.phase = "play";
  e.j = 0;
  if (e.sound === "pluck" && e.ac) {
    const ac = e.ac;
    const base = ac.currentTime + 0.25;
    const capo = currentCapo();
    e.times = [];
    for (let i = c.from; i <= c.to; i++) {
      const at = base + (playAt(i) - playAt(c.from)) / e.rate;
      e.times.push(at);
      scheduleColumn(ac, cols[i].notes, capo, at);
    }
    if (clickOn && talk) e.times.forEach((at, k) => scheduleClick(ac, at, k % 4 === 0));
    else if (clickOn && beat) for (const b of beatsBetween(beat, first - 0.01, last + 0.01)) scheduleClick(ac, base + (b - first) / e.rate, isBar(b));
    // the last note rings a moment, then it's quiet for your turn
    e.playEnd = e.times[e.times.length - 1] + 0.9;
    return;
  }
  const nextT = cols[c.to + 1]?.t ?? after?.t;
  e.stopAt = stopPoint(last, nextT, e.rate, first);
  e.unmuted = false;
  ctl.mute(true);
  e.landing = jumpTo(Math.max(0, first - 0.6 * e.rate));
  ctl.play();
}

/** One frame of a play-then-you round; returns the note to show. */
function tickEcho(e: Echo): number {
  marks.hit = e.hit;
  const c = e.chunks[e.ci];
  let idx = -1;
  if (!c || !ctl) return idx;
  const yourTurn = () => {
    e.phase = "you";
    e.youFrom = performance.now() + 300;
    e.lastHitAt = 0;
    e.quietest = Infinity;
  };
  if (e.phase === "play" && e.sound === "pluck" && e.ac) {
    const now = e.ac.currentTime;
    idx = c.from;
    e.times.forEach((at, k) => {
      if (at <= now + 0.02) idx = c.from + k;
    });
    if (now >= e.playEnd) {
      stopPluck();
      yourTurn();
    }
  } else if (e.phase === "play") {
    const t = ctl.time();
    if (e.landing && !hasLanded(t, e.landing)) idx = c.from;
    else {
      e.landing = null;
      idx = c.from;
      for (let i = c.from; i <= c.to; i++) if (cols[i].t <= t + 0.02) idx = i;
      if (!e.unmuted && t >= cols[c.from].t - 0.06) {
        e.unmuted = true;
        ctl.mute(false);
      }
      if (t >= e.stopAt) {
        e.phase = "stopping";
        // listen only once the video has really gone quiet
        askStop(t, e.rate, () => {
          if (pass === e) yourTurn();
        });
      }
    }
  } else if (e.phase === "you") {
    idx = Math.min(c.to, c.from + e.j);
    // patient before your first note, then it moves on if you've stopped
    const now = performance.now();
    if (e.lastHitAt ? now - e.lastHitAt > 3500 : now - e.youFrom > 6000) echoTurnOver(e);
  } else idx = c.to;
  renderEcho(e);
  return idx;
}

function renderEcho(e: Echo): void {
  const el = $("pr-wait");
  el.hidden = false;
  const c = e.chunks[e.ci];
  const n = c ? c.to - c.from + 1 : 0;
  const left = c ? c.to - c.from + 1 - e.j : 0;
  el.className = `pr-wait${e.phase === "next" ? " ok" : ""}`;
  if (e.phase === "play" || e.phase === "stopping") el.textContent = `Listen… (bit ${e.ci + 1} of ${e.chunks.length})`;
  else if (e.phase === "you") el.textContent = e.j === 0 ? `Your turn: play ${n === 1 ? "that note" : `those ${n} notes`}` : `Keep going: ${left} more`;
  else el.textContent = c ? `${[...e.hit].filter((i) => i >= c.from && i <= c.to).length} of ${n} heard` : "";
}

function echoTurnOver(e: Echo): void {
  const c = e.chunks[e.ci];
  for (let i = c.from; i <= c.to; i++) if (!e.hit.has(i)) marks.missed.add(i);
  e.phase = "next";
  setTimeout(() => {
    if (pass === e) nextChunk();
  }, 700);
}

function skipWait(): void {
  if (pass?.kind === "echo" && pass.phase === "you") {
    const e = pass;
    const c = e.chunks[e.ci];
    marks.missed.add(c.from + e.j);
    e.j++;
    e.lastHitAt = performance.now();
    if (c.from + e.j > c.to) echoTurnOver(e);
    return;
  }
  if (pass?.kind !== "wait" || pass.doneAt) return;
  pass.firstTry = false;
  pass.doneAt = performance.now();
  setTimeout(() => {
    if (pass?.kind === "wait") nextWait();
  }, 150);
}

function start(): void {
  if (!cols.length) {
    bus.emit("toast", "No notes in these lines");
    return;
  }
  running = true;
  loopIdx = 0;
  runSince = performance.now();
  setPlaying(true);
  void startPass();
}

function stop(): void {
  flushTime();
  runSince = 0;
  running = false;
  clearPass();
  ctl?.pause();
  setPlaying(false);
  releaseMic();
  $("pr-wait").hidden = true;
}

function move(by: number): void {
  stageIdx = Math.max(0, Math.min(stages.length - 1, stageIdx + by));
  loopIdx = 0;
  renderLadder();
  if (running) void startPass();
}

/** Move the part by `by` lines (keeping how many lines it covers). */
function shiftLines(by: number): void {
  const fromSel = $("pr-from") as HTMLSelectElement;
  const toSel = $("pr-to") as HTMLSelectElement;
  const from = Number(fromSel.value);
  const span = Number(toSel.value) - from;
  const nf = Math.max(1, Math.min(lines.length - span, from + by));
  fromSel.value = String(nf);
  toSel.value = String(nf + span);
  pickPart();
  stageIdx = 0;
  loopIdx = 0;
  renderLadder();
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
  lines = lessonLines(tab);
  talk = tab.talk;
  allCols = toCols(tab.notes);
  // steps play with Fretline's pluck only (the video there is him talking)
  $("pr-sound-row").hidden = talk;
  $("pr-watch").hidden = !talk;
  $("pr-hint-talk").hidden = !talk;
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
  // a step: back to the video, where he teaches it
  $("pr-watch").addEventListener("click", () => {
    const line = lines[Number(($("pr-from") as HTMLSelectElement).value) - 1];
    closePractice();
    if (!line || !ctl) return;
    ctl.seek(Math.max(0, line.t - 2));
    ctl.play();
  });
  // tap the note card to skip a note you can't get (while it listens)
  $("pr-note-card").addEventListener("click", skipWait);
  $("pr-line").addEventListener("click", (e) => {
    const el = shapeTarget(e.target);
    if (el) showShape(el);
  });
  const lineStep = (by: number) => {
    shiftLines(by);
    if (running) void startPass();
  };
  $("pr-prev-line").addEventListener("click", () => lineStep(-1));
  $("pr-next-line").addEventListener("click", () => lineStep(1));
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
      const v = b.dataset.v!;
      if (g.dataset.opt === "listen") {
        listenOn = v === "on";
        storage.set("fretline:practice-listen", listenOn);
        lastScore = "";
        renderOpts();
        if (listenOn) void ensureMic();
        else releaseMic();
        if (running) void startPass();
        return;
      }
      if (g.dataset.opt === "gap") {
        stepSeconds = Number(v) || 3;
        storage.set("fretline:practice-gap", stepSeconds);
        renderOpts();
        if (running && stage().speed === "step") void startPass();
        return;
      }
      if (g.dataset.opt === "after") {
        afterGoal = v === "next" ? "next" : "repeat";
        storage.set("fretline:practice-after", afterGoal);
        renderOpts();
        return;
      }
      const key = g.dataset.opt as keyof LadderOptions;
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
