// The live tab strip under the video: the phrase he's explaining, the note
// he's on lit up, his words for it pinned underneath. Tap a note to fix it;
// tap the strip to pause or play. Fixes are saved (and synced).
import { bus } from "../state";
import { $, escapeHtml } from "../utils";
import { closeSheet, openSheet } from "../ui/sheets";
import { getFixes, saveFixes } from "./fixes";
import { pictureSrc } from "../scan/ui";
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
}

const FINGER_MARK: Record<Finger, string> = { thumb: "T", index: "i", middle: "m", ring: "r", pinky: "p" };
const FINGERS: (Finger | null)[] = [null, "index", "middle", "ring", "pinky", "thumb"];
const TECHS: (Technique | null)[] = [null, "hammer", "pull", "slide", "bend", "harmonic"];
const TECH_NAME: Record<Technique, string> = { hammer: "Hammer-on", pull: "Pull-off", slide: "Slide", bend: "Bend", harmonic: "Harmonic" };

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
let editing: TabNote | null = null;
let draft: Pick<TabNote, "string" | "fret" | "finger" | "tech"> | null = null;

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function rebuild(): void {
  base = combine(speech, fixes.screen);
  phrases = toPhrases(applyFixes(base, fixes));
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
          return `<div class="staff-cell"><button type="button" class="tnote${n.source === "you" || fixes.edits[n.id] ? " yours" : ""}" data-id="${escapeHtml(n.id)}" aria-label="String ${s}, fret ${n.fret}">${escapeHtml(fretLabel(n))}${finger}</button></div>`;
        })
        .join("");
      return `<div class="staff-col" data-col="${ci}">${cells}</div>`;
    })
    .join("");
  host.innerHTML = `<div class="staff-col labels" aria-hidden="true">${labels}</div>${cols}`;
}

/** Update for the moment `t` in the video (called every frame). */
export function render(t: number): void {
  if (!videoId) return;
  if (!phrases.length) {
    if (shownPhrase !== -1) {
      const none = fixes.screen?.none;
      $("strip-staff").innerHTML = `<p class="strip-empty">No notes found in his words yet.${none ? ` ${none}` : " If the video shows tab, tap <b>Read video tab</b>."} Tap <b>+ Note</b> to add one at this moment.</p>`;
      $("strip-label").textContent = "Tab";
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
    const fromScreen = p.columns.some((c) => c.notes.some((n) => n.source === "screen"));
    $("strip-label").textContent = at.upcoming
      ? `Next notes, at ${fmt(p.start)}`
      : `${fromScreen ? "Tab from the video" : "Notes from what he says"} · ${at.index + 1} of ${phrases.length}`;
  }
  const col = at.upcoming ? -1 : columnAt(p, t);
  if (col === shownColumn) return;
  shownColumn = col;
  const host = $("strip-staff");
  host.querySelectorAll<HTMLElement>(".staff-col[data-col]").forEach((el) => {
    const i = Number(el.dataset.col);
    el.classList.toggle("done", i <= col);
    el.classList.toggle("now", i === col);
  });
  const nowEl = host.querySelector<HTMLElement>(".staff-col.now");
  if (nowEl) host.scrollTo({ left: nowEl.offsetLeft - host.clientWidth / 2 + nowEl.clientWidth / 2 });
  const tip = col >= 0 && controls ? controls.saidAt(p.columns[col].t) : "";
  $("strip-tip").textContent = tip ? `“${tip}”` : "";
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
