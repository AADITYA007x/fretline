// The "My notes" pane: the tab in your notebook style, numbered lines you can
// tick off, tap to play, print or save as PDF.
import { bus } from "../state";
import { $ } from "../utils";
import { tabScan } from "../scan/native";
import { cellHtml, clock, doneLines, lessonLines, setDone, shorten, toPrintHtml, toText, type NoteLine } from "./notebook";
import { escapeHtml } from "../utils";
import { getProgress } from "../practice/progress";
import { saveProgress } from "./fixes";
import { currentTab, onTabChange } from "./strip";
import { chordSheetHtml } from "./chords";
import { openSheet } from "../ui/sheets";

/** Tapped a chord name or a held shape: show where the fingers go. */
export function showShape(el: HTMLElement): void {
  const name = el.dataset.chord ?? null;
  const shape = el.dataset.shape ? el.dataset.shape.split(",").map(Number) : null;
  $("chord-title").textContent = name ?? "Hold this shape";
  $("chord-body").innerHTML = chordSheetHtml(name, shape && shape.length === 6 ? shape : null);
  openSheet("chord-sheet");
}

/** The chord name / held shape under a tap, if any. */
export function shapeTarget(target: EventTarget | null): HTMLElement | null {
  return (target as HTMLElement | null)?.closest<HTMLElement>(".nb-chordtag, .nb-cell[data-shape]") ?? null;
}

let lines: NoteLine[] = [];
/** A talk-through lesson: the lines are the steps he teaches. */
let talk = false;
let shownFor: string | null = null;
let lit = -1;
/** The line you tapped stays lit while the video runs up to it. */
let pinned = -1;
let pinnedAt = 0;
let jumpTo: (sec: number) => void = () => {};
let titleOf: () => string = () => "Fretline tab";

function visible(): boolean {
  return !$("pane-notebook").hidden;
}

function renderProgress(done: number[]): void {
  const total = lines.length;
  $("nb-progress").textContent = total ? `${done.filter((n) => n <= total).length} of ${total} ${talk ? "steps" : "lines"} done` : "";
}

const KEY_TAB = "Fret on top, string below · + together · [frets / strings] hold · roll = strum · 5→7 slide · ‖ ‖ hammer-on · ✋ slap. Tap a line to play it, tick it when you've got it.";
const KEY_TALK = "The steps he teaches, in order: a phrase he goes over again is one step, with every moment he does. Fret on top, string below (i m r p = finger) · + together · 5→7 slide · ‖ ‖ hammer-on. Tap a step to hear him teach it, tick it when you've got it.";

/** How many lines there are, kept with the progress (for the practice list). */
function rememberTotal(videoId: string | null): void {
  if (!videoId || !lines.length) return;
  const p = getProgress(videoId);
  if (p.total !== lines.length) saveProgress(videoId, { ...p, total: lines.length });
}

/** The other moments he goes through a step: a few to tap, the rest counted. */
function againHtml(l: NoteLine): string {
  const others = (l.tellings ?? []).filter((x) => Math.abs(x.start - l.t) > 1);
  if (l.words === undefined || !others.length) return "";
  const shown = others.slice(0, 4);
  return `<div class="nb-again">Again at ${shown.map((x) => `<button type="button" class="nb-at" data-t="${x.start}">${clock(x.start)}</button>`).join("")}${others.length > shown.length ? `<span>+${others.length - shown.length} more</span>` : ""}</div>`;
}

export function renderNotebook(): void {
  const tab = currentTab();
  const { videoId } = tab;
  lines = lessonLines(tab);
  talk = tab.talk && lines.length > 0;
  shownFor = videoId;
  lit = -1;
  $("nb-key").textContent = talk ? KEY_TALK : KEY_TAB;
  rememberTotal(videoId);
  const host = $("nb-lines");
  ($("nb-print") as HTMLButtonElement).disabled = !lines.length;
  ($("nb-text") as HTMLButtonElement).disabled = !lines.length;
  if (!lines.length) {
    host.innerHTML = `<p class="muted pane-empty">No notes yet. Tap “Read tab from video” (or add notes on the strip) and they'll show here, written your way.</p>`;
    renderProgress([]);
    return;
  }
  const done = videoId ? doneLines(videoId) : [];
  host.innerHTML = lines
    .map(
      (l) => `<div class="nb-line${done.includes(l.n) ? " done" : ""}" data-line="${l.n}">
  <button type="button" class="nb-tick" aria-pressed="${done.includes(l.n)}" aria-label="Line ${l.n} done">${done.includes(l.n) ? "✓" : ""}</button>
  <button type="button" class="nb-play" data-t="${l.t}" aria-label="Play line ${l.n} from ${clock(l.t)}"><span class="nb-no">${l.n}</span><span class="nb-time">${clock(l.t)}</span>${l.words !== undefined && (l.tellings?.length ?? 0) > 1 ? `<span class="nb-times">taught ${l.tellings!.length}×</span>` : ""}</button>
  ${l.words ? `<p class="nb-words">“${escapeHtml(shorten(l.words))}”</p>` : ""}
  <div class="nb-cells">${l.cells.map((c) => cellHtml(c)).join("")}</div>
  ${againHtml(l)}
</div>`,
    )
    .join("");
  renderProgress(done);
}

/** Light the line being played. */
export function highlightNotebook(t: number): void {
  if (!visible() || !lines.length) return;
  let i = -1;
  if (talk) {
    // whichever step he's going through right now (any telling of it)
    i = lines.findIndex((l) => l.words !== undefined && (l.tellings ?? []).some((x) => t >= x.start - 0.5 && t <= x.end + 3));
  } else {
    for (let k = 0; k < lines.length; k++) if (lines[k].t <= t + 0.05) i = k;
    if (i >= 0 && t > lines[i].end + 3 && (lines[i + 1]?.t ?? Infinity) > t + 3) i = -1;
  }
  if (pinned >= 0) {
    if (i >= pinned || Date.now() - pinnedAt >= 4000) pinned = -1;
    else i = pinned;
  }
  if (i === lit) return;
  lit = i;
  document.querySelectorAll<HTMLElement>("#nb-lines .nb-line").forEach((el, k) => el.classList.toggle("now", k === i));
}

async function printIt(): Promise<void> {
  const { videoId } = currentTab();
  const html = toPrintHtml(titleOf(), lines, videoId ? doneLines(videoId) : []);
  try {
    await tabScan.printHtml({ html, name: titleOf() });
  } catch {
    // In a browser: print through a hidden frame.
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
    document.body.appendChild(f);
    f.contentDocument?.open();
    f.contentDocument?.write(html);
    f.contentDocument?.close();
    setTimeout(() => {
      try {
        f.contentWindow?.print();
      } finally {
        setTimeout(() => f.remove(), 1000);
      }
    }, 200);
  }
}

async function shareText(): Promise<void> {
  const text = toText(titleOf(), lines);
  try {
    await tabScan.shareText({ text, name: titleOf() });
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      bus.emit("toast", "Copied the tab as text");
    } catch {
      bus.emit("toast", "Couldn't copy here");
    }
  }
}

export function initNotebook(jump: (sec: number) => void, title: () => string): void {
  jumpTo = jump;
  titleOf = title;
  onTabChange(() => {
    if (visible() || shownFor !== currentTab().videoId) renderNotebook();
  });
  $("nb-lines").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".nb-line");
    if (!row) return;
    const shapeEl = shapeTarget(target);
    if (shapeEl) {
      showShape(shapeEl);
      return;
    }
    const n = Number(row.dataset.line);
    const at = target.closest<HTMLElement>(".nb-at");
    if (at) {
      pinned = n - 1;
      pinnedAt = Date.now();
      lit = -2;
      jumpTo(Math.max(0, Number(at.dataset.t) - 1));
      return;
    }
    if (target.closest(".nb-tick")) {
      const { videoId } = currentTab();
      if (!videoId) return;
      const on = !row.classList.contains("done");
      const done = setDone(videoId, n, on);
      row.classList.toggle("done", on);
      const tick = row.querySelector<HTMLElement>(".nb-tick")!;
      tick.setAttribute("aria-pressed", String(on));
      tick.textContent = on ? "✓" : "";
      renderProgress(done);
      return;
    }
    const line = lines[n - 1];
    if (!line) return;
    pinned = n - 1;
    pinnedAt = Date.now();
    lit = -2;
    // a step: from a little before, so you hear him start on it
    jumpTo(Math.max(0, line.t - (talk ? 2 : 0.4)));
  });
  $("nb-print").addEventListener("click", () => void printIt());
  $("nb-text").addEventListener("click", () => void shareText());
}
