// YouTube's own player (the IFrame API), the same way Groov shows videos.
// Our controls drive it; its own are hidden.

/* Minimal typing for the parts of the IFrame API we use. */
interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(sec: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      width?: string;
      height?: string;
      videoId?: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

let apiReady: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  apiReady ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT!);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      apiReady = null;
      reject(new Error("Can't reach YouTube. Check your internet."));
    };
    document.head.appendChild(s);
  });
  return apiReady;
}

export interface PlayerEvents {
  onState: (state: number) => void;
  onError: (message: string) => void;
}

/** One player per lesson screen; created into `host`. */
export class LessonPlayer {
  private player: YTPlayer | null = null;
  private ready: Promise<YTPlayer> | null = null;

  constructor(
    private host: HTMLElement,
    private events: PlayerEvents,
  ) {}

  async open(videoId: string, startSec: number): Promise<void> {
    const YT = await loadApi();
    this.destroy();
    const el = document.createElement("div");
    this.host.replaceChildren(el);
    this.ready = new Promise((resolve) => {
      const p = new YT.Player(el, {
        width: "100%",
        height: "100%",
        videoId,
        playerVars: {
          controls: 0,
          disablekb: 1,
          fs: 0,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          cc_load_policy: 0,
          start: Math.floor(startSec),
        },
        events: {
          onReady: () => resolve((this.player = p)),
          onStateChange: (e) => this.events.onState(e.data),
          onError: (e) => this.events.onError(describeError(e.data)),
        },
      });
    });
    await this.ready;
  }

  private async with(fn: (p: YTPlayer) => void): Promise<void> {
    const p = await this.ready;
    if (p) fn(p);
  }

  play(): void {
    void this.with((p) => p.playVideo());
  }

  pause(): void {
    void this.with((p) => p.pauseVideo());
  }

  seek(sec: number): void {
    void this.with((p) => p.seekTo(Math.max(0, sec), true));
  }

  setRate(rate: number): void {
    void this.with((p) => p.setPlaybackRate(rate));
  }

  time(): number {
    return this.player?.getCurrentTime() ?? 0;
  }

  duration(): number {
    return this.player?.getDuration() ?? 0;
  }

  state(): number {
    return this.player?.getPlayerState() ?? -1;
  }

  destroy(): void {
    try {
      this.player?.destroy();
    } catch {
      // already gone
    }
    this.player = null;
    this.ready = null;
    this.host.replaceChildren();
  }
}

function describeError(code: number): string {
  if (code === 101 || code === 150 || code === 152 || code === 153)
    return "The channel doesn't allow this video to play inside other apps. Open it in YouTube instead.";
  if (code === 100) return "This video was removed or made private.";
  if (code === 5) return "This video can't play here.";
  return "The video didn't load. Check your internet and try again.";
}
