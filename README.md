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

**v0.9 – Listen to me**

- v0.9.1: listening shows live what it heard: each note in the line turns green with ✓ when heard, red when its moment passed unheard, and a level bar on the note card shows the mic hearing you; a note now counts up to ~0.7 s late in real time (Bluetooth buds are late); with Listen on, Fretline's pluck steps (0.25×…) go quiet (click only) so you play and it hears you, not itself; a slap with notes is found through the hit (one clear reading is enough)
- v0.9.0: Practice **Listen: Listen to me** (uses the mic, the phone's own when buds are in): in 1 by 1 it plucks the note, then waits until it hears you play it (single notes by pitch, an octave slip allowed; chords by which of the 12 notes sound, compared with the chord's notes; slaps by the hit), says "Heard A: try again" for a wrong note, and you tap the note to skip one; each round ends with "7 of 10 right first time". Faster rounds end with how many of the notes it heard near their time (needs earphones, or it hears the app's own sound) (`src/practice/listen.ts`). Practice header re-laid (◀ line to line ▶ on one row)

**v0.8 – Practice**

- v0.8.1: tap a chord name ([Am]) or a held shape ([2 1 / 3 2]) in My notes or Practice for a chord box: the shape as played here (on each string, the fret used most while that chord lasts) and the usual open shape (built-in list), with finger numbers (up the neck, and on one fret from the thicker string: Am = 1 on B, 2 on D, 3 on G; barre = 1). Practice: ◀ ▶ to move a line; "At goal: Next line" ticks the lines done and goes on; 1 by 1 holds 2, 3 or 4 s a note (3 s by default); the video's sound starts with a silent run-up and stops just before the next line's notes; the lit note is the note itself, not its chord name
- v0.8.0: **Practice** (on the tab strip, or in My notes): the app takes over from the video. Pick lines of My notes and climb a ladder: 1 by 1 → 0.25× with Fretline's own pluck (clear, one note at a time; video paused), then the video's own sound at 0.5×, 0.75×, 1× (YouTube only plays at its own speeds; with Sound: Pluck the speed can rise in small steps). Choose where to start (1 by 1 / 0.25× / 0.5×), the goal (0.5× / 0.75× / 1×), the pace (Slow: 4 rounds a step, Normal: 2, Quick: 1) and the sound (Auto / Pluck / Video); Up and Back move a step yourself. A fretboard shows where the fingers go now (with suggested finger numbers: one finger per fret from where the hand is, barre = 1st finger) and, dashed, the next note. A click on the beat: tempo found from the notes' timing (Love Story: ~110 BPM), − / + and Tap to set it, louder on the first beat of a bar; it follows the speed (`src/practice`)

**v0.7 – My notes (tab in your notebook style)**

- v0.7.4: the lesson title is no longer cut off (the cover for the status bar only shows once the video is stuck at the top); wavy roll lines by a chord are read as a roll (played low to high, like a strum down; all 8 found on Believer's pictures were real); My notes shows where a slide starts in notes played together (`1→5+1→5`). Read again
- v0.7.3: 1 by 1 with Pluck on mutes the video (only Fretline's sound, no overlap). Lesson screen re-laid: the app's header gives way to the lesson's (menu there too), seek bar and buttons sit right under the video, and on a phone the video with its buttons stays on screen while you scroll down to the tab, his words and My notes; tighter tab strip, notes fade under the string names
- v0.7.2: scrolling tabs (Believer): cursor readings that sit stuck at the edge while the tab scrolls, or jump to the far right as it turns, are dropped (the cursor moves at a steady speed); notes the cursor wasn't seen over are timed along its speed instead of piling up at one moment; a column shown at the end of one view and the start of the next is kept once (on Believer's reading: 41 repeated columns gone, columns crammed together 43 → 11). My notes never puts two notes of one string in one group. Read again
- v0.7.1: 1 by 1 plays each note itself while the video waits (**Pluck: on/off**; a plucked-string sound at the right pitch with the capo the sound check found; strums rolled, slaps as a thump) (`src/tabs/pluck.ts`). My notes: a new chord or held shape starts a new line, the chord name sits in the line (`[D] 1/1 2/2`), slaps written as ✋, slide-outs shown inside notes played together; a tapped line stays lit while the video runs up to it. Chord names read from higher above the tab (Believer's Fmaj7 and E7 were cut off) and letters joined even with a bar number under them; strum arrows no longer read as slide-outs on chords. Read again for chord names and the capo
- v0.7.0: **My notes** tab under the video: the lesson's tab written like Aaditya's notebook (fret on top, string below; `+` together; `[frets / strings]` held shape then `roll` for a strummed chord; `5→7` slides; `pull`; `‖ ‖` hammer-on; `7↘` slide out), 8–10 notes per numbered line with its time and chord names in brackets. Tap a line to play it; tick lines off as you learn them (saved per lesson). **Print / PDF** opens Android's print screen (print or Save as PDF, A4, notebook look); **Copy as text** shares it as plain text (`src/tabs/notebook.ts`)
- Chord names written above the video's tab are read too (ML Kit on a band above the staff) and shown over the strip
- Slide-outs (a slash after a note with nothing after it) drawn as a falling line
- 1 by 1 plays at most 0.5× (at 1× it skipped notes); tried a per-note pitch check that would flag doubtful notes, but it flagged ~1 in 5 good notes, so it's left out

**v0.6 – Our own digit reader**

- v0.6.2: when the sound doesn't line up clearly for the whole song (Believer: lots of muted hits), each page finds its own slide and capo and they vote
- v0.6.1: tab pictures taken from frames decoded one by one (the quick frame grabber sometimes handed back the page before: Love Story's page 4 showed page 3's notes), and every picture checked against what the look through the video saw at that moment; a short line joining a chord's stacked notes is no longer read as a 1
- v0.6.0: a small digit reader of our own (`src/scan/digits.ts`, trained by `scripts/train`: tab strips drawn in common tab fonts with stems, beams, highlights, cursors, x's and non-digit signs) reads every mark; a font matcher (this page's own sure digits) and ML Kit are second and third votes; disagreements are marked with a dashed outline and "?" in the strip. Each page read at five moments. The mark finder also cuts digits apart where they touch in a tight chord, keeps strokes that cross a line, keeps a 1 sitting on its stem, and takes light grey digits. On synthetic tab: 99% of digits read right; on real Love Story and Believer bars: every digit found and read right (tests). Sync: one steady slide for the song (a page only differs when its sound clearly says so); a note only moves onto a pluck where its own pitch starts. 1 by 1 keeps its card up until the video is really playing again.

**v0.5 – In time with the sound**

- v0.5.0: after reading the tab, the lesson's sound is downloaded once (small, deleted after) and each note is lined up with its pluck: one slide for the video found by matching the notes' pitches to what starts sounding (capo found too), refined page by page, then each note moved onto the pluck next to it (`src/scan/onsets.ts`; `scripts/sync-check.ts` checks a recording). 1 by 1 stops just before each note
- Tested on a screen recording of the Love Story lesson: the reader's cursor times were 0.2 s late; slides of +0.7, −1.2 and +2.5 s put on purpose were all found back to within 0.06 s (`tests/unit/onsets.test.ts`, sound features only, no audio in the repo)

**v0.4 – Tab read from the video**

- v0.4.11: every tab page is read (look-alike pages had been sharing one reading, so a 0 could show as a 2); 1 by 1 pauses under a card that names the note (no jumping back, no buffering); slides drawn as a rising/falling line from the note before
- v0.4.10: tabs that scroll (Believer) no longer repeat bars or pile notes at the end of a view; frames that came back black are fetched again (Believer's intro); 1 by 1 holds the picture silently instead of pausing (no YouTube buttons over the video); the tape stays where you scroll it, with **Back to now**
- v0.4.9: digits joined to stems and beams (Love Story's 0s) are found; light, thin digits copied with their soft edges; bigger strum arrows
- v0.4.8: **1 by 1** (note by note): stops 2 s on each note showing its string and fret, then plays it up to the next; speed down to 0.25×
- v0.4.7: symbols from the video's tab: x (muted hits), slides (/ \\), hammer-on/pull-off arcs (up or down the neck), harmonics <12>, strum arrows ↑↓ by their chord; a digit touching its stem is no longer dropped
- v0.4.6: the strip is one continuous tape that glides with the video across page changes (thin line where a new page starts, "page 4 of 20" in the label); no more "22"/"11" from one digit (wider gaps in the row, a single mark is a single digit)
- v0.4.5: new digit reader: the app finds each digit sitting on a staff line itself (skipping X's and slide marks), lays them out in a clean row and has ML Kit read that row, then puts the answers back; on Believer's pictures this finds ~4× more digits than reading the tab directly (`scripts/glyph-check.ts` replays a reading-details zip)
- v0.4.4: cursor found inside a yellow-highlighted bar too (notes were piling up at the start/end of a page); each page read at three moments and the readings compared; **Send reading details** (under Picture) shares what the reader saw, for checking accuracy
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
