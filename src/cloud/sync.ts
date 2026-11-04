// Keeps lessons, tab fixes and tuner settings in your account, so they
// survive a reinstall and show up on another phone. Everything works on
// the phone first; changes upload a few seconds later (or once back online).
//
// The account side is supabase/001_fretline.sql. Until that has been run,
// the app keeps everything on the phone and says sync needs setting up.
import { bus, type SyncStatus } from "../state";
import { storage } from "../utils";
import { fixedLessons, getFixes, mergeRemoteFixes } from "../tabs/fixes";
import type { Fixes } from "../tabs/tab";
import { getLesson, lessons, mergeRemoteLesson, removedLessons, type Lesson } from "../lessons/store";
import { mergeRemoteSettings, settingsData, type SettingsData } from "../tuner/tunings";
import { supabase } from "./client";
import { getAccount } from "./session";

const DIRTY = "fretline:sync-dirty";
const DELAY_MS = 4000;

interface Dirty {
  lessons: string[];
  fixes: string[];
  settings: boolean;
}

let status: SyncStatus = "off";
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
let lastPull = 0;

export function syncStatus(): SyncStatus {
  return status;
}

function setStatus(s: SyncStatus): void {
  if (s === status) return;
  status = s;
  bus.emit("syncstatus", s);
}

function dirty(): Dirty {
  const d = storage.get<Dirty>(DIRTY, { lessons: [], fixes: [], settings: false });
  return { lessons: d.lessons ?? [], fixes: d.fixes ?? [], settings: !!d.settings };
}

function markDirty(kind: "lesson" | "fixes" | "settings", id?: string): void {
  const d = dirty();
  if (kind === "lesson" && id && !d.lessons.includes(id)) d.lessons.push(id);
  if (kind === "fixes" && id && !d.fixes.includes(id)) d.fixes.push(id);
  if (kind === "settings") d.settings = true;
  storage.set(DIRTY, d);
}

const iso = (ms: number | undefined) => new Date(ms || Date.now()).toISOString();
const ms = (t: string | null | undefined) => (t ? Date.parse(t) : 0);

/** Errors meaning the tables aren't there yet (the SQL wasn't run). */
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return !!err && (err.code === "PGRST205" || err.code === "42P01" || /does not exist|schema cache/i.test(err.message ?? ""));
}

function lessonRow(l: Lesson) {
  return {
    video_id: l.videoId,
    title: l.title,
    uploader: l.uploader,
    duration_sec: Math.round(l.durationSec || 0),
    thumbnail: l.thumbnail,
    chapters: l.chapters,
    position_sec: l.positionSec,
    added_at: iso(l.addedAt),
    opened_at: iso(l.openedAt),
    deleted: false,
    updated_at: iso(l.updatedAt),
  };
}

/** Upload what changed on the phone. */
async function push(): Promise<void> {
  const d = dirty();
  if (!d.lessons.length && !d.fixes.length && !d.settings) return;
  const gone = removedLessons();

  if (d.lessons.length) {
    const rows = d.lessons
      .map((id) => {
        const l = getLesson(id);
        if (l) return lessonRow(l);
        if (gone[id]) return { video_id: id, deleted: true, updated_at: iso(gone[id]) };
        return null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) {
      const { error } = await supabase.from("fretline_lessons").upsert(rows, { onConflict: "user_id,video_id" });
      if (error) throw error;
    }
  }
  if (d.fixes.length) {
    const rows = d.fixes.map((id) => {
      const f = getFixes(id);
      return { video_id: id, fixes: f, updated_at: iso(f.updatedAt) };
    });
    const { error } = await supabase.from("fretline_tab_fixes").upsert(rows, { onConflict: "user_id,video_id" });
    if (error) throw error;
  }
  if (d.settings) {
    const { updatedAt, ...data } = settingsData();
    const { error } = await supabase.from("fretline_settings").upsert({ data, updated_at: iso(updatedAt) }, { onConflict: "user_id" });
    if (error) throw error;
  }
  // Only clear what we sent; anything changed meanwhile stays queued.
  const now = dirty();
  storage.set(DIRTY, {
    lessons: now.lessons.filter((id) => !d.lessons.includes(id)),
    fixes: now.fixes.filter((id) => !d.fixes.includes(id)),
    settings: now.settings && !d.settings,
  });
}

/** Bring in what changed elsewhere (newer wins). */
async function pull(): Promise<void> {
  const d = dirty();
  const [ls, fx, st] = await Promise.all([
    supabase.from("fretline_lessons").select("*"),
    supabase.from("fretline_tab_fixes").select("*"),
    supabase.from("fretline_settings").select("*").maybeSingle(),
  ]);
  for (const r of [ls, fx, st]) if (r.error) throw r.error;

  for (const row of (ls.data ?? []) as Record<string, unknown>[]) {
    const id = String(row.video_id);
    if (d.lessons.includes(id)) continue; // ours is newer and on its way up
    const changed = mergeRemoteLesson(
      {
        videoId: id,
        title: String(row.title ?? ""),
        uploader: String(row.uploader ?? ""),
        durationSec: Number(row.duration_sec ?? 0),
        thumbnail: (row.thumbnail as string | null) ?? null,
        chapters: Array.isArray(row.chapters) ? (row.chapters as Lesson["chapters"]) : [],
        positionSec: Number(row.position_sec ?? 0),
        addedAt: ms(row.added_at as string),
        openedAt: ms(row.opened_at as string),
        updatedAt: ms(row.updated_at as string),
      },
      Boolean(row.deleted),
    );
    if (changed) bus.emit("remotechange", { kind: "lesson", id });
  }
  for (const row of (fx.data ?? []) as { video_id: string; fixes: Fixes; updated_at: string }[]) {
    if (d.fixes.includes(row.video_id) || !row.fixes || typeof row.fixes !== "object") continue;
    const remote = { edits: row.fixes.edits ?? {}, added: row.fixes.added ?? [], screen: row.fixes.screen, updatedAt: ms(row.updated_at) };
    if (mergeRemoteFixes(row.video_id, remote)) bus.emit("remotechange", { kind: "fixes", id: row.video_id });
  }
  const s = st.data as { data: Partial<SettingsData>; updated_at: string } | null;
  if (s && !d.settings && mergeRemoteSettings(s.data ?? {}, ms(s.updated_at))) bus.emit("remotechange", { kind: "settings" });
  lastPull = Date.now();
}

/** Push then pull, one run at a time. */
export function syncNow(withPull = true): Promise<void> {
  if (!getAccount() || status === "setup-needed") return Promise.resolve();
  if (running) return running;
  running = (async () => {
    setStatus("syncing");
    try {
      await push();
      if (withPull) await pull();
      setStatus("ok");
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (isMissingTable(e)) setStatus("setup-needed");
      else if (!navigator.onLine || /fetch|network/i.test(e.message ?? "")) setStatus("offline");
      else {
        console.warn("sync", err);
        setStatus("error");
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(Date.now() - lastPull > 60_000), DELAY_MS);
}

export function initSync(): void {
  bus.on("localchange", ({ kind, id }) => {
    if (!getAccount()) return;
    markDirty(kind, id);
    schedule();
  });
  bus.on("authchange", (account) => {
    if (!account) {
      setStatus("off");
      return;
    }
    // First sync for this phone: everything here goes up once.
    if (!storage.get<boolean>(`fretline:synced-once:${account.id}`, false)) {
      for (const l of lessons()) markDirty("lesson", l.videoId);
      for (const id of fixedLessons()) markDirty("fixes", id);
      if (settingsData().updatedAt) markDirty("settings");
      storage.set(`fretline:synced-once:${account.id}`, true);
    }
    void syncNow();
  });
  window.addEventListener("online", () => void syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastPull > 60_000) void syncNow();
    if (document.visibilityState === "hidden") void syncNow(false);
  });
}
