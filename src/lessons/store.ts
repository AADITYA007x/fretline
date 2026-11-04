// Saved lessons, on this phone (they'll sync to the account with the tab
// library). Captions are cached so a lesson opens instantly the second time.
import { storage } from "../utils";
import type { CaptionTrack, Line } from "./captions";

export interface Chapter {
  title: string;
  startSec: number;
}

export interface Lesson {
  videoId: string;
  title: string;
  uploader: string;
  durationSec: number;
  thumbnail: string | null;
  chapters: Chapter[];
  captions: CaptionTrack[];
  /** Language tag of the caption track being shown. */
  captionLang: string | null;
  captionAuto: boolean;
  addedAt: number;
  openedAt: number;
  /** Where you left off. */
  positionSec: number;
  /** Details from YouTube arrived (false = only the id so far). */
  loaded: boolean;
}

const KEY = "fretline:lessons";
const CAPTIONS = (id: string, lang: string, auto: boolean) => `fretline:captions:${id}:${lang}:${auto ? "a" : "m"}`;

export function lessons(): Lesson[] {
  return storage
    .get<Lesson[]>(KEY, [])
    .filter((l) => l && typeof l.videoId === "string")
    .sort((a, b) => b.openedAt - a.openedAt);
}

export function getLesson(videoId: string): Lesson | undefined {
  return lessons().find((l) => l.videoId === videoId);
}

export function saveLesson(lesson: Lesson): void {
  const list = lessons().filter((l) => l.videoId !== lesson.videoId);
  list.push(lesson);
  storage.set(KEY, list);
}

export function updateLesson(videoId: string, patch: Partial<Lesson>): Lesson | undefined {
  const l = getLesson(videoId);
  if (!l) return undefined;
  const next = { ...l, ...patch };
  saveLesson(next);
  return next;
}

export function newLesson(videoId: string): Lesson {
  const now = Date.now();
  return {
    videoId,
    title: "Loading lesson…",
    uploader: "",
    durationSec: 0,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    chapters: [],
    captions: [],
    captionLang: null,
    captionAuto: false,
    addedAt: now,
    openedAt: now,
    positionSec: 0,
    loaded: false,
  };
}

export function removeLesson(videoId: string): void {
  const l = getLesson(videoId);
  storage.set(
    KEY,
    lessons().filter((x) => x.videoId !== videoId),
  );
  for (const c of l?.captions ?? []) storage.remove(CAPTIONS(videoId, c.lang, c.auto));
}

export function cachedLines(videoId: string, lang: string, auto: boolean): Line[] | null {
  return storage.get<Line[] | null>(CAPTIONS(videoId, lang, auto), null);
}

export function cacheLines(videoId: string, lang: string, auto: boolean, lines: Line[]): void {
  storage.set(CAPTIONS(videoId, lang, auto), lines);
}
