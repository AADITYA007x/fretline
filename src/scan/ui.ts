// The "Read video tab" button and its progress, inside the tab strip.
import { Capacitor } from "@capacitor/core";
import { bus } from "../state";
import { $ } from "../utils";
import { getFixes, saveScreenTab } from "../tabs/fixes";
import { closeSheet, openSheet } from "../ui/sheets";
import { tabScan, connection } from "./native";
import { scanLesson, scanning, stopScan, SCAN_VERSION, type Step } from "./scan";

let lessonId: () => string | null = () => null;
let onDone: (videoId: string) => void = () => {};
let waitingForWifi: string | null = null;

const PHASE: Record<Step["phase"], string> = {
  download: "Downloading the video (deleted after)",
  look: "Looking through the video",
  read: "Reading the tab",
  sound: "Listening for the plucks",
};

function showStep(s: Step): void {
  $("scan-row").hidden = false;
  $("scan-text").textContent = `${PHASE[s.phase]}${s.detail ? ` · ${s.detail}` : ` · ${Math.round(s.fraction * 100)}%`}`;
  // Download ~40% of the work, looking ~35%, reading ~15%, the sound the rest.
  const base = { download: 0, look: 0.4, read: 0.75, sound: 0.9 }[s.phase];
  const span = { download: 0.4, look: 0.35, read: 0.15, sound: 0.1 }[s.phase];
  $("scan-fill").style.width = `${((base + s.fraction * span) * 100).toFixed(1)}%`;
}

/** Show the button only when this lesson's video hasn't been read yet. */
export function renderScanButton(): void {
  const id = lessonId();
  const screen = id ? getFixes(id).screen : undefined;
  const busy = scanning() !== null;
  const old = !!screen?.notes.length && (screen.v ?? 1) < SCAN_VERSION;
  $("scan-btn").hidden = !id || busy || (!!screen?.notes.length && !old);
  $("scan-btn").textContent = old ? "Read again" : "Read video tab";
  $("scan-row").hidden = !busy || scanning() !== id;
}

async function run(videoId: string, maxHeight = 720): Promise<void> {
  showStep({ phase: "download", fraction: 0 });
  renderScanButton();
  $("scan-row").hidden = false;
  try {
    const result = await scanLesson(videoId, showStep, maxHeight);
    saveScreenTab(videoId, { at: Date.now(), notes: result.notes, pages: result.pages, none: result.none, chords: result.chords, capo: result.capo, v: SCAN_VERSION });
    bus.emit("toast", result.none ?? `Read ${result.notes.length} notes from the video's tab`);
    onDone(videoId);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    bus.emit("toast", /Stopped/.test(msg) ? "Stopped. Nothing was kept." : `Couldn't read the video: ${msg}`);
  } finally {
    $("scan-row").hidden = true;
    renderScanButton();
  }
}

async function start(): Promise<void> {
  const videoId = lessonId();
  if (!videoId || scanning()) return;
  const net = await connection();
  if (net === "none") {
    bus.emit("toast", "You're offline. Connect to Wi-Fi to read the video.");
    return;
  }
  if (net === "cellular") {
    let size = "";
    try {
      const info = await tabScan.prepare({ videoId, maxHeight: 720 });
      if (info.bytes > 0) size = `about ${Math.max(1, Math.round(info.bytes / 1e6))} MB`;
    } catch {
      // size unknown
    }
    $("scan-sheet-text").textContent = `Reading the tab needs the video once (${size || "its size is unknown"}, picture only, deleted after). Wait for Wi-Fi, or use mobile data now?`;
    openSheet("scan-sheet");
    return;
  }
  void run(videoId);
}

export function initScanUi(currentLesson: () => string | null, done: (videoId: string) => void): void {
  lessonId = currentLesson;
  onDone = done;
  $("scan-btn").addEventListener("click", () => void start());
  $("scan-stop").addEventListener("click", () => {
    const id = scanning();
    if (id) void stopScan(id);
  });
  $("scan-go").addEventListener("click", () => {
    closeSheet();
    const id = lessonId();
    if (id) void run(id, 720);
  });
  $("scan-wait").addEventListener("click", () => {
    closeSheet();
    waitingForWifi = lessonId();
    bus.emit("toast", "It'll start by itself when you're on Wi-Fi (keep Fretline open)");
  });
  // Waiting for Wi-Fi: check now and then.
  setInterval(async () => {
    if (!waitingForWifi || scanning()) return;
    if ((await connection()) === "wifi") {
      const id = waitingForWifi;
      waitingForWifi = null;
      void run(id);
    }
  }, 5000);
}

/** The picture for a tab page saved on this phone. */
export function pictureSrc(path: string): string {
  return Capacitor.convertFileSrc(path.startsWith("file://") ? path : `file://${path}`);
}

/** Send what the reader saw for a lesson (to check its accuracy). */
export async function shareReading(videoId: string): Promise<void> {
  try {
    await tabScan.shareReport({ videoId });
  } catch (err) {
    bus.emit("toast", `Couldn't share: ${(err as Error).message ?? err}`);
  }
}
