// The practice ladder: slow and clear first (Fretline's own pluck, note by
// note), then the real video sound, a little faster each time round, up to
// the speed you're aiming for.

export type Start = "step" | 0.25 | 0.5;
export type Pace = "slow" | "normal" | "quick";
export type SoundChoice = "auto" | "pluck" | "video";

export interface Stage {
  /** "step" = 1 by 1 (each note on its own); otherwise the speed. */
  speed: "step" | number;
  sound: "pluck" | "video";
  /** Times round the part before moving up. */
  loops: number;
}

export interface LadderOptions {
  start: Start;
  goal: number;
  pace: Pace;
  sound: SoundChoice;
}

/** The speeds YouTube's player can play at (it rounds anything else). */
export const VIDEO_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25];

const LOOPS: Record<Pace, number> = { slow: 4, normal: 2, quick: 1 };
const STEP: Record<Pace, number> = { slow: 0.05, normal: 0.1, quick: 0.25 };

const round = (x: number) => Math.round(x * 100) / 100;

export function ladder(o: LadderOptions): Stage[] {
  const loops = LOOPS[o.pace];
  const goal = Math.max(0.25, o.goal);
  const soundAt = (speed: number): "pluck" | "video" => (o.sound === "pluck" ? "pluck" : o.sound === "video" ? "video" : speed < 0.5 ? "pluck" : "video");
  const stages: Stage[] = [];
  // 1 by 1 is always Fretline's pluck (the video can't stop on each note cleanly)
  if (o.start === "step") stages.push({ speed: "step", sound: "pluck", loops: Math.min(loops, 2) });
  const from: number = o.start === "step" ? 0.25 : o.start;
  let speeds: number[];
  if (o.sound === "pluck") {
    // our own sound can play at any speed: small steady steps
    speeds = [];
    for (let s = from; s < goal - 1e-6; s = round(s + (s < 0.5 ? 0.25 : STEP[o.pace]))) speeds.push(round(Math.min(s, goal)));
    speeds.push(goal);
  } else {
    // the video only plays at its own speeds
    speeds = VIDEO_SPEEDS.filter((s) => s >= from - 1e-6 && s <= goal + 1e-6);
    if (!speeds.length || speeds[speeds.length - 1] < goal - 1e-6) speeds.push(goal);
  }
  for (const s of [...new Set(speeds)]) stages.push({ speed: s, sound: soundAt(s), loops });
  return stages;
}

export function stageLabel(s: Stage): string {
  return s.speed === "step" ? "1 by 1" : `${s.speed}×`;
}
