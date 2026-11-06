// Reading the tab shown in a lesson video, start to finish:
// download (picture only) → find the tab → look through the whole video →
// read each tab page → timed notes → delete the video.
import type { TabNote } from "../tabs/tab";
import { tabScan, type ScanProgress } from "./native";
import { chordBand, chordsFromChars, notesFromArea } from "./glyphs";
import type { Model } from "./digits";
import { analyzeSound, syncNotes, type SyncReport } from "./onsets";
import {
  bytes,
  columns,
  commonStaff,
  findPages,
  findStaff,
  changedCells,
  cursorX,
  thumbOf,
  THUMB_H,
  THUMB_W,
  isScrolling,
  playedHere,
  mergeReadings,
  staffRect,
  timeColumns,
  type FrameFeatures,
  type OcrChar,
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
  /** Chord names written above the tab, at the note under each. */
  chords?: { t: number; name: string }[];
  /** Why there's nothing, when there's nothing. */
  none?: string;
}

export type Step = { phase: "download" | "look" | "read" | "sound"; fraction: number; detail?: string };

let running: string | null = null;

export function scanning(): string | null {
  return running;
}

export async function stopScan(videoId: string): Promise<void> {
  await tabScan.cancel({ videoId }).catch(() => {});
}

/**
 * Download the sound, find when each note is really plucked, and move the
 * notes there (in place). Any trouble: the notes keep the cursor's times.
 */
async function syncWithSound(
  videoId: string,
  notes: TabNote[],
  pages: { start: number; end: number }[],
  onStep: (s: Step) => void,
  subs: { remove(): Promise<void> }[],
): Promise<SyncReport | { error: string }> {
  if (notes.length < 8) return { error: "too few notes" };
  try {
    onStep({ phase: "sound", fraction: 0 });
    const RATE = 8000;
    const parts: { start: number; pcm: Int16Array }[] = [];
    subs.push(
      await tabScan.addListener("audio", (b) => {
        if (b.videoId !== videoId) return;
        const raw = bytes(b.pcm);
        parts.push({ start: b.start, pcm: new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1) });
      }),
    );
    const { samples } = await tabScan.audio({ videoId, rate: RATE });
    await new Promise((r) => setTimeout(r, 300)); // events can trail the call
    const pcm = new Float32Array(samples);
    for (const p of parts) for (let i = 0; i < p.pcm.length && p.start + i < samples; i++) pcm[p.start + i] = p.pcm[i] / 32768;
    onStep({ phase: "sound", fraction: 0.5, detail: "lining the notes up" });
    await new Promise((r) => setTimeout(r, 30)); // let the progress show
    const { times, report } = syncNotes(notes, pages, analyzeSound(pcm, RATE));
    notes.forEach((n, i) => (n.t = times[i]));
    return report;
  } catch (err) {
    return { error: (err as Error).message ?? String(err) };
  }
}

/** The measured frame closest to t. */
function nearestFrame(frames: FrameFeatures[], t: number): FrameFeatures | undefined {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[lo - 1];
  if (!a) return b;
  return b && Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a;
}

/** Chord names most readings of a page agree on (same name, about the same place). */
function mergeChords(readings: { x: number; name: string }[][], tol: number): { x: number; name: string }[] {
  const used = readings.filter((r) => r.length);
  if (!used.length) return [];
  const need = used.length >= 3 ? Math.ceil(used.length / 2) : used.length;
  const groups: { x: number; name: string; n: number }[] = [];
  for (const r of used)
    for (const c of r) {
      const g = groups.find((q) => q.name === c.name && Math.abs(q.x - c.x) <= tol);
      if (g) g.n++;
      else groups.push({ ...c, n: 1 });
    }
  return groups.filter((g) => g.n >= need).map(({ x, name }) => ({ x, name }));
}

/** Bytes to base64 (for sending a picture to the phone side). */
function b64(a: Uint8Array): string {
  let s = "";
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bump when the reader gets better, so lessons read before can be read again. */
export const SCAN_VERSION = 15;

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

    // Every page is read (pages that look alike in the small thumbnail can
    // still differ in a digit: a 0 where the other has a 2).
    const unique: Page[] = pages;
    const sameAs = pages.map((_, k) => k);
    // What the reader saw, kept for checking (Send reading details).
    const report = {
      version: SCAN_VERSION,
      video: { width: ov.width, height: ov.height },
      rect,
      lines,
      pages: pages.map((p, k) => ({ start: p.start, end: p.end, same: sameAs[k], cursor: p.cursor })),
      scrolling: isScrolling(pages),
      readings: [] as { t: number; image?: string; chars: unknown[]; notes?: ScreenNote[]; wrongFrame?: boolean }[],
      merged: [] as ScreenNote[][],
    };
    // Our own digit reader (loaded only when reading).
    const model = (await import("./digits-model.json")).default as unknown as Model;
    // Each page is read at five moments and the readings compared. The
    // digits are found here and read by the phone laid out in a neat row.
    const SPOTS = [0.2, 0.35, 0.5, 0.65, 0.8];
    const sp = staff.spacing * scale;
    const above = Math.min(rect.y, Math.round(sp * 3));
    const readRect = { x: rect.x, y: rect.y - above, w: rect.w, h: rect.h + above };
    const tol = staff.spacing * scale * 0.6;
    const read: { notes: ScreenNote[]; image: string; chords: { x: number; name: string }[] }[] = [];
    for (let i = 0; i < unique.length; i += 4) {
      const batch = unique.slice(i, i + 4);
      onStep({ phase: "read", fraction: i / unique.length, detail: `${i} of ${unique.length} tab pages` });
      const times = batch.flatMap((p) => SPOTS.map((f) => p.start + f * (p.end - p.start)));
      // Exact frames (decoded one by one); the quick grabber only if that fails.
      // (taller than the tab, to take in the chord names written above it)
      const { results } = await tabScan.areasExact({ videoId, rect: readRect, times }).catch(() => tabScan.areas({ videoId, rect: readRect, times }));
      const found = new Map<number, ScreenNote[]>();
      const foundChords = new Map<number, { x: number; name: string }[]>();
      for (const r of results) {
        const seen: unknown[] = [];
        // Is this really the page shown at that moment? (compare with what
        // the look through the video saw then)
        // The tab itself, and the band above it.
        const full = bytes(r.gray);
        const top = rect.y - r.y;
        const tabH = Math.min(rect.h, r.h - top);
        const gray = top >= 0 && tabH > 0 ? full.slice(top * r.w, (top + tabH) * r.w) : full;
        const at = nearestFrame(frames, r.t);
        if (at && at.m.length === THUMB_W * THUMB_H && r.w === rect.w && tabH === rect.h) {
          const cur = cursorX(at.u, at.v);
          if (changedCells(thumbOf(gray, r.w, tabH), at.m, [cur, cur]) >= 3) {
            report.readings.push({ t: r.t, image: r.image?.split("/").pop(), chars: [], notes: [], wrongFrame: true });
            continue;
          }
        }
        // A frame that came back black (it happens near the start) is no reading.
        let sum = 0;
        for (let i = 0; i < gray.length; i += 7) sum += gray[i];
        if (sum / Math.ceil(gray.length / 7) < 40) {
          report.readings.push({ t: r.t, image: r.image?.split("/").pop(), chars: [], notes: [] });
          continue;
        }
        const notes = await notesFromArea(
          { gray, w: r.w, h: tabH, x: r.x, y: rect.y },
          lines,
          async (lay) => {
            const { chars } = await tabScan.read({ gray: b64(lay.gray), w: lay.w, h: lay.h });
            seen.push(...chars);
            return chars;
          },
          model,
        );
        found.set(r.t, notes);
        // chord names written above the tab
        const area = { gray: full, w: r.w, h: r.h, x: r.x, y: r.y };
        const band = chordBand(area, lines);
        if (band) {
          const { chars } = await tabScan.read({ gray: b64(band.gray), w: band.w, h: band.h }).catch(() => ({ chars: [] as OcrChar[] }));
          foundChords.set(r.t, chordsFromChars(chars, area));
        }
        report.readings.push({ t: r.t, image: r.image?.split("/").pop(), chars: seen, notes });
      }
      batch.forEach((_, k) => {
        const mine = times.slice(k * SPOTS.length, (k + 1) * SPOTS.length).map((t) => results.find((r) => Math.abs(r.t - t) < 0.001));
        const notes = mergeReadings(
          mine.map((r) => (r ? (found.get(r.t) ?? []) : [])),
          tol,
        );
        read.push({ notes, image: (mine[2] ?? mine.find(Boolean))?.image ?? "", chords: mergeChords(mine.map((r) => (r ? (foundChords.get(r.t) ?? []) : [])), tol * 2) });
        report.merged.push(notes);
      });
    }

    // Notes, timed by the cursor on each showing of each page.
    const notes: TabNote[] = [];
    const chordAt: { note: TabNote; name: string }[] = [];
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
            ...(n.unsure ? { unsure: true } : {}),
            source: "screen",
          });
        }
      });
      // each chord name goes with the first note under or after it
      for (const ch of r.chords) {
        const ci = cols.findIndex((col, i) => here[i] && col[0].x >= ch.x - staff.spacing * scale * 0.6);
        if (ci < 0) continue;
        const first = notes.find((n) => n.t === times[ci].t && n.string === cols[ci][0].string);
        if (first) chordAt.push({ note: first, name: ch.name });
      }
      out.push({ start: p.start, end: p.end, image: r.image || undefined, notes: cols.length });
    });
    // Line the notes up with the plucks in the video's sound.
    (report as Record<string, unknown>).sync = await syncWithSound(videoId, notes, out, onStep, subs);
    // (after the lining up, so chord names move with their notes)
    const chords = chordAt.map((c) => ({ t: c.note.t, name: c.name })).filter((c, i, all) => i === 0 || c.name !== all[i - 1].name || c.t - all[i - 1].t > 1);
    (report as Record<string, unknown>).chords = chords;
    await tabScan.saveReport({ videoId, json: JSON.stringify(report) }).catch(() => {});
    return { notes, pages: out, chords };
  } finally {
    for (const s of subs) await s.remove().catch(() => {});
    await tabScan.deleteVideo({ videoId }).catch(() => {});
    running = null;
  }
}
