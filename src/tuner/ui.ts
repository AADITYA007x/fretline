// The tuner screen: gauge, note, strings (drawn like a tab staff), modes,
// and the sheets for picking, editing and saving tunings.
import { bus } from "../state";
import { $, escapeHtml, storage } from "../utils";
import { closeSheet, isSheetOpen, openSheet } from "../ui/sheets";
import { currentView } from "../ui/nav";
import * as engine from "./engine";
import { IN_TUNE, describe, nearestString } from "./logic";
import { centsOff, freqToMidi, midiToFreq, midiToName, midiToNote, noteToMidi } from "./pitch";
import {
  INSTRUMENTS,
  PRESETS,
  currentTuning,
  deleteCustomTuning,
  deleteSongTuning,
  findTuning,
  getA4,
  listenRange,
  saveCustomTuning,
  saveSongTuning,
  setA4,
  setCurrentTuning,
  shortNotes,
  songTunings,
  tuningsFor,
  type InstrumentId,
  type Tuning,
} from "./tunings";

type Mode = "auto" | "manual" | "tone";

const HOLD_MS = 600; // in tune this long → the string is marked done
const MIC_OK = "fretline:mic-ok";
const MODE_KEY = "fretline:tuner-mode";

let tuning: Tuning = currentTuning();
let mode: Mode = storage.get<Mode>(MODE_KEY, "auto");
let picked = 0;
let tuned = new Set<number>();
let inTuneSince = 0;
let inTuneString = -1;
let toneString = -1;
let wakeLock: { release(): Promise<void> } | null = null;

// --- Gauge -----------------------------------------------------------------------------

const CX = 150;
const CY = 140;
const R = 112;
const DEG_PER_CENT = 1.2; // ±50 cents → ±60°

function polar(cents: number, r: number): [number, number] {
  const a = ((cents * DEG_PER_CENT - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function drawGauge(): void {
  const ticks: string[] = [];
  for (let c = -50; c <= 50; c += 5) {
    const major = c % 25 === 0;
    const [x1, y1] = polar(c, R - (major ? 14 : 8));
    const [x2, y2] = polar(c, R);
    ticks.push(`<line class="tick${major ? " major" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
  }
  $("gauge-ticks").innerHTML = ticks.join("");
  const [ax, ay] = polar(-IN_TUNE, R + 10);
  const [bx, by] = polar(IN_TUNE, R + 10);
  $("gauge-zone").setAttribute("d", `M${ax.toFixed(1)} ${ay.toFixed(1)} A${R + 10} ${R + 10} 0 0 1 ${bx.toFixed(1)} ${by.toFixed(1)}`);
}

function setNeedle(cents: number): void {
  const c = Math.max(-55, Math.min(55, cents));
  $("needle").style.transform = `rotate(${(c * DEG_PER_CENT).toFixed(2)}deg)`;
}

// --- Rendering -------------------------------------------------------------------------

function stringFreq(i: number): number {
  return midiToFreq(noteToMidi(tuning.strings[i]), getA4());
}

function renderHead(): void {
  const inst = INSTRUMENTS.find((x) => x.id === tuning.instrument)?.label ?? "";
  $("tuning-instrument").textContent = `${inst}, ${shortNotes(tuning)}`;
  $("tuning-name").textContent = tuning.name;
  $("a4-value").textContent = String(getA4());
}

function renderStrings(): void {
  const host = $("strings");
  host.innerHTML = "";
  const n = tuning.strings.length;
  // Highest string on top, like a tab.
  for (let i = n - 1; i >= 0; i--) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "string";
    b.dataset.index = String(i);
    const note = tuning.strings[i];
    const label = midiToName(noteToMidi(note));
    b.setAttribute("aria-label", `String ${n - i}, ${note}`);
    b.innerHTML = `<span class="string-note">${escapeHtml(label)}</span><span class="string-line" style="--gauge:${(1.4 + (n - 1 - i) * 0.55).toFixed(2)}px"></span><span class="string-done" aria-hidden="true"></span>`;
    b.addEventListener("click", () => onStringTap(i));
    host.appendChild(b);
  }
  renderStringStates();
}

function renderStringStates(active = -1, inTune = false): void {
  $("strings")
    .querySelectorAll<HTMLElement>(".string")
    .forEach((el) => {
      const i = Number(el.dataset.index);
      el.classList.toggle("tuned", tuned.has(i));
      el.classList.toggle("active", i === active);
      el.classList.toggle("in", i === active && inTune);
      el.classList.toggle("picked", mode === "manual" && i === picked);
      el.classList.toggle("playing", mode === "tone" && i === toneString);
      el.setAttribute("aria-pressed", String((mode === "manual" && i === picked) || (mode === "tone" && i === toneString)));
    });
}

function renderMode(): void {
  document.querySelectorAll<HTMLElement>(".mode-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("sustain-row").hidden = mode !== "tone";
  const hint =
    mode === "auto"
      ? "Play any string. Fretline finds which one it is."
      : mode === "manual"
        ? "Tap the string you're tuning. Handy when it's way off."
        : "Tap a string to hear its note. The mic pauses while it plays.";
  $("mode-hint").textContent = hint;
  renderStringStates();
}

function setReadout(state: "idle" | "off" | "in", note: string, octave: string, text: string, cents = 0): void {
  const r = $("readout");
  r.dataset.state = state;
  $("note-name").textContent = note;
  $("note-octave").textContent = octave;
  $("cents").textContent = text;
  setNeedle(state === "idle" ? 0 : cents);
}

function idleText(): string {
  if (mode === "tone") return toneString >= 0 ? "Playing" : "Tap a string to hear it";
  return engine.isListening() ? "Play a string" : "Tap Start, then play a string";
}

function showIdle(): void {
  if (mode === "tone" && toneString >= 0) {
    const m = noteToMidi(tuning.strings[toneString]);
    setReadout("idle", midiToName(m), String(Math.floor(m / 12) - 1), "Playing");
  } else {
    setReadout("idle", "–", "", idleText());
  }
  renderStringStates();
}

function renderListenBtn(): void {
  const b = $("listen-btn");
  const on = engine.isListening();
  b.textContent = on ? "Stop listening" : "Start listening";
  b.classList.toggle("on", on);
  b.hidden = mode === "tone";
}

function renderAll(): void {
  renderHead();
  renderStrings();
  renderMode();
  renderListenBtn();
  showIdle();
}

// --- Readings ----------------------------------------------------------------------------

function onReading(r: engine.Reading | null): void {
  if (mode === "tone") return;
  if (!r) {
    inTuneSince = 0;
    showIdle();
    return;
  }
  const a4 = getA4();
  const i = mode === "manual" ? picked : nearestString(r.freq, tuning, a4);
  const target = stringFreq(i);
  const cents = centsOff(r.freq, target);
  const tm = noteToMidi(tuning.strings[i]);
  const playing = midiToNote(freqToMidi(r.freq, a4));
  const d = describe(cents, playing, midiToNote(tm));
  setReadout(d.inTune ? "in" : "off", midiToName(tm), String(Math.floor(tm / 12) - 1), d.text, cents);

  const now = performance.now();
  if (d.inTune) {
    if (inTuneString !== i) {
      inTuneString = i;
      inTuneSince = now;
    } else if (now - inTuneSince > HOLD_MS && !tuned.has(i)) {
      tuned.add(i);
      navigator.vibrate?.(30);
    }
  } else {
    inTuneString = -1;
  }
  renderStringStates(i, d.inTune);
}

// --- Actions ----------------------------------------------------------------------------

function onStringTap(i: number): void {
  if (mode === "auto") {
    // Tapping a string in Auto switches to that string.
    setMode("manual");
  }
  if (mode === "manual") {
    picked = i;
    engine.resetSmoothing();
    renderStringStates();
    if (!engine.isListening()) void startListening();
    return;
  }
  // Hear it
  if (toneString === i) {
    engine.stopTone();
    toneString = -1;
    showIdle();
    return;
  }
  toneString = i;
  const ringing = i;
  void engine.playTone(stringFreq(i), $<HTMLInputElement>("sustain").checked, () => {
    if (toneString === ringing) {
      toneString = -1;
      showIdle();
    }
  });
  showIdle();
}

function setMode(next: Mode): void {
  if (next === mode) return;
  if (mode === "tone") {
    engine.stopTone();
    toneString = -1;
  }
  mode = next;
  storage.set(MODE_KEY, mode);
  engine.resetSmoothing();
  renderMode();
  renderListenBtn();
  showIdle();
  if (mode !== "tone" && storage.get<boolean>(MIC_OK, false)) void startListening();
}

function useTuning(t: Tuning): void {
  tuning = t;
  setCurrentTuning(t.id);
  tuned = new Set();
  picked = Math.min(picked, t.strings.length - 1);
  engine.stopTone();
  toneString = -1;
  const range = listenRange(t);
  engine.setRange(range.minFreq, range.maxFreq);
  renderAll();
}

async function requestWakeLock(): Promise<void> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    wakeLock = (await wl?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }
}

function micMessage(err: unknown): string {
  if (err === "denied")
    return "Fretline can't use the mic. Allow it in your phone's Settings → Apps → Fretline → Permissions → Microphone, then try again.";
  if (err === "unsupported") return "This browser can't use the mic.";
  return "Couldn't start the mic. Close other apps using it and try again.";
}

async function startListening(): Promise<void> {
  const errEl = $("mic-error");
  errEl.hidden = true;
  try {
    const range = listenRange(tuning);
    engine.setRange(range.minFreq, range.maxFreq);
    await engine.startListening();
    storage.set(MIC_OK, true);
    void requestWakeLock();
  } catch (err) {
    errEl.textContent = micMessage(err);
    errEl.hidden = false;
    if (err === "denied") storage.set(MIC_OK, false);
  }
  renderListenBtn();
  showIdle();
}

export function stopTuner(): void {
  engine.stopListening();
  engine.stopTone();
  toneString = -1;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  renderListenBtn();
  showIdle();
}

// --- Tuning sheet ---------------------------------------------------------------------------

let sheetInstrument: InstrumentId = "guitar";

function renderTuningSheet(): void {
  const tabs = $("instrument-tabs");
  tabs.innerHTML = INSTRUMENTS.map(
    (x) => `<button type="button" role="tab" data-inst="${x.id}" aria-selected="${x.id === sheetInstrument}">${x.label}</button>`,
  ).join("");
  tabs.querySelectorAll<HTMLElement>("button").forEach((b) =>
    b.addEventListener("click", () => {
      sheetInstrument = b.dataset.inst as InstrumentId;
      renderTuningSheet();
    }),
  );

  const list = $("tuning-list");
  list.innerHTML = "";
  for (const t of tuningsFor(sheetInstrument)) {
    const row = document.createElement("div");
    row.className = `tuning-row${t.id === tuning.id ? " current" : ""}`;
    row.innerHTML = `<button type="button" class="tuning-pick"><b>${escapeHtml(t.name)}</b><span class="tuning-notes">${escapeHtml(shortNotes(t))}</span></button>${
      t.custom ? `<button type="button" class="row-action">Edit</button>` : ""
    }`;
    row.querySelector(".tuning-pick")!.addEventListener("click", () => {
      useTuning(t);
      closeSheet();
    });
    row.querySelector(".row-action")?.addEventListener("click", () => openEditor(t));
    list.appendChild(row);
  }

  const songs = songTunings();
  const songList = $("song-list");
  songList.innerHTML = songs.length
    ? ""
    : `<p class="muted" style="margin:0">Save the tuning a song needs, then pick the song here next time.</p>`;
  for (const s of songs) {
    const t = findTuning(s.tuningId)!;
    const row = document.createElement("div");
    row.className = "song-row";
    row.innerHTML = `<button type="button" class="song-pick"><b>${escapeHtml(s.song)}</b><span class="tuning-notes">${escapeHtml(
      `${t.name}: ${shortNotes(t)}`,
    )}</span></button><button type="button" class="row-action">Remove</button>`;
    row.querySelector(".song-pick")!.addEventListener("click", () => {
      useTuning(t);
      closeSheet();
      bus.emit("toast", `Tuned for ${s.song}: ${t.name}`);
    });
    row.querySelector(".row-action")!.addEventListener("click", () => {
      deleteSongTuning(s.id);
      renderTuningSheet();
    });
    songList.appendChild(row);
  }
}

function openTuningSheet(): void {
  sheetInstrument = tuning.instrument;
  renderTuningSheet();
  openSheet("tuning-sheet");
}

// --- Editor -----------------------------------------------------------------------------------

let draft: { id?: string; name: string; instrument: InstrumentId; midis: number[] } | null = null;

function renderEditor(): void {
  if (!draft) return;
  $("editor-title").textContent = draft.id ? "Edit tuning" : "New tuning";
  $("editor-delete").hidden = !draft.id;
  const host = $("editor-strings");
  host.innerHTML = "";
  const n = draft.midis.length;
  // Highest string first, like the tuner.
  for (let i = n - 1; i >= 0; i--) {
    const row = document.createElement("div");
    row.className = "editor-row";
    const num = n - i;
    row.innerHTML = `<span class="label">String ${num}${i === 0 ? ", low" : num === 1 ? ", high" : ""}</span>
      <button type="button" class="step-btn" aria-label="Lower string ${num}">−</button>
      <output>${midiToNote(draft.midis[i])}</output>
      <button type="button" class="step-btn" aria-label="Raise string ${num}">+</button>`;
    const [down, up] = row.querySelectorAll("button");
    down.addEventListener("click", () => step(i, -1));
    up.addEventListener("click", () => step(i, 1));
    host.appendChild(row);
  }
  $<HTMLButtonElement>("editor-remove").disabled = n <= 3;
  $<HTMLButtonElement>("editor-add").disabled = n >= 8;
}

function step(i: number, by: number): void {
  if (!draft) return;
  draft.midis[i] = Math.max(noteToMidi("A0"), Math.min(noteToMidi("C6"), draft.midis[i] + by));
  renderEditor();
}

function openEditor(t?: Tuning): void {
  const base =
    t ??
    (tuning.instrument === sheetInstrument ? tuning : PRESETS.find((p) => p.instrument === sheetInstrument) ?? PRESETS[0]);
  draft = {
    id: t?.custom ? t.id : undefined,
    name: t?.custom ? t.name : "",
    instrument: base.instrument,
    midis: base.strings.map(noteToMidi),
  };
  $<HTMLInputElement>("editor-name").value = draft.name;
  $("editor-error").hidden = true;
  renderEditor();
  openSheet("editor-sheet", () => {
    draft = null;
  });
}

function saveEditor(): void {
  if (!draft) return;
  const name = $<HTMLInputElement>("editor-name").value.trim();
  if (!name) {
    const e = $("editor-error");
    e.textContent = "Give the tuning a name.";
    e.hidden = false;
    return;
  }
  const id = saveCustomTuning({ id: draft.id, name, instrument: draft.instrument, strings: draft.midis.map(midiToNote) });
  useTuning(findTuning(id)!);
  closeSheet();
  bus.emit("toast", `Saved ${name}`);
}

// --- Setup ------------------------------------------------------------------------------------

export function initTuner(): void {
  drawGauge();
  engine.onReading(onReading);
  renderAll();

  $("tuning-btn").addEventListener("click", openTuningSheet);
  $("new-tuning-btn").addEventListener("click", () => openEditor());
  $("editor-save").addEventListener("click", saveEditor);
  $("editor-add").addEventListener("click", () => {
    if (!draft || draft.midis.length >= 8) return;
    draft.midis.push(draft.midis[draft.midis.length - 1] + 5);
    renderEditor();
  });
  $("editor-remove").addEventListener("click", () => {
    if (!draft || draft.midis.length <= 3) return;
    draft.midis.pop();
    renderEditor();
  });
  $("editor-delete").addEventListener("click", () => {
    if (!draft?.id || !confirm("Delete this tuning? Songs using it go back to standard.")) return;
    deleteCustomTuning(draft.id);
    useTuning(currentTuning());
    closeSheet();
  });
  $<HTMLFormElement>("song-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("song-input");
    const song = input.value.trim();
    if (!song) return;
    saveSongTuning(song, tuning.id);
    input.value = "";
    renderTuningSheet();
    bus.emit("toast", `${song} uses ${tuning.name}`);
  });

  // Reference pitch
  const renderA4 = () => {
    $("a4-out").textContent = `${getA4()} Hz`;
    renderHead();
    engine.resetSmoothing();
  };
  $("a4-btn").addEventListener("click", () => {
    renderA4();
    openSheet("a4-sheet");
  });
  $("a4-down").addEventListener("click", () => {
    setA4(getA4() - 1);
    renderA4();
  });
  $("a4-up").addEventListener("click", () => {
    setA4(getA4() + 1);
    renderA4();
  });
  $("a4-reset").addEventListener("click", () => {
    setA4(440);
    renderA4();
  });

  document.querySelectorAll<HTMLElement>(".mode-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as Mode)));
  $("sustain").addEventListener("change", () => {
    if (toneString >= 0) {
      const i = toneString;
      toneString = -1;
      onStringTap(i);
    }
  });
  $("listen-btn").addEventListener("click", () => (engine.isListening() ? stopTuner() : void startListening()));

  // Only listen while the tuner is on screen.
  bus.on("viewchange", (v) => {
    if (v !== "tuner") stopTuner();
    else if (storage.get<boolean>(MIC_OK, false) && mode !== "tone" && !document.documentElement.classList.contains("entry"))
      void startListening();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopTuner();
    else if (currentView() === "tuner" && storage.get<boolean>(MIC_OK, false) && mode !== "tone" && !isSheetOpen())
      void startListening();
  });
}
