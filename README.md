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

Tunings and songs are stored on the phone for now; they'll sync to your account when the tab library arrives.

## Develop

Needs Node.js 22+.

```bash
npm install
npm run dev        # http://localhost:4173
npm run build      # type-check + production build into dist/
npm test           # unit tests (pitch detection, tunings)
npm run e2e        # Playwright tests, phone and laptop sizes (build first)
```

## Accounts (Supabase)

Uses Groov's Supabase project (same accounts). The URL and publishable key are in `src/cloud/client.ts`;
row-level security in the database decides who can see what. Fretline's own tables will be prefixed
`fretline_`, shipped as numbered files in `supabase/` to run in the SQL Editor.

## Releases

`.github/workflows/android.yml` builds a signed APK on every push. Pushes to `main` publish a GitHub
Release (`v<version>-build<run>`) and delete older ones. The signing key lives only in the repo secrets
`FRETLINE_KEYSTORE_BASE64` and `FRETLINE_KEYSTORE_PASSWORD`.
