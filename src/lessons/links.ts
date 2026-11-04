// Finding the YouTube video in whatever was pasted or shared.

const ID = /^[A-Za-z0-9_-]{11}$/;

export interface VideoRef {
  videoId: string;
  /** Start time from a ?t= link, in seconds. */
  startSec: number;
}

/** "1h2m3s", "90s", "90" → seconds. */
function parseTime(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** The video in a link (or in text that contains one, like a share). */
export function parseVideoRef(text: string): VideoRef | null {
  const trimmed = text.trim();
  if (ID.test(trimmed)) return { videoId: trimmed, startSec: 0 };
  const urls = trimmed.match(/https?:\/\/[^\s]+/g) ?? (/(youtu\.be|youtube\.com)\//.test(trimmed) ? [`https://${trimmed}`] : []);
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = url.searchParams.get("v");
      const path = /^\/(shorts|live|embed|v)\/([^/?#]+)/.exec(url.pathname);
      if (!id && path) id = path[2];
    }
    if (id && ID.test(id)) return { videoId: id, startSec: parseTime(url.searchParams.get("t") ?? url.searchParams.get("start")) };
  }
  return null;
}
