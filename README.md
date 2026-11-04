# Fretline

A private guitar helper for Android: a lesson player with a live tab strip (coming next) and a tuner.
Built with Capacitor + Vite + TypeScript, free tools only.

## Install on a phone

1. Open the repo's **Releases** page on the phone and download the latest `fretline-…apk`.
   (Builds from `dev` are under **Actions → Build Android APK → latest run → Artifacts**.)
2. Open it and allow "Install unknown apps" when asked. Updates install over the old version.
3. Sign in with the account Aaditya made (same accounts as Groov).

After that, the app shows a banner when a new version is out.

## What's in it

**v0.4 – Tab read from the video**

- v0.4.3: back to 720p (1080p made ML Kit read far fewer digits); small digits are read in enlarged overlapping pieces instead
- v0.4.2: download pieces retried (fresh link if needed) after a dropped connection; if the 1080p video shows no tab, the 720p one is tried before giving up; frames shrunk in halving steps so thin tab lines survive
- v0.4.1: the strip follows the video page by page; a line played twice (same tab shown again) gets its own timing instead of freezing; 1080p on Wi-Fi (720p on mobile data) and bigger enlargement for small digits; lessons read before can be **Read again**
- **Read video tab** downloads the lesson's picture (no sound, up to 720p) into the app's private cache, finds the tab staff, follows the playback cursor through the whole video, reads each tab page once with ML Kit (on the phone, offline), then deletes the video
- Notes are timed by when the cursor reaches them; where the video shows tab, the strip uses it instead of his words; **Picture** shows the original tab page
- On mobile data it asks first (with the size) or waits for Wi-Fi
- Tested on Aaditya's screen recordings (Love Story: clean tab with a blue cursor; Believer: busy tab with chord boxes and a pale cyan cursor); `scripts/scan-video.ts` replays a video file through the whole reader, with Tesseract standing in for ML Kit

**v0.3 – Live tab strip (from his words)**

- Reads the notes he names in the captions ("middle finger fourth string second fret", "hammer on to the fourth fret", "open D string", "…together") into tab, with the moment he said each one
- A strip under the video shows the phrase he's explaining, the note he's on lit up, and his words for it underneath
- Tap a note to fix it (string, fret, finger, hammer-on/pull-off/slide/bend/harmonic) or delete it; **+ Note** adds one at the current moment; tap the strip to pause/play
- Lessons, tab fixes and your tunings sync to your account (`supabase/001_fretline.sql`); without it everything stays on the phone
- Speed 0.5× – 1.25×; YouTube's own caption overlay hidden

**v0.2 – Lesson player**

- Share a YouTube lesson to Fretline (or paste its link); it plays in YouTube's own player inside the app
- His words written out as he says them (YouTube captions, word by word for auto captions), full transcript (tap a line to jump), chapters, −5 s / +5 s, 1× / 0.75× / 0.5×
- Remembers where you stopped; turn the phone sideways for a full-screen video
- Lesson details and captions are read natively with NewPipeExtractor (no API key); `.github/workflows/newpipe-check.yml` proposes NewPipe updates weekly

**v0.1 – Tuner**

- Auto (finds the string) or Pick a string (for strings that are way off)
- Hear it: reference tones, plucked or ringing
- Guitar, bass (4/5) and ukulele presets; your own tunings (3–8 strings)
- Save which tuning a song uses
- Reference pitch (A4 = 415–466 Hz)
- Pitch detection: YIN with an FFT, tested on generated plucks to within about 1 cent

## Develop

Needs Node.js 22+.

```bash
npm install
npm run dev        # http://localhost:4173
npm run build      # type-check + production build into dist/
npm test           # unit tests (pitch, tunings, captions, speech → tab, real recording) + SQL/RLS tests in PGlite
npm run e2e        # Playwright tests, phone and laptop sizes (build first)
```

## Accounts (Supabase)

Uses Groov's Supabase project (same accounts). The URL and publishable key are in `src/cloud/client.ts`;
row-level security in the database decides who can see what. Fretline's own tables start with
`fretline_` and ship as numbered files in `supabase/`, run once each in the SQL Editor. The app keeps
working (phone-only) until they're run.

## Releases

`.github/workflows/android.yml` builds a signed APK on every push. Pushes to `main` publish a GitHub
Release (`v<version>-build<run>`) and delete older ones. The signing key lives only in the repo secrets
`FRETLINE_KEYSTORE_BASE64` and `FRETLINE_KEYSTORE_PASSWORD`.
