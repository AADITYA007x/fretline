// Before reading digits: remove the staff lines and the stems/bar lines.
// They cross or touch the digits and confuse text readers. Long thin runs
// are lines; digits are short. (The phone does the same in TabScanPlugin.)

/**
 * gray: w×h bytes of the tab area; lines: staff line y's in the same
 * pixels. Returns a cleaned copy.
 */
export function cleanTab(gray: Uint8Array, w: number, h: number, lines: number[]): Uint8Array {
  const spacing = (lines[5] - lines[0]) / 5;
  const out = Uint8Array.from(gray);
  const sorted = Array.from(gray).sort((a, b) => a - b);
  const bg = sorted[Math.floor(sorted.length * 0.9)];
  const isDark = (v: number) => v < bg - 25;

  // Long horizontal runs on (or right next to) a staff line.
  for (const ly of lines) {
    for (let y = Math.round(ly) - 2; y <= Math.round(ly) + 2; y++) {
      if (y < 0 || y >= h) continue;
      let x = 0;
      while (x < w) {
        if (!isDark(out[y * w + x])) {
          x++;
          continue;
        }
        const s = x;
        while (x < w && isDark(out[y * w + x])) x++;
        if (x - s > spacing * 1.5) for (let k = s; k < x; k++) out[y * w + k] = bg;
      }
    }
  }
  // Long vertical runs: stems and bar lines.
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!isDark(out[y * w + x])) {
        y++;
        continue;
      }
      const s = y;
      while (y < h && isDark(out[y * w + x])) y++;
      if (y - s > spacing * 1.6) for (let k = s; k < y; k++) out[k * w + x] = bg;
    }
  }
  return out;
}
