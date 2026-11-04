// "New version available": the phone app checks the repo's latest GitHub
// Release (published by CI on every push to main) a few times a day and
// shows a banner with a direct APK download.
import { isNativeApp } from "../native";
import { bus } from "../state";
import { $, storage } from "../utils";

const LATEST = "https://api.github.com/repos/AADITYA007x/fretline/releases/latest";
const CHECK_KEY = "fretline:update-check";
const EVERY = 6 * 3600_000; // GitHub allows 60 unsigned checks an hour; we need ~4 a day

interface Check {
  at: number;
  version: string | null;
  url: string | null;
}

/** "v1.24.0-build53" → [1, 24, 0] */
function parse(v: string): number[] {
  return (v.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? ["0", "0", "0"]).map(Number);
}

export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function render(check: Check | null): void {
  const banner = $<HTMLAnchorElement>("update-banner");
  const show = !!check?.version && !!check.url && isNewer(check.version, __APP_VERSION__);
  banner.hidden = !show;
  if (!show) return;
  const version = check!.version!.replace(/^v/, "").replace(/-build.*/, "");
  $("update-version").textContent = `Fretline ${version} is ready`;
  banner.href = check!.url!;
}

async function checkNow(): Promise<void> {
  try {
    const res = await fetch(LATEST, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const data = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
    const apk = data.assets?.find((a) => a.name.endsWith(".apk"));
    const check: Check = { at: Date.now(), version: data.tag_name ?? null, url: apk?.browser_download_url ?? null };
    const before = storage.get<Check | null>(CHECK_KEY, null);
    storage.set(CHECK_KEY, check);
    render(check);
    if (check.version && isNewer(check.version, __APP_VERSION__) && before?.version !== check.version) {
      bus.emit("toast", "A new version of Fretline is ready");
    }
  } catch {
    // offline: try later
  }
}

function maybeCheck(): void {
  const last = storage.get<Check | null>(CHECK_KEY, null);
  if (!last || Date.now() - last.at > EVERY) void checkNow();
}

export function initUpdate(): void {
  if (!isNativeApp) return;
  render(storage.get<Check | null>(CHECK_KEY, null));
  setTimeout(maybeCheck, 5000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybeCheck();
  });
}
