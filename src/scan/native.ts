// The phone's tab scanner (android TabScanPlugin). In a browser it isn't
// there, unless a test provides a stand-in.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { OcrChar, Rect } from "./vision";

export interface ScanProgress {
  videoId: string;
  phase: "download" | "look" | "read" | "sound";
  done: number;
  total: number;
}

export interface RawFeatures {
  t: number;
  y: string;
  u: string;
  v?: string;
  m: string;
}

export interface TabScanPlugin {
  prepare(o: { videoId: string; maxHeight?: number }): Promise<{ width: number; height: number; bytes: number; downloaded: boolean }>;
  download(o: { videoId: string; maxHeight?: number }): Promise<void>;
  cancel(o: { videoId: string }): Promise<void>;
  deleteVideo(o: { videoId: string }): Promise<void>;
  deleteImages(o: { videoId: string }): Promise<void>;
  overview(o: { videoId: string; count: number; width: number }): Promise<{
    width: number;
    height: number;
    durationSec: number;
    frames: { t: number; w: number; h: number; gray: string }[];
  }>;
  features(o: { videoId: string; rect: Rect; fps: number; cols: number }): Promise<void>;
  areas(o: { videoId: string; rect: Rect; times: number[] }): Promise<{
    results: { t: number; x: number; y: number; w: number; h: number; gray: string; image: string }[];
  }>;
  /** Same as areas, from frames decoded one by one (exact). */
  areasExact(o: { videoId: string; rect: Rect; times: number[] }): Promise<{
    results: { t: number; x: number; y: number; w: number; h: number; gray: string; image: string }[];
  }>;
  read(o: { gray: string; w: number; h: number }): Promise<{ chars: OcrChar[] }>;
  /** The lesson's sound as 16-bit mono samples, sent in "audio" events. */
  audio(o: { videoId: string; rate: number }): Promise<{ rate: number; samples: number }>;
  saveReport(o: { videoId: string; json: string }): Promise<void>;
  shareReport(o: { videoId: string }): Promise<void>;
  addListener(event: "progress", fn: (p: ScanProgress) => void): Promise<PluginListenerHandle>;
  addListener(event: "audio", fn: (b: { videoId: string; start: number; pcm: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "features", fn: (b: { videoId: string; frames: RawFeatures[] }) => void): Promise<PluginListenerHandle>;
}

type Fake = Partial<TabScanPlugin>;

function fake(): Fake | undefined {
  return (window as unknown as { __fretlineFakeTabScan?: Fake }).__fretlineFakeTabScan;
}

const missing = () => Promise.reject(new Error("Reading tab from the video works in the phone app."));

export const tabScan = registerPlugin<TabScanPlugin>("TabScan", {
  web: () =>
    new Proxy(
      {},
      {
        get: (_t, name: string | symbol) => {
          // Not a promise (Capacitor awaits the implementation).
          if (name === "then" || typeof name === "symbol") return undefined;
          const f = fake() as Record<string, unknown> | undefined;
          const fn = f?.[name];
          if (typeof fn === "function") return fn.bind(f);
          if (name === "addListener") return async () => ({ remove: async () => {} });
          return missing;
        },
      },
    ),
});

/** Wi-Fi, mobile data, or offline (tests can pretend). */
export async function connection(): Promise<"wifi" | "cellular" | "none" | "unknown"> {
  const forced = (window as unknown as { __fretlineFakeConnection?: "wifi" | "cellular" | "none" }).__fretlineFakeConnection;
  if (forced) return forced;
  try {
    const { Network } = await import("@capacitor/network");
    const s = await Network.getStatus();
    if (!s.connected) return "none";
    return s.connectionType === "wifi" ? "wifi" : s.connectionType === "cellular" ? "cellular" : "unknown";
  } catch {
    return navigator.onLine ? "unknown" : "none";
  }
}
