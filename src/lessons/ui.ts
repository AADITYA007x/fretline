// Lessons: the list, adding by link or Share, and the lesson screen
// (video, his words as he says them, chapters, transcript).
import { bus } from "../state";
import { $, escapeHtml } from "../utils";
import { pushStep, removeStep } from "../ui/back";
import { currentView, showView } from "../ui/nav";
import { lineAt, pickTrack, toLines, wordAt, wordsFromJson3, type CaptionTrack, type Line } from "./captions";
import { parseVideoRef } from "./links";
import { lessonInfo } from "./native";
import {
  cacheLines,
  cachedLines,
  getLesson,
  lessons,
  newLesson,
  removeLesson,
  saveLesson,
  updateLesson,
  type Lesson,
} from "./store";
import { LessonPlayer, STATE } from "./yt-player";
import { notesFromSpeech } from "../tabs/speech";
import { fromSpoken } from "../tabs/tab";
import { clearTab, followAgain, initStrip, reloadFixes, render as renderStrip, renderPicture, setStepMode, setTab, stepCancelHold, stepMode, stepTick, type StripControls } from "../tabs/strip";
import { initScanUi, renderScanButton } from "../scan/ui";
import { tabScan } from "../scan/native";


let current: Lesson | null = null;
let player: LessonPlayer | null = null;
let lines: Line[] = [];
let shownLine = -2;
let shownWord = -2;
let speed = 1;
let playing = false;
let seeking = false;
let lastSaved = 0;
let userScrolledAt = 0;
let raf = 0;
let wakeLock: { release(): Promise<void> } | null = null;

const stripControls: StripControls = {
  time: () => player?.time() ?? 0,
  isPlaying: () => playing,
  play: () => player?.play(),
  pause: () => player?.pause(),
  seek: (sec) => player?.seek(sec),
  saidAt: (sec) => {
    const i = lineAt(lines, sec);
    return i >= 0 ? lines[i].text : "";
  },
  rate: () => speed,
  hold: (text, ms, resume = true) => {
    const card = $("video-hold");
    if (text !== null) {
      player?.pause();
      $("video-hold-note").textContent = text;
      card.style.setProperty("--hold-ms", `${ms}ms`);
      card.classList.remove("running");
      card.hidden = false;
      void card.offsetWidth; // restart the countdown bar
      card.classList.add("running");
    } else {
      card.hidden = true;
      card.classList.remove("running");
      if (resume) player?.play();
    }
  },
};

/** Notes from his words (or none yet) into the tab strip. */
function updateTab(): void {
  if (!current) return;
  setTab(current.videoId, fromSpoken(notesFromSpeech(lines.flatMap((l) => l.words))), stripControls);
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

// --- List ---------------------------------------------------------------------------

function renderList(): void {
  const list = lessons();
  $("lessons-empty").hidden = list.length > 0;
  const host = $("lesson-list");
  host.innerHTML = "";
  for (const l of list) {
    const row = document.createElement("div");
    row.className = "lesson-row";
    const progress = l.durationSec ? Math.min(100, (l.positionSec / l.durationSec) * 100) : 0;
    row.innerHTML = `
      <button type="button" class="lesson-open">
        <span class="thumb">${l.thumbnail ? `<img src="${escapeHtml(l.thumbnail)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}
          ${l.durationSec ? `<span class="thumb-time">${formatTime(l.durationSec)}</span>` : ""}
          <span class="thumb-progress" style="width:${progress.toFixed(1)}%"></span></span>
        <span class="lesson-meta"><b>${escapeHtml(l.title)}</b><span class="muted">${escapeHtml(l.uploader)}</span></span>
      </button>
      <button type="button" class="row-action lesson-remove" aria-label="Remove ${escapeHtml(l.title)}">Remove</button>`;
    row.querySelector(".lesson-open")!.addEventListener("click", () => void openLesson(l.videoId));
    row.querySelector(".lesson-remove")!.addEventListener("click", () => {
      if (!confirm(`Remove "${l.title}" from your lessons?`)) return;
      removeLesson(l.videoId);
      void tabScan.deleteImages({ videoId: l.videoId }).catch(() => {});
      renderList();
    });
    host.appendChild(row);
  }
}

function showListError(msg: string): void {
  const e = $("lesson-error");
  e.textContent = msg;
  e.hidden = !msg;
}

/** Add a lesson from a link (or shared text) and open it. */
export async function addFromText(text: string): Promise<boolean> {
  const ref = parseVideoRef(text);
  if (!ref) {
    showListError("That doesn't look like a YouTube link.");
    return false;
  }
  showListError("");
  if (!getLesson(ref.videoId)) saveLesson(newLesson(ref.videoId));
  if (ref.startSec) updateLesson(ref.videoId, { positionSec: ref.startSec });
  if (currentView() !== "lessons") showView("lessons");
  await openLesson(ref.videoId);
  return true;
}

// --- Lesson screen -------------------------------------------------------------------

function setScreen(open: boolean): void {
  $("view-lesson").hidden = !open;
  $("view-lessons").hidden = open || currentView() !== "lessons";
  document.documentElement.classList.toggle("in-lesson", open);
}

async function openLesson(videoId: string): Promise<void> {
  const l = updateLesson(videoId, { openedAt: Date.now() });
  if (!l) return;
  if (current?.videoId !== videoId) closePlayer();
  current = l;
  setScreen(true);
  pushStep("lesson", () => closeLesson(false));
  renderHead();
  renderChapters();
  lines = [];
  shownLine = shownWord = -2;
  renderTranscript();
  updateTab();
  renderScanButton();
  $("video-error").hidden = true;

  if (!player) {
    player = new LessonPlayer($("lesson-video"), {
      onState: onPlayerState,
      onError: (msg) => {
        const e = $("video-error");
        e.textContent = msg;
        e.hidden = false;
      },
    });
    player.open(videoId, l.positionSec).catch((err: Error) => {
      const e = $("video-error");
      e.textContent = err.message;
      e.hidden = false;
    });
    speed = 1;
    renderSpeed();
  }
  startLoop();
  if (!l.loaded) await loadDetails(videoId);
  await loadCaptions();
}

async function loadDetails(videoId: string): Promise<void> {
  try {
    const info = await lessonInfo.info({ videoId });
    const next = updateLesson(videoId, {
      title: info.title || "Untitled lesson",
      uploader: info.uploader || "",
      durationSec: info.durationSec || 0,
      thumbnail: info.thumbnail ?? current?.thumbnail ?? null,
      chapters: (info.chapters ?? []).filter((c) => Number.isFinite(c.startSec)),
      captions: info.captions ?? [],
      loaded: true,
    });
    if (next && current?.videoId === videoId) {
      current = next;
      renderHead();
      renderChapters();
    }
  } catch (err) {
    if (current?.videoId === videoId) {
      $("caption-name").textContent = "";
      if (current.title === "Loading lesson…") $("lesson-title").textContent = "YouTube lesson";
      $("chapter-list").innerHTML = `<p class="muted pane-empty">Chapters couldn't load.</p>`;
      setSaying(`Couldn't load the lesson's details: ${(err as Error).message}`);
    }
  }
}

function chosenTrack(): CaptionTrack | null {
  if (!current) return null;
  const tracks = current.captions;
  return tracks.find((t) => t.lang === current!.captionLang && t.auto === current!.captionAuto) ?? pickTrack(tracks);
}

async function loadCaptions(): Promise<void> {
  const l = current;
  if (!l) return;
  const track = chosenTrack();
  $("caption-switch").hidden = l.captions.length < 2;
  if (!track) {
    $("caption-name").textContent = l.loaded ? "No captions for this video" : "";
    if (l.loaded) setSaying("This video has no captions, so his words can't be shown.");
    return;
  }
  const name = track.name || track.lang;
  $("caption-name").textContent = `Captions: ${name}${track.auto && !/auto/i.test(name) ? " (auto)" : ""}`;
  let got = cachedLines(l.videoId, track.lang, track.auto);
  if (!got) {
    try {
      const sep = track.url.includes("?") ? "&" : "?";
      const { text } = await lessonInfo.fetchText({ url: `${track.url}${sep}fmt=json3` });
      got = toLines(wordsFromJson3(text).words);
      if (got.length) cacheLines(l.videoId, track.lang, track.auto, got);
    } catch (err) {
      if (current === l) setSaying(`Couldn't load captions: ${(err as Error).message}`);
      return;
    }
  }
  if (current?.videoId !== l.videoId) return;
  lines = got;
  shownLine = shownWord = -2;
  renderTranscript();
  updateTab();
  if (!lines.length) setSaying("YouTube sent empty captions for this video.");
  else setSaying("");
}

function switchCaptions(): void {
  if (!current || current.captions.length < 2) return;
  const tracks = current.captions;
  const now = chosenTrack();
  const i = now ? tracks.indexOf(now) : -1;
  const next = tracks[(i + 1) % tracks.length];
  current = updateLesson(current.videoId, { captionLang: next.lang, captionAuto: next.auto }) ?? current;
  void loadCaptions();
}

function renderHead(): void {
  if (!current) return;
  $("lesson-title").textContent = current.title;
  $("lesson-uploader").textContent = current.uploader;
  $("lesson-duration").textContent = formatTime(current.durationSec || player?.duration() || 0);
  renderTicks();
}

function renderTicks(): void {
  const dur = current?.durationSec || player?.duration() || 0;
  const host = $("chapter-ticks");
  host.innerHTML = "";
  if (!current || !dur) return;
  for (const c of current.chapters) {
    if (c.startSec <= 0) continue;
    const i = document.createElement("i");
    i.style.left = `${((c.startSec / dur) * 100).toFixed(2)}%`;
    host.appendChild(i);
  }
}

function renderChapters(): void {
  const host = $("chapter-list");
  host.innerHTML = "";
  const chapters = current?.chapters ?? [];
  if (!chapters.length) {
    host.innerHTML = `<p class="muted pane-empty">${current?.loaded ? "This video has no chapters." : "Loading…"}</p>`;
    return;
  }
  chapters.forEach((c, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chapter";
    b.dataset.index = String(idx);
    b.innerHTML = `<span class="time">${formatTime(c.startSec)}</span><span>${escapeHtml(c.title)}</span>`;
    b.addEventListener("click", () => jump(c.startSec));
    host.appendChild(b);
  });
}

function renderTranscript(): void {
  const host = $("transcript");
  host.innerHTML = "";
  if (!lines.length) return;
  const frag = document.createDocumentFragment();
  lines.forEach((ln, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tline";
    b.dataset.index = String(idx);
    b.innerHTML = `<span class="time">${formatTime(ln.start)}</span><span>${escapeHtml(ln.text)}</span>`;
    b.addEventListener("click", () => jump(ln.start));
    frag.appendChild(b);
  });
  host.appendChild(frag);
}

function setSaying(text: string): void {
  const el = $("saying-text");
  el.className = "muted";
  el.textContent = text;
}

function renderSaying(t: number): void {
  if (!lines.length) return;
  const i = lineAt(lines, t);
  const ln = i >= 0 ? lines[i] : null;
  const live = ln && t <= ln.end;
  const w = live ? wordAt(ln, t) : -1;
  if (i === shownLine && w === shownWord) return;
  const el = $("saying-text");
  if (!ln || !live) {
    if (shownLine !== -1) {
      el.className = "muted";
      el.textContent = "…";
    }
    shownLine = -1;
    shownWord = -1;
  } else {
    el.className = "";
    el.innerHTML = ln.words.map((x, k) => `<span class="${k <= w ? "said" : ""}">${escapeHtml(x.w)}</span>`).join(" ");
    if (i !== shownLine) highlightTranscript(i);
    shownLine = i;
    shownWord = w;
  }
}

function highlightTranscript(i: number): void {
  const host = $("transcript");
  host.querySelector(".tline.now")?.classList.remove("now");
  const el = host.querySelector<HTMLElement>(`.tline[data-index="${i}"]`);
  if (!el) return;
  el.classList.add("now");
  // Follow along unless you're scrolling the transcript yourself.
  if (Date.now() - userScrolledAt > 4000 && !$("pane-transcript").hidden) {
    host.scrollTo({ top: el.offsetTop - host.offsetTop - host.clientHeight / 3, behavior: "smooth" });
  }
}

function highlightChapter(t: number): void {
  const chapters = current?.chapters ?? [];
  let idx = -1;
  chapters.forEach((c, k) => {
    if (c.startSec <= t) idx = k;
  });
  const host = $("chapter-list");
  const on = host.querySelector<HTMLElement>(".chapter.now");
  if (on?.dataset.index === String(idx)) return;
  on?.classList.remove("now");
  host.querySelector(`.chapter[data-index="${idx}"]`)?.classList.add("now");
}

function tick(): void {
  raf = requestAnimationFrame(tick);
  if (!player || !current || $("view-lesson").hidden) return;
  const t = player.time();
  const dur = current.durationSec || player.duration();
  if (!seeking && dur) {
    ($("lesson-seek") as HTMLInputElement).value = String(Math.round((t / dur) * 1000));
    $("lesson-time").textContent = formatTime(t);
  }
  if (!current.durationSec && dur) {
    $("lesson-duration").textContent = formatTime(dur);
    renderTicks();
  }
  renderSaying(t);
  stepTick(t);
  renderStrip(t);
  renderPicture(t);
  highlightChapter(t);
  if (playing && Date.now() - lastSaved > 5000) savePosition(t);
}

function startLoop(): void {
  if (!raf) raf = requestAnimationFrame(tick);
}

function stopLoop(): void {
  cancelAnimationFrame(raf);
  raf = 0;
}

function savePosition(t = player?.time() ?? 0): void {
  if (!current) return;
  lastSaved = Date.now();
  const dur = current.durationSec || player?.duration() || 0;
  // Finished? Start from the top next time.
  const pos = dur && t > dur - 5 ? 0 : t;
  current = updateLesson(current.videoId, { positionSec: pos }) ?? current;
}

function onPlayerState(state: number): void {
  playing = state === STATE.PLAYING || state === STATE.BUFFERING;
  $("lesson-play").classList.toggle("is-playing", playing);
  $("lesson-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  if (state === STATE.PLAYING) void keepAwake(true);
  if (state === STATE.PAUSED || state === STATE.ENDED) {
    savePosition();
    void keepAwake(false);
  }
  if (!current?.durationSec) renderHead();
}

async function keepAwake(on: boolean): Promise<void> {
  try {
    if (on && !wakeLock) {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      wakeLock = (await wl?.request("screen")) ?? null;
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

function jump(sec: number): void {
  player?.seek(sec);
  player?.play();
}

function togglePlay(): void {
  if (!player) return;
  stepCancelHold();
  if (playing) player.pause();
  else {
    followAgain();
    player.play();
  }
}

function renderSpeed(): void {
  $<HTMLSelectElement>("lesson-speed").value = String(speed);
}

function pausePlayer(): void {
  if (playing) player?.pause();
  savePosition();
}

function closePlayer(): void {
  savePosition();
  player?.destroy();
  player = null;
  playing = false;
  void keepAwake(false);
}

function closeLesson(fromCode = true): void {
  closePlayer();
  stopLoop();
  current = null;
  lines = [];
  clearTab();
  setStepMode(false);
  $("video-hold").hidden = true;
  $("lesson-step").setAttribute("aria-pressed", "false");
  setScreen(false);
  if (fromCode) removeStep("lesson");
  renderList();
}

export function initLessons(): void {
  renderList();
  initStrip();
  initScanUi(
    () => current?.videoId ?? null,
    (id) => {
      reloadFixes(id);
      renderScanButton();
    },
  );
  bus.on("remotechange", ({ kind, id }) => {
    if (kind === "fixes" && id) {
      reloadFixes(id);
      renderScanButton();
    }
    if (kind === "lesson") {
      if (!current) renderList();
      else if (current.videoId === id) current = getLesson(id) ?? current;
    }
  });
  $<HTMLFormElement>("add-lesson-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("lesson-link");
    void addFromText(input.value).then((ok) => {
      if (ok) input.value = "";
    });
  });
  $("lesson-back").addEventListener("click", () => closeLesson());
  $("lesson-play").addEventListener("click", togglePlay);
  $("lesson-step").addEventListener("click", () => {
    const on = !stepMode();
    setStepMode(on);
    $("lesson-step").setAttribute("aria-pressed", String(on));
    bus.emit("toast", on ? "Note by note: it waits 2 seconds on each note, then plays it" : "Note by note off");
  });
  $("lesson-back5").addEventListener("click", () => player?.seek(player.time() - 5));
  $("lesson-fwd5").addEventListener("click", () => player?.seek(player.time() + 5));
  $<HTMLSelectElement>("lesson-speed").addEventListener("change", (e) => {
    speed = Number((e.target as HTMLSelectElement).value) || 1;
    player?.setRate(speed);
  });
  const seek = $<HTMLInputElement>("lesson-seek");
  seek.addEventListener("input", () => {
    seeking = true;
    const dur = current?.durationSec || player?.duration() || 0;
    $("lesson-time").textContent = formatTime((Number(seek.value) / 1000) * dur);
  });
  seek.addEventListener("change", () => {
    const dur = current?.durationSec || player?.duration() || 0;
    player?.seek((Number(seek.value) / 1000) * dur);
    seeking = false;
  });
  $("caption-switch").addEventListener("click", switchCaptions);
  document.querySelectorAll<HTMLElement>(".lesson-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      const pane = b.dataset.pane!;
      document.querySelectorAll<HTMLElement>(".lesson-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("pane-transcript").hidden = pane !== "transcript";
      $("pane-chapters").hidden = pane !== "chapters";
    }),
  );
  const tr = $("transcript");
  for (const ev of ["touchstart", "wheel"]) tr.addEventListener(ev, () => (userScrolledAt = Date.now()), { passive: true });

  // Leaving the Lessons section pauses the video; coming back shows it again.
  bus.on("viewchange", (v) => {
    if (v !== "lessons") {
      pausePlayer();
      $("view-lesson").hidden = true;
      document.documentElement.classList.remove("in-lesson");
    } else if (current) {
      setScreen(true);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") savePosition();
  });

  // "Share → Fretline" from YouTube (see MainActivity).
  (window as Window & { fretlineShare?: (text: string) => void }).fretlineShare = (text: string) => {
    void addFromText(text).then((ok) => {
      if (!ok) bus.emit("toast", "That share wasn't a YouTube link");
    });
  };
}
