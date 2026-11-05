// The live tab strip under the video: the phrase he's explaining, the note
// he's on lit up, his words for it pinned underneath. Tap a note to fix it;
// tap the strip to pause or play. Fixes are saved (and synced).
import { bus } from "../state";
import { $, escapeHtml } from "../utils";
import { closeSheet, openSheet } from "../ui/sheets";
import { getFixes, saveFixes } from "./fixes";
import { pictureSrc, shareReading } from "../scan/ui";
import type { Finger, Technique } from "./speech";
import {
  applyFixes,
  columnAt,
  combine,
  fretLabel,
  newNoteId,
  phraseAt,
  STRING_NAMES,
  toPhrases,
  type Fixes,
  type Phrase,
  type TabNote,
} from "./tab";

export interface StripControls {
  time(): number;
  isPlaying(): boolean;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  /** The caption line he was saying at a moment (the tip under the tab). */
  saidAt(sec: number): string;
  /**
   * 1 by 1: pause on a note with a card over the video saying what it is
   * (`text`), or take the card away (null) and carry on playing (`resume`).
   */
  hold(text: string | null, ms: number, resume?: boolean): void;
  /** Playback speed (1 = normal). */
  rate(): number;
}

const FINGER_MARK: Record<Finger, string> = { thumb: "T", index: "i", middle: "m", ring: "r", pinky: "p" };
const FINGERS: (Finger | null)[] = [null, "index", "middle", "ring", "pinky", "thumb"];
const TECHS: (Technique | null)[] = [null, "hammer", "pull", "slide", "bend", "harmonic", "mute"];
const TECH_NAME: Record<Technique, string> = { hammer: "Hammer-on", pull: "Pull-off", slide: "Slide", bend: "Bend", harmonic: "Harmonic", mute: "Muted (x)" };

let videoId: string | null = null;
let speech: TabNote[] = [];
/** Notes before fixes: from the screen where there's on-screen tab, his words elsewhere. */
let base: TabNote[] = [];
let fixes: Fixes = getFixes("");
let phrases: Phrase[] = [];
let controls: StripControls | null = null;
let shownPhrase = -2;
let shownColumn = -2;
let shownUpcoming = false;
let shownLabel = "";
let shownFromScreen = false;
let editing: TabNote | null = null;
let draft: Pick<TabNote, "string" | "fret" | "finger" | "tech"> | null = null;

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Where the on-screen tab starts or stops (not each page change: pages
 * that follow each other run on as one continuous tape).
 */
function tabBreaks(pages: { start: number; end: number }[]): number[] {
  const out: number[] = [];
  const sorted = [...pages].sort((a, b) => a.start - b.start);
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    if (!prev || p.start - prev.end > 1.5) out.push(p.start);
    if (!next || next.start - p.end > 1.5) out.push(p.end);
  });
  return out;
}

/** "page 4 of 20" for the video's tab page showing at t. */
function pageLabel(t: number): string {
  const pages = fixes.screen?.pages ?? [];
  const i = pages.findIndex((p) => t >= p.start - 0.05 && t < p.end);
  return i >= 0 ? `page ${i + 1} of ${pages.length}` : "";
}

let colEls: HTMLElement[] = [];
/** Until when the tape stays where you scrolled it. */
/** You scrolled the tape yourself: it stays there until "Back to now" or play. */
let handsOn = false;
/** Where the tape was last put by the app (to tell your scrolling from ours). */
let placedAt = -1;

export function followAgain(): void {
  handsOn = false;
  $("strip-follow").hidden = true;
}

/** Glide the tape so the moment t sits a third of the way in. */
function glide(p: Phrase, t: number, upcoming: boolean): void {
  const host = $("strip-staff");
  if (handsOn || !colEls.length) return;
  let x: number;
  if (upcoming) x = colEls[0].offsetLeft;
  else {
    const i = Math.max(0, columnAt(p, t));
    const a = colEls[i];
    const b = colEls[i + 1];
    const ca = a.offsetLeft + a.clientWidth / 2;
    if (!b || columnAt(p, t) < 0) x = ca;
    else {
      const ta = p.columns[i].t;
      const tb = p.columns[i + 1].t;
      const k = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
      x = ca + k * (b.offsetLeft + b.clientWidth / 2 - ca);
    }
  }
  const left = Math.max(0, Math.min(host.scrollWidth - host.clientWidth, Math.round(x - host.clientWidth * 0.35)));
  if (left !== Math.round(host.scrollLeft)) host.scrollLeft = left;
  placedAt = Math.round(host.scrollLeft);
}

function rebuild(): void {
  base = combine(speech, fixes.screen);
  phrases = toPhrases(applyFixes(base, fixes), 7, tabBreaks(fixes.screen?.pages ?? []));
  pictureFor = -1;
  shownPhrase = -2;
  if (controls) render(controls.time());
}

/** A lesson opened (or its captions arrived): its notes from his words. */
export function setTab(id: string, notes: TabNote[], c: StripControls): void {
  videoId = id;
  speech = notes;
  fixes = getFixes(id);
  controls = c;
  rebuild();
}

export function clearTab(): void {
  videoId = null;
  speech = [];
  base = [];
  showPicture(false);
  phrases = [];
  shownPhrase = -2;
  $("strip-staff").innerHTML = "";
}

/** The last note on string s before column ci of the phrase. */
function prevOnString(p: Phrase, ci: number, s: number): TabNote | undefined {
  for (let i = ci - 1; i >= 0; i--) {
    const n = p.columns[i].notes.find((x) => x.string === s);
    if (n) return n;
  }
  return undefined;
}

function renderPhrase(p: Phrase): void {
  const host = $("strip-staff");
  const labels = [1, 2, 3, 4, 5, 6].map((s) => `<div class="staff-cell">${STRING_NAMES[s]}</div>`).join("");
  const cols = p.columns
    .map((c, ci) => {
      const cells = [1, 2, 3, 4, 5, 6]
        .map((s) => {
          const n = c.notes.find((x) => x.string === s);
          if (!n) return `<div class="staff-cell"></div>`;
          const finger = n.finger ? `<sup>${FINGER_MARK[n.finger]}</sup>` : "";
          // A slide is drawn as a line from the note before it on the same
          // string, going up or down like the frets do.
          let slide = "";
          let label = fretLabel(n);
          if (n.tech === "slide") {
            const before = prevOnString(p, ci, s);
            if (before) {
              slide = before.fret <= n.fret ? " slide-up" : " slide-down";
              label = String(n.fret);
            }
          }
          return `<div class="staff-cell"><button type="button" class="tnote${slide}${n.source === "you" || fixes.edits[n.id] ? " yours" : ""}" data-id="${escapeHtml(n.id)}" aria-label="String ${s}, fret ${n.fret}${n.tech ? `, ${TECH_NAME[n.tech].toLowerCase()}` : ""}">${escapeHtml(label)}${finger}</button></div>`;
        })
        .join("");
      const pageStart = ci > 0 && pageLabel(c.t) !== pageLabel(p.columns[ci - 1].t);
      const strum = c.notes.find((n) => n.strum)?.strum;
      const arrow = strum ? `<span class="strum" aria-label="Strum ${strum}">${strum === "up" ? "↑" : "↓"}</span>` : "";
      return `<div class="staff-col${pageStart ? " page-start" : ""}" data-col="${ci}">${arrow}${cells}</div>`;
    })
    .join("");
  host.innerHTML = `<div class="staff-col labels" aria-hidden="true">${labels}</div>${cols}`;
  colEls = Array.from(host.querySelectorAll<HTMLElement>(".staff-col[data-col]"));
  placedAt = -1;
}

/** Update for the moment `t` in the video (called every frame). */
export function render(t: number): void {
  if (!videoId) return;
  if (!phrases.length) {
    if (shownPhrase !== -1) {
      const none = fixes.screen?.none;
      $("strip-staff").innerHTML = `<p class="strip-empty">No notes found in his words yet.${none ? ` ${none}` : " If the video shows tab, tap <b>Read video tab</b>."} Tap <b>+ Note</b> to add one at this moment.</p>`;
      $("strip-label").textContent = "Tab";
      colEls = [];
      $("strip-tip").textContent = "";
      $("tab-strip").classList.remove("upcoming");
      shownPhrase = -1;
    }
    return;
  }
  const at = phraseAt(phrases, t);
  if (!at) return;
  const p = phrases[at.index];
  if (at.index !== shownPhrase || at.upcoming !== shownUpcoming) {
    renderPhrase(p);
    shownPhrase = at.index;
    shownUpcoming = at.upcoming;
    shownColumn = -2;
    $("tab-strip").classList.toggle("upcoming", at.upcoming);
    shownLabel = "";
    shownFromScreen = p.columns.some((c) => c.notes.some((n) => n.source === "screen"));
  }
  const fromScreen = shownFromScreen;
  const page = fromScreen ? pageLabel(t) : "";
  const label = at.upcoming
    ? `Next notes, at ${fmt(p.start)}`
    : fromScreen
      ? `Tab from the video${page ? ` · ${page}` : ""}`
      : `Notes from what he says · ${at.index + 1} of ${phrases.length}`;
  if (label !== shownLabel) {
    $("strip-label").textContent = label;
    shownLabel = label;
  }
  glide(p, t, at.upcoming);
  const col = at.upcoming ? -1 : columnAt(p, t);
  if (col === shownColumn) return;
  shownColumn = col;
  const host = $("strip-staff");
  host.querySelectorAll<HTMLElement>(".staff-col[data-col]").forEach((el) => {
    const i = Number(el.dataset.col);
    el.classList.toggle("done", i <= col);
    el.classList.toggle("now", i === col);
  });
  if (stepOn) return; // the tip shows the note being held
  const tip = col >= 0 && controls ? controls.saidAt(p.columns[col].t) : "";
  $("strip-tip").textContent = tip ? `“${tip}”` : "";
}

// --- Note by note ------------------------------------------------------------------------
// Stops on each note for a moment (showing which string and fret), then
// plays it until the next one: look, then hear.

const HOLD_MS = 2000;
let stepOn = false;
let stepAt = -1;
let stepPrevT = -1;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let resuming = false;

const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th", "6th"];

function describeColumn(c: { notes: TabNote[] }): string {
  const parts = c.notes
    .slice()
    .sort((a, b) => b.string - a.string)
    .map((n) => {
      const name = `${STRING_NAMES[n.string]} string (${ORDINAL[n.string]})`;
      if (n.tech === "mute") return `${name}: muted hit (x)`;
      const how = n.tech ? ` · ${TECH_NAME[n.tech].toLowerCase()}` : "";
      return `${name}: ${n.fret === 0 ? "open" : `fret ${n.fret}`}${how}`;
    });
  const strum = c.notes.find((n) => n.strum)?.strum;
  return (strum ? `Strum ${strum === "up" ? "↑" : "↓"} · ` : "") + parts.join(" + ");
}

export function stepMode(): boolean {
  return stepOn;
}

export function setStepMode(on: boolean): void {
  stepOn = on;
  if (holdTimer) controls?.hold(null, 0, false);
  clearTimeout(holdTimer);
  holdTimer = undefined;
  stepAt = controls ? controls.time() - 0.01 : -1;
  $("tab-strip").classList.toggle("stepping", on);
  if (!on) $("strip-tip").classList.remove("step-tip");
}

/** You pressed play (or pause) yourself: drop any hold in progress. */
export function stepCancelHold(): void {
  if (holdTimer) controls?.hold(null, 0);
  clearTimeout(holdTimer);
  holdTimer = undefined;
}

/** Called every frame with the video time. */
export function stepTick(t: number): void {
  if (!stepOn || !controls) return;
  const jumped = stepPrevT >= 0 && Math.abs(t - stepPrevT) > 1;
  stepPrevT = t;
  if (holdTimer) return;
  if (!controls.isPlaying() || jumped) {
    // (just after a wait it's starting up again: the note we stopped
    // before is the one to hear now, not to stop on again)
    if (!resuming || jumped) stepAt = t - 0.01;
    return;
  }
  resuming = false;
  // The next note after the one we last stopped on.
  let next: { t: number; notes: TabNote[] } | null = null;
  for (const p of phrases)
    for (const c of p.columns)
      if (c.t > stepAt + 0.02 && (!next || c.t < next.t)) next = c;
  // Stop just before the note: pausing takes a moment to happen, and the
  // note should be heard after the wait, not half before it.
  const lead = 0.12 * controls.rate();
  if (!next || t < next.t - lead) return;
  stepAt = next.t;
  const text = describeColumn(next);
  controls.hold(text, HOLD_MS);
  const tip = $("strip-tip");
  tip.textContent = text;
  tip.classList.add("step-tip");
  holdTimer = setTimeout(() => {
    holdTimer = undefined;
    // Now play it (up to the next note).
    resuming = true;
    controls?.hold(null, 0);
  }, HOLD_MS);
}

// --- The tab picture from the video -------------------------------------------------------

let pictureOn = false;
let pictureFor = -1;

function pageAt(t: number): number {
  const pages = fixes.screen?.pages ?? [];
  let idx = -1;
  pages.forEach((p, i) => {
    if (p.start <= t + 0.05 && p.image) idx = i;
  });
  return idx;
}

function showPicture(on: boolean): void {
  pictureOn = on;
  $("strip-picture").setAttribute("aria-pressed", String(on));
  if (!on) $("strip-img").hidden = true;
  $("strip-share").hidden = !on;
  pictureFor = -1;
}

/** Called every frame with the video time: keep the picture on the current page. */
export function renderPicture(t: number): void {
  const pages = fixes.screen?.pages ?? [];
  $("strip-picture").hidden = !pages.some((p) => p.image);
  if (!pictureOn) return;
  const i = pageAt(t);
  if (i === pictureFor) return;
  pictureFor = i;
  const img = $<HTMLImageElement>("strip-img");
  const path = i >= 0 ? pages[i].image : undefined;
  img.hidden = !path;
  if (path) img.src = pictureSrc(path);
}

// --- Editing -------------------------------------------------------------------------------

function findNote(id: string): TabNote | undefined {
  return applyFixes(base, fixes).find((n) => n.id === id);
}

function renderEditor(): void {
  if (!draft || !editing) return;
  $("note-title").textContent = findNote(editing.id) ? `Note at ${fmt(editing.t)}` : `New note at ${fmt(editing.t)}`;
  $("note-said").textContent = editing.said ? `He said: “${editing.said}”` : "";
  $("note-fret").textContent = String(draft.fret);
  const pick = (host: string, items: (string | null)[], value: string | null | undefined, label: (v: string | null) => string, set: (v: string | null) => void) => {
    const el = $(host);
    el.innerHTML = "";
    for (const v of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label(v);
      b.setAttribute("aria-pressed", String((value ?? null) === v));
      b.addEventListener("click", () => {
        set(v);
        renderEditor();
      });
      el.appendChild(b);
    }
  };
  pick(
    "note-strings",
    ["1", "2", "3", "4", "5", "6"],
    String(draft.string),
    (v) => `${v} ${STRING_NAMES[Number(v)]}`,
    (v) => (draft!.string = Number(v)),
  );
  pick("note-fingers", FINGERS, draft.finger, (v) => (v ? v[0].toUpperCase() + v.slice(1) : "Not said"), (v) => (draft!.finger = (v as Finger) ?? undefined));
  pick("note-techs", TECHS, draft.tech, (v) => (v ? TECH_NAME[v as Technique] : "Plain"), (v) => (draft!.tech = (v as Technique) ?? undefined));
  $("note-delete").hidden = !findNote(editing.id);
}

function openEditor(note: TabNote): void {
  controls?.pause();
  editing = note;
  draft = { string: note.string, fret: note.fret, finger: note.finger, tech: note.tech };
  renderEditor();
  openSheet("note-sheet", () => {
    editing = null;
    draft = null;
  });
}

function save(): void {
  if (!videoId || !editing || !draft) return;
  const exists = findNote(editing.id);
  const next: Fixes = { ...fixes, edits: { ...fixes.edits }, added: [...fixes.added] };
  if (!exists) next.added.push({ ...editing, ...draft, source: "you" });
  else if (next.added.some((a) => a.id === editing!.id)) next.added = next.added.map((a) => (a.id === editing!.id ? { ...a, ...draft! } : a));
  else next.edits[editing.id] = { string: draft.string, fret: draft.fret, finger: draft.finger, tech: draft.tech };
  fixes = next;
  saveFixes(videoId, next);
  closeSheet();
  rebuild();
  bus.emit("toast", exists ? "Note fixed" : "Note added");
}

function remove(): void {
  if (!videoId || !editing) return;
  const next: Fixes = { ...fixes, edits: { ...fixes.edits }, added: fixes.added.filter((a) => a.id !== editing!.id) };
  if (base.some((b) => b.id === editing!.id)) next.edits[editing.id] = "deleted";
  fixes = next;
  saveFixes(videoId, next);
  closeSheet();
  rebuild();
  bus.emit("toast", "Note deleted");
}

function addAtNow(): void {
  if (!controls || !videoId) return;
  const t = controls.time();
  // Start from the note he's on, so adding the next one is quick.
  const at = phraseAt(phrases, t);
  const p = at && !at.upcoming ? phrases[at.index] : null;
  const col = p ? columnAt(p, t) : -1;
  const near = p && col >= 0 ? p.columns[col].notes[0] : null;
  openEditor({ id: newNoteId(), t, string: near?.string ?? 1, fret: near?.fret ?? 0, source: "you" });
}

/** Fixes arrived from the account for the open lesson. */
export function reloadFixes(id: string): void {
  if (id !== videoId) return;
  fixes = getFixes(id);
  rebuild();
}

export function initStrip(): void {
  // Scrolling the tape yourself keeps it there (with a way back).
  $("strip-staff").addEventListener(
    "scroll",
    () => {
      const now = Math.round($("strip-staff").scrollLeft);
      if (placedAt >= 0 && Math.abs(now - placedAt) > 3 && !handsOn) {
        handsOn = true;
        $("strip-follow").hidden = false;
      }
    },
    { passive: true },
  );
  $("strip-follow").addEventListener("click", followAgain);
  $("strip-staff").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".tnote");
    if (btn) {
      const n = findNote(btn.dataset.id ?? "");
      if (n) openEditor(n);
      return;
    }
    if (!controls) return;
    if (controls.isPlaying()) controls.pause();
    else controls.play();
  });
  $("strip-add").addEventListener("click", addAtNow);
  $("strip-picture").addEventListener("click", () => showPicture(!pictureOn));
  $("strip-share").addEventListener("click", () => {
    if (videoId) void shareReading(videoId);
  });
  $("strip-img").addEventListener("error", () => ($("strip-img").hidden = true));
  $("note-fret-down").addEventListener("click", () => {
    if (!draft) return;
    draft.fret = Math.max(0, draft.fret - 1);
    renderEditor();
  });
  $("note-fret-up").addEventListener("click", () => {
    if (!draft) return;
    draft.fret = Math.min(24, draft.fret + 1);
    renderEditor();
  });
  $("note-save").addEventListener("click", save);
  $("note-delete").addEventListener("click", remove);
  $("note-jump").addEventListener("click", () => {
    if (!editing || !controls) return;
    const t = editing.t;
    closeSheet();
    controls.seek(Math.max(0, t - 2));
    controls.play();
  });
}
