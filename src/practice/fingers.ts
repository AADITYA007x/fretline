// Which finger goes where: a suggestion for the fretting hand (the video's
// tab doesn't say). One finger per fret from the lowest fret held; a fret
// held across 3+ strings at the lowest fret is a barre with the 1st finger.
import type { TabNote } from "../tabs/tab";

export type FingerNo = 1 | 2 | 3 | 4;

const SPOKEN: Record<string, FingerNo> = { index: 1, middle: 2, ring: 3, pinky: 4 };

/**
 * `around`: frets played just before and after; the hand usually stays put,
 * so a single note at fret 3 with fret 2 nearby is the 2nd finger, not the 1st.
 */
export function suggestFingers(notes: Pick<TabNote, "string" | "fret" | "tech" | "finger">[], around: number[] = []): (FingerNo | null)[] {
  const held = notes.map((n, i) => ({ n, i })).filter(({ n }) => n.fret > 0 && n.tech !== "mute" && n.tech !== "harmonic");
  const out: (FingerNo | null)[] = notes.map(() => null);
  if (!held.length) return out;
  const frets = held.map(({ n }) => n.fret);
  const hi = Math.max(...frets);
  const lo = Math.min(...frets, ...around.filter((f) => f > 0 && f >= hi - 3 && f <= hi));
  const distinct = [...new Set(frets)].sort((a, b) => a - b);
  // up the neck, and on one fret from the thicker string: each finger at
  // least one more than the last (Am: B1 → 1, D2 → 2, G2 → 3)
  const order = [...held].sort((a, b) => a.n.fret - b.n.fret || b.n.string - a.n.string);
  const barre = held.filter(({ n }) => n.fret === lo).length >= 3;
  let prev = 0;
  for (const { n, i } of order) {
    if (barre && n.fret === lo) {
      out[i] = 1;
      prev = 1;
      continue;
    }
    if (n.finger && SPOKEN[n.finger]) {
      out[i] = SPOKEN[n.finger];
      prev = out[i]!;
      continue;
    }
    const byFret = hi - lo <= 3 ? n.fret - lo + 1 : distinct.indexOf(n.fret) + 1;
    out[i] = Math.min(4, Math.max(prev + 1, byFret)) as FingerNo;
    prev = out[i]!;
  }
  // a fret held on 3+ strings at the bottom: barre with the 1st finger
  const atLo = held.filter(({ n }) => n.fret === lo);
  if (atLo.length >= 3) for (const { i } of atLo) out[i] = 1;
  return out;
}
