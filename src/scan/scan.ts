// Reading the tab shown in a lesson video, start to finish:
// download (picture only) → find the tab → look through the whole video →
// read each tab page → timed notes → delete the video.
import type { TabNote } from "../tabs/tab";
import { tabScan, type ScanProgress } from "./native";
import { notesFromArea } from "./glyphs";
import {
  bytes,
  changedCells,
  columns,
  commonStaff,
  findPages,
  findStaff,
  isScrolling,
  playedHere,
  mergeReadings,
  staffRect,
  timeColumns,
  type FrameFeatures,
  type Page,
  type ScreenNote,
} from "./vision";

export interface ScanPage {
  start: number;
  end: number;
  /** Picture of the tab on this page (on the phone). */
  image?: string;
  notes: number;
}

export interface ScanResult {
  notes: TabNote[];
  pages: ScanPage[];
  /** Why there's nothing, when there's nothing. */
  none?: string;
}

export type Step = { phase: "download" | "look" | "read"; fraction: number; detail?: string };

let running: string | null = null;

export function scanning(): string | null {
  return running;
}

export async function stopScan(videoId: string): Promise<void> {
  await tabScan.cancel({ videoId }).catch(() => {});
}

/** Bytes to base64 (for sending a picture to the phone side). */
function b64(a: Uint8Array): string {
  let s = "";
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Pages with the same picture are read once. */
function similar(a: Uint8Array, b: Uint8Array): boolean {
  return changedCells(a, b) < 3;
}

/** Bump when the reader gets better, so lessons read before can be read again. */
export const SCAN_VERSION = 9;

export async function scanLesson(videoId: string, onStep: (s: Step) => void, maxHeight = 720): Promise<ScanResult> {
  if (running) throw new Error("Already reading another lesson's video.");
  running = videoId;
  const subs: { remove(): Promise<void> }[] = [];
  try {
    subs.push(
      await tabScan.addListener("progress", (p: ScanProgress) => {
        if (p.videoId !== videoId) return;
        const fraction = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
        const detail = p.phase === "download" && p.total > 0 ? `${Math.round(p.done / 1e6)} of ${Math.round(p.total / 1e6)} MB` : undefined;
        onStep({ phase: p.phase, fraction, detail });
      }),
    );

    onStep({ phase: "download", fraction: 0 });
    await tabScan.download({ videoId, maxHeight });

    // Where's the tab? Look at a spread of frames.
    const look = async () => {
      let ov = await tabScan.overview({ videoId, count: 16, width: 640 });
      let staff = ov.frames.length ? commonStaff(ov.frames.map((f) => findStaff(bytes(f.gray), f.w, f.h))) : null;
      // In a big (1080p) video, thin tab lines can fade out when shrunk that
      // far: look again at half size.
      if (!staff && ov.width > 1300) {
        ov = await tabScan.overview({ videoId, count: 16, width: Math.round(ov.width / 2) });
        staff = ov.frames.length ? commonStaff(ov.frames.map((f) => findStaff(bytes(f.gray), f.w, f.h))) : null;
      }
      return { ov, staff };
    };
    let { ov, staff } = await look();
    // Still nothing in the big picture (or the phone couldn't open it):
    // try the 720p one before giving up.
    if (!staff && maxHeight > 720) {
      await tabScan.deleteVideo({ videoId });
      onStep({ phase: "download", fraction: 0, detail: "trying the smaller video" });
      await tabScan.download({ videoId, maxHeight: 720 });
      ({ ov, staff } = await look());
    }
    if (!staff) {
      const none = ov.frames.length ? "No tab shown on screen in this video." : "Couldn't open the downloaded video on this phone.";
      return { notes: [], pages: [], none };
    }
    const scale = ov.width / ov.frames[0].w;
    const rect = staffRect(staff, scale, ov.width, ov.height);
    const lines = staff.lines.map((y) => y * scale);

    // One pass through the video: pages and the cursor.
    const frames: FrameFeatures[] = [];
    subs.push(
      await tabScan.addListener("features", (b) => {
        if (b.videoId !== videoId) return;
        for (const f of b.frames) frames.push({ t: f.t, y: bytes(f.y), u: bytes(f.u), v: f.v ? bytes(f.v) : undefined, m: bytes(f.m) });
      }),
    );
    onStep({ phase: "look", fraction: 0 });
    await tabScan.features({ videoId, rect, fps: 4, cols: 480 });
    // Events can trail the call's end by a moment.
    await new Promise((r) => setTimeout(r, 300));
    frames.sort((a, b) => a.t - b.t);
    const pages = findPages(frames);
    if (!pages.length) return { notes: [], pages: [], none: "The tab area never stayed still long enough to read." };

    // Read each different page once.
    const unique: Page[] = [];
    const sameAs = pages.map((p) => {
      const i = unique.findIndex((u) => similar(u.thumb, p.thumb));
      if (i >= 0) return i;
      unique.push(p);
      return unique.length - 1;
    });
    // What the reader saw, kept for checking (Send reading details).
    const report = {
      version: SCAN_VERSION,
      video: { width: ov.width, height: ov.height },
      rect,
      lines,
      pages: pages.map((p, k) => ({ start: p.start, end: p.end, same: sameAs[k], cursor: p.cursor })),
      scrolling: isScrolling(pages),
      readings: [] as { t: number; image?: string; chars: unknown[]; notes?: ScreenNote[] }[],
      merged: [] as ScreenNote[][],
    };
    // Each page is read at three moments and the readings compared. The
    // digits are found here and read by the phone laid out in a neat row.
    const SPOTS = [0.3, 0.5, 0.72];
    const tol = staff.spacing * scale * 0.6;
    const read: { notes: ScreenNote[]; image: string }[] = [];
    for (let i = 0; i < unique.length; i += 4) {
      const batch = unique.slice(i, i + 4);
      onStep({ phase: "read", fraction: i / unique.length, detail: `${i} of ${unique.length} tab pages` });
      const times = batch.flatMap((p) => SPOTS.map((f) => p.start + f * (p.end - p.start)));
      const { results } = await tabScan.areas({ videoId, rect, times });
      const found = new Map<number, ScreenNote[]>();
      for (const r of results) {
        const seen: unknown[] = [];
        const gray = bytes(r.gray);
        // A frame that came back black (it happens near the start) is no reading.
        let sum = 0;
        for (let i = 0; i < gray.length; i += 7) sum += gray[i];
        if (sum / Math.ceil(gray.length / 7) < 40) {
          report.readings.push({ t: r.t, image: r.image?.split("/").pop(), chars: [], notes: [] });
          continue;
        }
        const notes = await notesFromArea({ gray, w: r.w, h: r.h, x: r.x, y: r.y }, lines, async (lay) => {
          const { chars } = await tabScan.read({ gray: b64(lay.gray), w: lay.w, h: lay.h });
          seen.push(...chars);
          return chars;
        });
        found.set(r.t, notes);
        report.readings.push({ t: r.t, image: r.image?.split("/").pop(), chars: seen, notes });
      }
      batch.forEach((_, k) => {
        const mine = times.slice(k * 3, k * 3 + 3).map((t) => results.find((r) => Math.abs(r.t - t) < 0.001));
        const notes = mergeReadings(
          mine.map((r) => (r ? (found.get(r.t) ?? []) : [])),
          tol,
        );
        read.push({ notes, image: (mine[1] ?? mine.find(Boolean))?.image ?? "" });
        report.merged.push(notes);
      });
    }

    // Notes, timed by the cursor on each showing of each page.
    const notes: TabNote[] = [];
    const out: ScanPage[] = [];
    const scrolling = isScrolling(pages);
    pages.forEach((p, k) => {
      const r = read[sameAs[k]];
      if (!r) return;
      const cols = columns(r.notes, staff.spacing * scale);
      const times = timeColumns(cols, p, rect);
      const here = playedHere(cols, pages, k, rect, scrolling);
      cols.forEach((col, ci) => {
        if (!here[ci]) return;
        for (const n of col) {
          notes.push({
            id: `v${Math.round(times[ci].t * 10)}-${n.string}`,
            t: times[ci].t,
            string: n.string,
            fret: n.fret,
            chord: col.length > 1 ? 100000 + Math.round(times[ci].t * 10) : undefined,
            ...(n.tech ? { tech: n.tech } : {}),
            ...(n.strum ? { strum: n.strum } : {}),
            source: "screen",
          });
        }
      });
      out.push({ start: p.start, end: p.end, image: r.image || undefined, notes: cols.length });
    });
    await tabScan.saveReport({ videoId, json: JSON.stringify(report) }).catch(() => {});
    return { notes, pages: out };
  } finally {
    for (const s of subs) await s.remove().catch(() => {});
    await tabScan.deleteVideo({ videoId }).catch(() => {});
    running = null;
  }
}
