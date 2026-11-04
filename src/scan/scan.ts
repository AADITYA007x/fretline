// Reading the tab shown in a lesson video, start to finish:
// download (picture only) → find the tab → look through the whole video →
// read each tab page → timed notes → delete the video.
import type { TabNote } from "../tabs/tab";
import { tabScan, type ScanProgress } from "./native";
import {
  bytes,
  changedCells,
  charsToNotes,
  columns,
  commonStaff,
  findPages,
  findStaff,
  staffRect,
  timeColumns,
  type FrameFeatures,
  type Page,
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

/**
 * How much to enlarge the tab before reading it: small digits (thin
 * staff spacing) need more, to about 30 px a line, but not past ~4000 px wide.
 */
export function ocrScale(spacingPx: number, width: number): number {
  const want = Math.min(4, Math.max(2, 30 / Math.max(1, spacingPx)));
  return Math.max(1, Math.min(want, 4000 / Math.max(1, width)));
}

/** Pages with the same picture are read once. */
function similar(a: Uint8Array, b: Uint8Array): boolean {
  return changedCells(a, b) < 3;
}

/** Bump when the reader gets better, so lessons read before can be read again. */
export const SCAN_VERSION = 2;

export async function scanLesson(videoId: string, onStep: (s: Step) => void, maxHeight = 1080): Promise<ScanResult> {
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
    const read: { chars: Parameters<typeof charsToNotes>[0]; image: string }[] = [];
    for (let i = 0; i < unique.length; i += 8) {
      const batch = unique.slice(i, i + 8);
      onStep({ phase: "read", fraction: i / unique.length, detail: `${i} of ${unique.length} tab pages` });
      const { results } = await tabScan.ocr({ videoId, rect, lines, times: batch.map((p) => p.readAt), scale: ocrScale(staff.spacing * scale, rect.w) });
      for (const r of results) read.push({ chars: r.chars, image: r.image });
    }

    // Notes, timed by the cursor on each showing of each page.
    const notes: TabNote[] = [];
    const out: ScanPage[] = [];
    pages.forEach((p, k) => {
      const r = read[sameAs[k]];
      if (!r) return;
      const cols = columns(charsToNotes(r.chars, lines), staff.spacing * scale);
      const times = timeColumns(cols, p, rect);
      cols.forEach((col, ci) => {
        for (const n of col) {
          notes.push({
            id: `v${Math.round(times[ci].t * 10)}-${n.string}`,
            t: times[ci].t,
            string: n.string,
            fret: n.fret,
            chord: col.length > 1 ? 100000 + Math.round(times[ci].t * 10) : undefined,
            source: "screen",
          });
        }
      });
      out.push({ start: p.start, end: p.end, image: r.image, notes: cols.length });
    });
    return { notes, pages: out };
  } finally {
    for (const s of subs) await s.remove().catch(() => {});
    await tabScan.deleteVideo({ videoId }).catch(() => {});
    running = null;
  }
}
