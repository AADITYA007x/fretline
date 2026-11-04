// Test doubles: a fake Android bridge, a fake Supabase, a fake GitHub
// release, and a fake microphone that plays a guitar-like tone.
import type { Page } from "@playwright/test";

export const SUPABASE = "https://tuampzpsciqannjolflv.supabase.co";
export const USER = { id: "11111111-1111-4111-8111-111111111111", email: "aaditya@example.com", user_metadata: {} };

export function session() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: "fake-access",
    refresh_token: "fake-refresh",
    token_type: "bearer",
    expires_in: 86400,
    expires_at: now + 86400,
    user: { ...USER, aud: "authenticated", role: "authenticated", app_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
  };
}

/** What the fake account database holds, so tests can look inside. */
export type FakeDb = Record<string, Record<string, unknown>[]>;

export async function fakeSupabase(page: Page, opts: { tablesMissing?: boolean } = {}): Promise<FakeDb> {
  const db: FakeDb = { fretline_lessons: [], fretline_tab_fixes: [], fretline_settings: [] };
  const keys: Record<string, string[]> = { fretline_lessons: ["video_id"], fretline_tab_fixes: ["video_id"], fretline_settings: [] };
  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    const table = url.pathname.replace("/rest/v1/", "");
    if (table in db) {
      if (opts.tablesMissing)
        return route.fulfill({ status: 404, json: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } });
      const req = route.request();
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        for (const row of Array.isArray(body) ? body : [body]) {
          const full = { user_id: USER.id, ...row };
          const i = db[table].findIndex((r) => keys[table].every((k) => r[k] === full[k]));
          if (i >= 0) db[table][i] = { ...db[table][i], ...full };
          else db[table].push(full);
        }
        return route.fulfill({ status: 201, body: "" });
      }
      const rows = db[table];
      if ((req.headers()["accept"] ?? "").includes("vnd.pgrst.object")) {
        if (!rows.length) return route.fulfill({ status: 406, json: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "The result contains 0 rows" } });
        return route.fulfill({ json: rows[0] });
      }
      return route.fulfill({ json: rows });
    }
    if (url.pathname === "/auth/v1/token") {
      const body = route.request().postDataJSON() as { email?: string; password?: string };
      if (body.password === "right-password") return route.fulfill({ json: session() });
      return route.fulfill({ status: 400, json: { error: "invalid_grant", error_description: "Invalid login credentials", msg: "Invalid login credentials" } });
    }
    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/auth/v1/user") return route.fulfill({ json: session().user });
    if (url.pathname === "/rest/v1/profiles") return route.fulfill({ json: { display_name: "Aaditya" } });
    return route.fulfill({ status: 404, json: {} });
  });
  return db;
}

export async function signedIn(page: Page): Promise<void> {
  await page.addInitScript((s) => localStorage.setItem("fretline:auth", JSON.stringify(s)), session());
}

/** Pretend to be the Android app (Capacitor sees an Android bridge). */
export async function fakeNative(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { androidBridge: unknown }).androidBridge = { postMessage() {} };
  });
}

export async function fakeRelease(page: Page, tag: string): Promise<void> {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: { tag_name: tag, assets: [{ name: `fretline-${tag}-main.apk`, browser_download_url: "https://example.com/fretline.apk" }] },
    }),
  );
}

/**
 * Replaces the microphone with a plucked-string-like tone whose pitch the
 * test sets with window.__mic.set(freq) (0 = silence). `deny` simulates the
 * user refusing the mic permission.
 */
export async function fakeMic(page: Page, opts: { deny?: boolean; buds?: boolean } = {}): Promise<void> {
  await page.addInitScript(({ deny, buds }) => {
    let ctx: AudioContext | null = null;
    let oscs: OscillatorNode[] = [];
    let gain: GainNode | null = null;
    let noise: AudioBufferSourceNode | null = null;
    const w = window as unknown as { __mic: { set(freq: number): void; calls: number; asked: string[] } };
    // With buds, the phone lists their mic first and gives it by default.
    const devices = buds
      ? [
          { kind: "audioinput", deviceId: "default", label: "Default", groupId: "" },
          { kind: "audioinput", deviceId: "bt", label: "Bluetooth headset", groupId: "" },
          { kind: "audioinput", deviceId: "phone", label: "Speakerphone", groupId: "" },
        ]
      : [{ kind: "audioinput", deviceId: "phone", label: "Speakerphone", groupId: "" }];
    w.__mic = {
      calls: 0,
      asked: [],
      set(freq: number) {
        if (!ctx || !gain) return;
        // Like a new pluck: a short silence, then the note.
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0, t);
        oscs.forEach((o, i) => o.frequency.setValueAtTime(freq * (i + 1) || 1, t + 0.1));
        if (freq) gain.gain.setValueAtTime(0.3, t + 0.15);
      },
    };
    Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    (navigator.mediaDevices as MediaDevices).enumerateDevices = async () => devices as MediaDeviceInfo[];
    (navigator.mediaDevices as MediaDevices).getUserMedia = async (c?: MediaStreamConstraints) => {
      w.__mic.calls++;
      if (deny) throw new DOMException("Permission denied", "NotAllowedError");
      const want = ((c?.audio as MediaTrackConstraints)?.deviceId as { exact?: string })?.exact;
      w.__mic.asked.push(want ?? "");
      const id = want ?? (buds ? "bt" : "phone");
      const dev = devices.find((d) => d.deviceId === id)!;
      const silent = id === "bt"; // the buds' mic can't hear the guitar
      const stream = await makeStream(silent);
      const track = stream.getAudioTracks()[0];
      Object.defineProperty(track, "label", { value: dev.label });
      track.getSettings = () => ({ deviceId: id });
      return stream;
    };
    const makeStream = async (silent: boolean) => {
      ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      gain = ctx.createGain();
      gain.gain.value = 0;
      oscs = [1, 0.5, 0.3, 0.2].map((amp) => {
        const o = ctx!.createOscillator();
        const g = ctx!.createGain();
        g.gain.value = amp;
        o.connect(g).connect(gain!);
        o.start();
        return o;
      });
      // A little room noise.
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.004;
      noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      noise.connect(dest);
      noise.start();
      if (!silent) gain.connect(dest);
      return dest.stream;
    };
  }, { deny: opts.deny ?? false, buds: opts.buds ?? false });
}

export async function shot(page: Page, name: string, project: string): Promise<void> {
  await page.screenshot({ path: `test-results/shots/${project}-${name}.png` });
}

/**
 * YouTube's IFrame player stand-in: a grey box with a clock. `blocked`
 * makes it fail like a video that can't be embedded.
 */
export async function fakeYouTube(page: Page, opts: { blocked?: string[] } = {}): Promise<void> {
  const blocked = JSON.stringify(opts.blocked ?? []);
  await page.route("https://www.youtube.com/iframe_api", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `(() => {
        const BLOCKED = ${blocked};
        class Player {
          constructor(el, o) {
            this.o = o; this.t = (o.playerVars && o.playerVars.start) || 0; this.rate = 1; this.state = 5; this.dur = 300;
            const box = document.createElement("div");
            box.className = "fake-yt"; box.style.cssText = "position:absolute;inset:0;background:#333;color:#ddd;display:grid;place-items:center;font:14px monospace";
            box.textContent = "video " + o.videoId;
            el.replaceWith(box); this.box = box; window.__yt = this;
            setTimeout(() => {
              o.events.onReady && o.events.onReady();
              if (BLOCKED.includes(o.videoId)) o.events.onError && o.events.onError({ data: 150 });
            }, 30);
            this.timer = setInterval(() => {
              if (this.state === 1) { this.t += 0.1 * this.rate; if (this.t >= this.dur) { this.t = this.dur; this.set(0); } }
              this.box.textContent = "video " + o.videoId + " @ " + this.t.toFixed(1);
            }, 100);
          }
          set(s) { this.state = s; this.o.events.onStateChange && this.o.events.onStateChange({ data: s }); }
          playVideo() { this.set(1); }
          pauseVideo() { this.set(2); }
          seekTo(s) { this.t = Math.max(0, Math.min(this.dur, s)); }
          getCurrentTime() { return this.t; }
          getDuration() { return this.dur; }
          getPlayerState() { return this.state; }
          setPlaybackRate(r) { this.rate = r; }
          destroy() { clearInterval(this.timer); }
        }
        window.YT = { Player };
        setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 10);
      })();`,
    }),
  );
  await page.route("https://i.ytimg.com/**", (route) => route.fulfill({ status: 404, body: "" }));
}

/** The phone app's lesson reader, with a lesson that has chapters and captions. */
export async function fakeLessonInfo(page: Page, captionsJson3: string): Promise<void> {
  await page.addInitScript((json3) => {
    const lessons: Record<string, unknown> = {
      ZeeuvgrDUeQ: {
        videoId: "ZeeuvgrDUeQ",
        title: "Neon intro, fingerstyle lesson",
        uploader: "Let's Play Guitar",
        durationSec: 300,
        thumbnail: null,
        chapters: [
          { title: "Intro", startSec: 0 },
          { title: "Riff part 1", startSec: 60 },
          { title: "Full play-through", startSec: 240 },
        ],
        captions: [
          { lang: "en", name: "English (auto-generated)", auto: true, url: "https://www.youtube.com/api/timedtext?v=ZeeuvgrDUeQ&lang=en&kind=asr" },
          { lang: "hi", name: "Hindi", auto: false, url: "https://www.youtube.com/api/timedtext?v=ZeeuvgrDUeQ&lang=hi" },
        ],
      },
      "2Lq784V-KPw": {
        videoId: "2Lq784V-KPw",
        title: "No captions here",
        uploader: "Fingerstyle Club",
        durationSec: 120,
        thumbnail: null,
        chapters: [],
        captions: [],
      },
    };
    const hindi = JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "नमस्ते दोस्तों" }] }] });
    (window as unknown as { __fretlineFakeLessonInfo: unknown }).__fretlineFakeLessonInfo = {
      info: async ({ videoId }: { videoId: string }) => {
        await new Promise((r) => setTimeout(r, 150));
        const l = lessons[videoId];
        if (!l) throw new Error("Video unavailable");
        return l;
      },
      fetchText: async ({ url }: { url: string }) => ({ text: url.includes("lang=hi") ? hindi : json3 }),
    };
  }, captionsJson3);
}
