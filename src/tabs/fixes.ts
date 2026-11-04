// Your tab fixes per lesson, on the phone; synced to the account.
import { bus } from "../state";
import { storage } from "../utils";
import { emptyFixes, type Fixes } from "./tab";

const KEY = (videoId: string) => `fretline:fixes:${videoId}`;
const INDEX = "fretline:fixes-index";

export function getFixes(videoId: string): Fixes {
  const f = storage.get<Fixes | null>(KEY(videoId), null);
  return f && typeof f === "object" && f.edits && Array.isArray(f.added) ? f : emptyFixes();
}

export function saveFixes(videoId: string, fixes: Fixes): void {
  storage.set(KEY(videoId), { ...fixes, updatedAt: Date.now() });
  const index = new Set(storage.get<string[]>(INDEX, []));
  index.add(videoId);
  storage.set(INDEX, [...index]);
  bus.emit("localchange", { kind: "fixes", id: videoId });
}

/** Lessons that have fixes on this phone. */
export function fixedLessons(): string[] {
  return storage.get<string[]>(INDEX, []);
}

/** Keep what was read from the video (part of the lesson's saved tab). */
export function saveScreenTab(videoId: string, screen: import("./tab").ScreenTab): void {
  saveFixes(videoId, { ...getFixes(videoId), screen });
}

/** Fixes from the account: take them when newer than ours. */
export function mergeRemoteFixes(videoId: string, remote: Fixes): boolean {
  const local = getFixes(videoId);
  if (local.updatedAt >= remote.updatedAt) return false;
  storage.set(KEY(videoId), remote);
  const index = new Set(storage.get<string[]>(INDEX, []));
  index.add(videoId);
  storage.set(INDEX, [...index]);
  return true;
}
