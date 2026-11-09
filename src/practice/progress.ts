// Your practice, per lesson: lines ticked, the best speed reached on each
// line, minutes practised a day. Kept with the lesson's tab, so it's synced
// to your account with it.
import { storage } from "../utils";
import { getFixes, saveProgress } from "../tabs/fixes";
import type { Progress } from "../tabs/tab";

const OLD_DONE = (id: string) => `fretline:notebook-done:${id}`;

export function today(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getProgress(videoId: string): Progress {
  const p = getFixes(videoId).progress;
  if (p && Array.isArray(p.done)) return { done: p.done, best: p.best ?? {}, days: p.days ?? {}, last: p.last };
  // lines ticked before progress was kept with the lesson
  const old = storage.get<number[]>(OLD_DONE(videoId), []);
  return { done: Array.isArray(old) ? old.filter((x) => typeof x === "number") : [], best: {}, days: {} };
}

function update(videoId: string, fn: (p: Progress) => void): Progress {
  const p = getProgress(videoId);
  fn(p);
  saveProgress(videoId, p);
  return p;
}

export function setLineDone(videoId: string, line: number, done: boolean): number[] {
  return update(videoId, (p) => {
    const set = new Set(p.done);
    if (done) set.add(line);
    else set.delete(line);
    p.done = [...set].sort((a, b) => a - b);
  }).done;
}

/** A round finished at `speed` (0 = 1 by 1) on these lines. */
export function recordRound(videoId: string, lines: number[], speed: number): void {
  update(videoId, (p) => {
    for (const n of lines) if ((p.best[n] ?? -1) < speed) p.best[n] = speed;
    p.last = { line: lines[0], at: Date.now() };
  });
}

export function addSeconds(videoId: string, seconds: number): void {
  if (seconds < 1) return;
  update(videoId, (p) => {
    const d = today();
    p.days[d] = Math.round((p.days[d] ?? 0) + seconds);
  });
}

/** Days in a row (ending today or yesterday) with at least a minute's practice. */
export function streak(days: Record<string, number>, now = new Date()): number {
  const has = (d: Date) => (days[today(d)] ?? 0) >= 60;
  const d = new Date(now);
  if (!has(d)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (has(d)) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** All lessons' days added together. */
export function allDays(videoIds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of videoIds) for (const [d, s] of Object.entries(getProgress(id).days)) out[d] = (out[d] ?? 0) + s;
  return out;
}

export function speedLabel(s: number | undefined): string {
  return s === undefined ? "" : s === 0 ? "1 by 1" : `${s}×`;
}
