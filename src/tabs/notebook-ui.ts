// The "My notes" pane: the tab in your notebook style, numbered lines you can
// tick off, tap to play, print or save as PDF.
import { bus } from "../state";
import { $ } from "../utils";
import { tabScan } from "../scan/native";
import { cellHtml, clock, doneLines, notebookLines, setDone, toPrintHtml, toText, type NoteLine } from "./notebook";
import { currentTab, onTabChange } from "./strip";

let lines: NoteLine[] = [];
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
  $("nb-progress").textContent = total ? `${done.filter((n) => n <= total).length} of ${total} lines done` : "";
}

export function renderNotebook(): void {
  const { videoId, notes, chords } = currentTab();
  lines = notebookLines(notes, chords);
  shownFor = videoId;
  lit = -1;
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
  <button type="button" class="nb-play" data-t="${l.t}" aria-label="Play line ${l.n} from ${clock(l.t)}"><span class="nb-no">${l.n}</span><span class="nb-time">${clock(l.t)}</span></button>
  <div class="nb-cells">${l.cells.map(cellHtml).join("")}</div>
</div>`,
    )
    .join("");
  renderProgress(done);
}

/** Light the line being played. */
export function highlightNotebook(t: number): void {
  if (!visible() || !lines.length) return;
  let i = -1;
  for (let k = 0; k < lines.length; k++) if (lines[k].t <= t + 0.05) i = k;
  if (i >= 0 && t > lines[i].end + 3 && (lines[i + 1]?.t ?? Infinity) > t + 3) i = -1;
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
    const n = Number(row.dataset.line);
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
    jumpTo(Math.max(0, line.t - 0.4));
  });
  $("nb-print").addEventListener("click", () => void printIt());
  $("nb-text").addEventListener("click", () => void shareText());
}
