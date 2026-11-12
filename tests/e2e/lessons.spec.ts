import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { fakeMic, fakeLessonInfo, fakeNative, fakeSupabase, fakeTabScan, fakeYouTube, shot, signedIn } from "./fakes";

const CAPTIONS = readFileSync("tests/fixtures/lesson-captions.json3", "utf8");
const yt = (page: Page) => page.evaluate(() => ((window as any).__yt?.getCurrentTime() as number) ?? -1);

test.beforeEach(async ({ page }) => {
  await fakeSupabase(page);
  await signedIn(page);
  await fakeYouTube(page, { blocked: ["c0JsZN9w_ME"] });
  await fakeLessonInfo(page, CAPTIONS);
});

test("add a lesson by link, play it and read along", async ({ page }, info) => {
  await page.goto("/");
  await page.click('.tab[data-view="lessons"]');
  await expect(page.locator("#lessons-empty")).toBeVisible();
  await shot(page, "20-lessons-empty", info.project.name);

  await page.fill("#lesson-link", "https://example.com/not-youtube");
  await page.click('#add-lesson-form button[type="submit"]');
  await expect(page.locator("#lesson-error")).toHaveText("That doesn't look like a YouTube link.");

  await page.fill("#lesson-link", "https://youtu.be/ZeeuvgrDUeQ?si=Kp_ShbnS0mtypFd9");
  await page.click('#add-lesson-form button[type="submit"]');
  await expect(page.locator("#view-lesson")).toBeVisible();
  await expect(page.locator("#lesson-title")).toHaveText("Neon intro, fingerstyle lesson");
  await expect(page.locator("#lesson-uploader")).toHaveText("Let's Play Guitar");
  await expect(page.locator("#caption-name")).toHaveText("Captions: English (auto-generated)");
  await expect(page.locator(".tline")).toHaveCount(74);
  await expect(page.locator("#chapter-ticks i")).toHaveCount(2);

  await page.click("#lesson-play");
  await expect(page.locator("#lesson-play")).toHaveAttribute("aria-label", "Pause");
  // Line 1 starts at 1 s: "so here we play the intro", word by word.
  await expect(page.locator("#saying-text .said").first()).toHaveText("so", { timeout: 4000 });
  await expect(page.locator("#saying-text")).toContainText("here we play the intro");
  await expect(page.locator(".tline.now")).toHaveAttribute("data-index", "0");
  await shot(page, "21-lesson-playing", info.project.name);

  // Tap a line in the transcript: jumps there.
  await page.locator('.tline[data-index="10"]').click();
  expect(await yt(page)).toBeGreaterThanOrEqual(41);
  await expect(page.locator(".tline.now")).toHaveAttribute("data-index", "10");

  // Chapters
  await page.click('.lesson-tabs [data-pane="chapters"]');
  await expect(page.locator(".chapter")).toHaveCount(3);
  await page.locator(".chapter", { hasText: "Riff part 1" }).click();
  await expect(page.locator(".chapter.now")).toContainText("Riff part 1");
  expect(await yt(page)).toBeGreaterThanOrEqual(60);
  await shot(page, "22-lesson-chapters", info.project.name);

  // −5s / +5s and speed
  const before = await yt(page);
  await page.click("#lesson-back5");
  expect(await yt(page)).toBeLessThan(before - 4);
  await page.selectOption("#lesson-speed", "0.5");
  expect(await page.evaluate(() => (window as any).__yt.rate)).toBe(0.5);
  await page.selectOption("#lesson-speed", "1.25");
  expect(await page.evaluate(() => (window as any).__yt.rate)).toBe(1.25);

  // Other captions track
  await page.click('.lesson-tabs [data-pane="transcript"]');
  await page.click("#caption-switch");
  await expect(page.locator("#caption-name")).toHaveText("Captions: Hindi");
  await expect(page.locator(".tline")).toHaveCount(1);
  await page.click("#caption-switch");
  await expect(page.locator(".tline")).toHaveCount(74);

  // Leave: the list remembers where you were.
  await page.click("#lesson-play");
  await page.click("#lesson-back");
  await expect(page.locator("#view-lessons")).toBeVisible();
  await expect(page.locator(".lesson-row")).toHaveCount(1);
  await expect(page.locator(".lesson-row")).toContainText("Neon intro");
  await expect(page.locator(".thumb-time")).toHaveText("5:00");
  await shot(page, "23-lessons-list", info.project.name);

  // Reopen (after reload): starts where you left off.
  await page.reload();
  await page.locator(".lesson-open").click();
  await expect(page.locator("#lesson-title")).toHaveText("Neon intro, fingerstyle lesson");
  await expect.poll(() => yt(page)).toBeGreaterThan(50);
});

test("share from YouTube opens the lesson, even from the tuner", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#view-tuner")).toBeVisible();
  await page.evaluate(() => (window as any).fretlineShare("Neon lesson https://youtu.be/ZeeuvgrDUeQ?si=x&t=95"));
  await expect(page.locator("#view-lesson")).toBeVisible();
  await expect(page.locator('.tab[data-view="lessons"]')).toHaveAttribute("aria-current", "page");
  await expect.poll(() => yt(page)).toBeGreaterThanOrEqual(95);
  await page.evaluate(() => (window as any).fretlineShare("just some text"));
  await expect(page.locator("#toast")).toHaveText("That share wasn't a YouTube link");
});

test("a video without captions, and one that can't be embedded", async ({ page }, info) => {
  await page.goto("/");
  await page.click('.tab[data-view="lessons"]');
  await page.fill("#lesson-link", "https://www.youtube.com/watch?v=2Lq784V-KPw");
  await page.click('#add-lesson-form button[type="submit"]');
  await expect(page.locator("#saying-text")).toHaveText("This video has no captions, so his words can't be shown.");
  await page.click('.lesson-tabs [data-pane="chapters"]');
  await expect(page.locator("#chapter-list .pane-empty")).toHaveText("This video has no chapters.");
  await page.click("#lesson-back");

  await page.fill("#lesson-link", "https://youtu.be/c0JsZN9w_ME");
  await page.click('#add-lesson-form button[type="submit"]');
  await expect(page.locator("#video-error")).toContainText("doesn't allow this video to play inside other apps");
  await expect(page.locator("#saying-text")).toContainText("Couldn't load the lesson's details");
  await shot(page, "24-lesson-errors", info.project.name);
});

test("android back: closes the lesson, then the section", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await fakeNative(page);
  await page.goto("/");
  await page.click('.tab[data-view="lessons"]');
  await page.fill("#lesson-link", "ZeeuvgrDUeQ");
  await page.click('#add-lesson-form button[type="submit"]');
  await expect(page.locator("#view-lesson")).toBeVisible();
  expect(await page.evaluate(() => (window as any).fretlineBack())).toBe(true);
  await expect(page.locator("#view-lessons")).toBeVisible();
  await expect(page.locator("#view-lesson")).toBeHidden();
  expect(await page.evaluate(() => (window as any).fretlineBack())).toBe(true);
  await expect(page.locator("#view-tuner")).toBeVisible();
});

test("phone sideways: only the video", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await page.goto("/");
  await page.click('.tab[data-view="lessons"]');
  await page.fill("#lesson-link", "ZeeuvgrDUeQ");
  await page.click('#add-lesson-form button[type="submit"]');
  await expect(page.locator("#lesson-title")).toHaveText("Neon intro, fingerstyle lesson");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".tabbar")).toBeHidden();
  const box = await page.locator(".video-frame").boundingBox();
  expect(box!.height).toBeGreaterThan(380);
  await shot(page, "25-landscape", info.project.name);
});

test.describe("tab strip", () => {
  test("shows the notes he names, lit as he says them; fix one", async ({ page }, info) => {
    const db = await fakeSupabase(page);
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "https://youtu.be/ZeeuvgrDUeQ");
    await page.click('#add-lesson-form button[type="submit"]');
    await expect(page.locator("#strip-label")).toContainText("Next notes, at 0:05");
    await page.waitForFunction(() => (window as any).__yt);

    // 0:05 "third string second fret with index", 0:09 "and hammer on to the fourth fret",
    // 0:13 "now slide to seventh fret"
    await page.evaluate(() => (window as any).__yt.seekTo(5.6));
    await page.click("#lesson-play");
    await expect(page.locator("#strip-label")).toContainText("Notes from what he says");
    await expect(page.locator(".staff-col.now .tnote")).toHaveText("2i");
    await expect(page.locator("#strip-tip")).toContainText("third string second fret with index");
    await page.evaluate(() => (window as any).__yt.seekTo(9.6));
    await expect(page.locator(".staff-col.now .tnote")).toHaveText("h4");
    await page.evaluate(() => (window as any).__yt.seekTo(13.6));
    // a slide: drawn as a line up from the note before, the fret plain
    await expect(page.locator(".staff-col.now .tnote.slide-up")).toHaveText("7");
    await shot(page, "26-tab-strip", info.project.name);

    // Fix the slide: it's really the 8th fret on the 2nd string.
    await page.locator(".staff-col.now .tnote").click();
    await expect(page.locator("#note-sheet")).toBeVisible();
    await expect(page.locator("#lesson-play")).toHaveAttribute("aria-label", "Play"); // paused to fix
    await expect(page.locator("#note-said")).toContainText("slide to seventh fret");
    await page.click("#note-fret-up");
    await page.locator("#note-strings button", { hasText: "2 B" }).click();
    await shot(page, "27-note-editor", info.project.name);
    await page.click("#note-save");
    await expect(page.locator(".tnote.yours")).toHaveText("/8");
    await expect(page.locator('.staff-cell:nth-child(2) .tnote.yours')).toHaveCount(1); // 2nd string row

    // Add a note at this moment
    await page.click("#strip-add");
    await expect(page.locator("#note-title")).toContainText("New note at 0:13");
    await page.click("#note-fret-up");
    await page.click("#note-save");
    await expect(page.locator("#toast")).toHaveText("Note added");

    // Saved to the account
    await expect.poll(() => (db.fretline_tab_fixes[0]?.fixes as any)?.added?.length ?? 0, { timeout: 10_000 }).toBe(1);
    const fixes = db.fretline_tab_fixes[0].fixes as any;
    expect(Object.values(fixes.edits)).toEqual([{ string: 2, fret: 8, tech: "slide" }]);

    // Still there after a reload
    await page.reload();
    await page.locator(".lesson-open").click();
    await page.waitForFunction(() => (window as any).__yt);
    await page.evaluate(() => (window as any).__yt.seekTo(13.6));
    await page.click("#lesson-play");
    await expect(page.locator(".tnote.yours")).toHaveCount(2);

    // Delete the one he said wrong
    await page.locator(".tnote", { hasText: "h4" }).click();
    await page.click("#note-delete");
    await expect(page.locator(".tnote", { hasText: "h4" })).toHaveCount(0);
  });

  test("tap the strip to pause and play", async ({ page }) => {
    await fakeSupabase(page);
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "ZeeuvgrDUeQ");
    await page.click('#add-lesson-form button[type="submit"]');
    await expect(page.locator(".tnote").first()).toBeVisible();
    await page.locator("#strip-staff").click({ position: { x: 300, y: 10 } });
    await expect(page.locator("#lesson-play")).toHaveAttribute("aria-label", "Pause");
    await page.locator("#strip-staff").click({ position: { x: 300, y: 10 } });
    await expect(page.locator("#lesson-play")).toHaveAttribute("aria-label", "Play");
  });
});

test("account not set up yet: everything stays on the phone, menu says so", async ({ page }) => {
  await fakeSupabase(page, { tablesMissing: true });
  await page.goto("/");
  await page.click('.tab[data-view="lessons"]');
  await page.fill("#lesson-link", "ZeeuvgrDUeQ");
  await page.click('#add-lesson-form button[type="submit"]');
  await expect(page.locator("#lesson-title")).toHaveText("Neon intro, fingerstyle lesson");
  await page.click("#lesson-menu");
  await expect(page.locator("#sync-line")).toContainText("one-time setup", { timeout: 10_000 });
});

test.describe("reading tab from the video", () => {
  const gray = readFileSync("tests/fixtures/frames/love-story-2.gray640.b64", "utf8");
  const ocr = JSON.parse(readFileSync("tests/fixtures/frames/love-story-2.ocr.json", "utf8"));

  test("on Wi-Fi: reads the tab, times it by the cursor, deletes the video", async ({ page }, info) => {
    const db = await fakeSupabase(page);
    await fakeTabScan(page, gray, ocr);
    await page.addInitScript(() => ((window as any).__fretlineFakeConnection = "wifi"));
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "https://youtu.be/2Lq784V-KPw"); // no captions
    await page.click('#add-lesson-form button[type="submit"]');
    await expect(page.locator(".strip-empty")).toContainText("Read video tab");
    await page.click("#scan-btn");
    await expect(page.locator("#scan-row")).toBeVisible();
    await expect(page.locator("#toast")).toContainText(/Read \d+ notes from the video's tab/, { timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__scanCalls)).toEqual(["download", "overview", "features", "areas", "audio", "deleteVideo"]);
    await expect(page.locator("#scan-btn")).toBeHidden();

    await page.waitForFunction(() => (window as any).__yt);
    await page.evaluate(() => (window as any).__yt.seekTo(6));
    await page.click("#lesson-play");
    await expect(page.locator("#strip-label")).toContainText("Tab from the video");
    const cols = await page.locator(".staff-col[data-col]").count();
    expect(cols).toBeGreaterThan(15);
    // The cursor was 40% across at 6 s: about 40% of the notes are done.
    const done = await page.locator(".staff-col.done").count();
    expect(done / cols).toBeGreaterThan(0.25);
    expect(done / cols).toBeLessThan(0.55);
    await expect(page.locator("#strip-picture")).toBeVisible();
    await expect(page.locator("#strip-label")).toContainText("page 1 of 1");
    // The tape glides with the video (no jumps back to the start).
    const left = () => page.locator("#strip-staff").evaluate((el) => el.scrollLeft);
    const a = await left();
    await page.waitForTimeout(700);
    const b = await left();
    const max = await page.locator("#strip-staff").evaluate((el) => el.scrollWidth - el.clientWidth);
    if (a < max - 1) expect(b).toBeGreaterThan(a); // (a wide screen may already show the end)
    await shot(page, "28-screen-tab", info.project.name);

    // Each page read at five moments; the details can be sent for checking.
    const report = await page.evaluate(() => (window as any).__scanReport);
    expect(report.readings.length).toBe(report.merged.length * 5);
    // the sound was listened to (here it's only clicks, so the times stay)
    expect(report.sync).toBeTruthy();
    await page.click("#strip-picture");
    await page.click("#strip-share");
    expect(await page.evaluate(() => (window as any).__shared)).toBe(true);

    // Saved with the lesson's tab (and to the account)
    await expect.poll(() => ((db.fretline_tab_fixes[0]?.fixes as any)?.screen?.notes?.length ?? 0), { timeout: 10_000 }).toBeGreaterThan(15);
  });

  test("note by note: stops on each note showing it, then plays it; 0.25× speed", async ({ page }, info) => {
    await fakeSupabase(page);
    await fakeTabScan(page, gray, ocr);
    await page.addInitScript(() => ((window as any).__fretlineFakeConnection = "wifi"));
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.click("#scan-btn");
    await expect(page.locator("#toast")).toContainText(/Read \d+ notes/, { timeout: 15_000 });
    await page.waitForFunction(() => (window as any).__yt);

    await page.selectOption("#lesson-speed", "0.25");
    expect(await page.evaluate(() => (window as any).__yt.rate)).toBe(0.25);
    await page.selectOption("#lesson-speed", "1");

    await page.click("#lesson-step");
    await expect(page.locator("#lesson-step")).toHaveAttribute("aria-pressed", "true");
    // the app plays each note itself while the video waits (can be turned off)
    await expect(page.locator("#strip-pluck")).toHaveText("Pluck: on");
    // only Fretline's sound: the video is muted while it's on
    await expect.poll(() => page.evaluate(() => (window as any).__yt.muted)).toBe(true);
    await page.evaluate(() => {
      const w = window as any;
      w.__plucks = 0;
      const orig = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...a: any[]) {
        w.__plucks++;
        return orig.apply(this, a as any);
      };
    });
    await page.evaluate(() => (window as any).__yt.seekTo(3));
    await page.click("#lesson-play");
    // It pauses on the next note with a card over the video saying what it
    // is (YouTube's own pause buttons stay hidden under it)…
    await expect(page.locator("#video-hold")).toBeVisible({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => (window as any).__plucks)).toBeGreaterThan(0);
    await expect(page.locator("#video-hold-note")).toContainText(/string/);
    await expect(page.locator("#lesson-play")).not.toHaveClass(/is-playing/);
    const held = await page.evaluate(() => (window as any).__yt.t);
    await shot(page, "30-note-by-note", info.project.name);
    // …then it plays on from there (no jump back) to the next note.
    await expect.poll(() => page.evaluate(() => (window as any).__yt.t), { timeout: 4000 }).toBeGreaterThan(held);
  });

  test("a slide is drawn as a line from the note before (3 → 5 rises)", async ({ page }, info) => {
    await fakeSupabase(page);
    await page.addInitScript(() => {
      const n = (t: number, string: number, fret: number, tech?: string) => ({ id: `v${t * 10}-${string}`, t, string, fret, source: "screen", ...(tech ? { tech } : {}) });
      const screen = {
        at: 1,
        v: 99,
        notes: [n(2, 2, 3), n(2.5, 2, 5, "slide"), n(3, 3, 2), n(3.5, 2, 3), n(4, 2, 1, "slide"), n(4.5, 6, 0, "mute")],
        pages: [{ start: 1.5, end: 6, notes: 6 }],
      };
      localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen }));
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.waitForFunction(() => (window as any).__yt);
    await page.evaluate(() => (window as any).__yt.seekTo(2.6));
    await expect(page.locator(".tnote.slide-up")).toHaveText("5");
    await expect(page.locator(".tnote.slide-down")).toHaveText("1");
    await expect(page.locator(".tnote", { hasText: "x" })).toHaveCount(1);
    await shot(page, "31-slides", info.project.name);
  });

  test("My notes: the tab in notebook style, numbered lines to tick off and tap to play", async ({ page }, info) => {
    await fakeSupabase(page);
    await page.addInitScript(() => {
      const n = (t: number, string: number, fret: number, extra: object = {}) => ({ id: `v${Math.round(t * 100)}-${string}`, t, string, fret, source: "screen", ...extra });
      const notes = [] as object[];
      for (let i = 0; i < 18; i++) notes.push(n(2 + i * 0.4, 1 + (i % 3), i % 4));
      notes.push(n(10, 4, 2), n(10, 3, 0), n(10.5, 2, 3), n(10.8, 2, 5, { tech: "slide" }));
      const screen = { at: 1, v: 99, notes, pages: [{ start: 1.5, end: 12, notes: notes.length }], chords: [{ t: 2, name: "Am" }] };
      if (!localStorage.getItem("fretline:fixes:2Lq784V-KPw")) localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen }));
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.waitForFunction(() => (window as any).__yt);
    await page.click('.lesson-tabs button[data-pane="notebook"]');
    const lines = page.locator("#nb-lines .nb-line");
    await expect(lines).toHaveCount(3);
    await expect(lines.first().locator(".nb-no")).toHaveText("1");
    await expect(lines.first().locator(".nb-cells .nb-top").first()).toHaveText("[Am]");
    await expect(page.locator(".nb-cell .nb-top", { hasText: "3→5" })).toHaveCount(1);
    await expect(page.locator(".nb-cell .nb-top", { hasText: "2+0" })).toHaveCount(1);
    // tap the chord name: its shape, as a chord box
    await page.click('#nb-lines .nb-chordtag[data-chord="Am"]');
    await expect(page.locator("#chord-sheet")).toBeVisible();
    await expect(page.locator("#chord-title")).toHaveText("Am");
    await expect(page.locator("#chord-body .chord-box").first()).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, "34-chord-shape", info.project.name);
    await page.keyboard.press("Escape");
    await page.locator("#sheet-backdrop").click({ force: true }).catch(() => {});
    await expect(page.locator("#chord-sheet")).toBeHidden();
    await lines.nth(1).locator(".nb-tick").click();
    await expect(page.locator("#nb-progress")).toHaveText("1 of 3 lines done");
    await lines.nth(2).locator(".nb-play").click();
    await expect.poll(() => page.evaluate(() => (window as any).__yt.t)).toBeGreaterThan(5);
    await shot(page, "32-my-notes", info.project.name);
    await page.reload();
    await page.click('.tab[data-view="lessons"]');
    await page.click(".lesson-open");
    await page.click('.lesson-tabs button[data-pane="notebook"]');
    await expect(page.locator("#nb-progress")).toHaveText("1 of 3 lines done");
    await expect(page.locator("#nb-lines .nb-line.done .nb-no")).toHaveText("2");
  });

  test("Practice: the app takes over; climbs 1 by 1 → slow pluck → the video faster", async ({ page }, info) => {
    await fakeSupabase(page);
    await page.addInitScript(() => {
      const n = (t: number, string: number, fret: number, extra: object = {}) => ({ id: `v${Math.round(t * 100)}-${string}`, t, string, fret, source: "screen", ...extra });
      const notes = [] as object[];
      for (let i = 0; i < 24; i++) notes.push(n(2 + i * 0.25, 1 + (i % 3), [3, 2, 0, 1][i % 4]));
      notes.push(n(9, 5, 3, { strum: "down" }), n(9, 4, 2), n(9, 3, 0), n(9, 2, 1));
      const screen = { at: 1, v: 99, notes, pages: [{ start: 1.5, end: 12, notes: notes.length }], chords: [{ t: 9, name: "C" }], capo: 0 };
      localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen }));
      const w = window as any;
      w.__plucks = 0;
      const orig = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...a: any[]) {
        w.__plucks++;
        return orig.apply(this, a as any);
      };
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.waitForFunction(() => (window as any).__yt);
    await expect(page.locator("#strip-practice")).toBeVisible();
    await page.click("#strip-practice");
    await expect(page.locator("#practice")).toBeVisible();
    await expect(page.locator(".pr-rung")).toHaveText(["1 by 1", "0.25×", "0.5×", "0.75×", "1×"]);
    await expect(page.locator(".pr-rung.now")).toHaveText("1 by 1");
    // start: Fretline plays the notes, the video stays paused and muted
    await page.click("#pr-play");
    await expect(page.locator("#pr-now")).toContainText(/e|B|G/, { timeout: 4000 });
    await expect.poll(() => page.evaluate(() => (window as any).__plucks)).toBeGreaterThan(5);
    expect(await page.evaluate(() => (window as any).__yt.muted)).toBe(true);
    await expect(page.locator(".fretboard .fb-dot.now, .fretboard .fb-open.now").first()).toBeAttached();
    // the note being played is lit, not the chord name or held shape
    await expect(page.locator("#pr-line .nb-cell.lit")).toHaveCount(1);
    await expect(page.locator("#pr-line .nb-cell.lit.nb-chordtag")).toHaveCount(0);
    await shot(page, "33-practice", info.project.name);
    // up to the video's sound at 0.5×: the video plays from the part, unmuted
    await page.click("#pr-up");
    await page.click("#pr-up");
    await expect(page.locator(".pr-rung.now")).toHaveText("0.5×");
    await expect.poll(() => page.evaluate(() => (window as any).__yt.rate)).toBe(0.5);
    // a silent run-up, then the video's sound from the first note of the line
    await expect.poll(() => page.evaluate(() => (window as any).__yt.muted), { timeout: 5000 }).toBe(false);
    // and it stops before the notes after the line
    await expect.poll(() => page.evaluate(() => (window as any).__yt.state), { timeout: 10_000 }).toBe(2);
    const stoppedAt = await page.evaluate(() => (window as any).__yt.t);
    expect(stoppedAt).toBeLessThan(4.0); // line 1 is 2.0–3.75 s; the next note is at 4.0
    // next line
    await page.click("#pr-next-line");
    await expect(page.locator("#pr-from")).toHaveValue("2");
    // stop at 0.75×
    await page.click('.pr-seg[data-opt="goal"] button[data-v="0.75"]');
    await expect(page.locator(".pr-rung")).toHaveText(["1 by 1", "0.25×", "0.5×", "0.75×"]);
    // back closes it
    await page.click("#pr-close");
    await expect(page.locator("#practice")).toBeHidden();
  });

  test("Practice, Listen to me: 1 by 1 waits until it hears the right note", async ({ page }) => {
    await fakeSupabase(page);
    await fakeMic(page);
    await page.addInitScript(() => {
      const n = (t: number, string: number, fret: number) => ({ id: `v${Math.round(t * 100)}-${string}`, t, string, fret, source: "screen" });
      // e fret 3 (G4), B fret 1 (C4), G fret 2 (A3)
      const notes = [n(2, 1, 3), n(2.5, 2, 1), n(3, 3, 2)];
      const screen = { at: 1, v: 99, notes, pages: [{ start: 1.5, end: 6, notes: 3 }], capo: 0 };
      localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen }));
      localStorage.setItem("fretline:practice-listen", "true");
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.waitForFunction(() => (window as any).__yt);
    await page.click("#strip-practice");
    await expect(page.locator('.pr-seg[data-opt="listen"] button[data-v="on"]')).toHaveAttribute("aria-pressed", "true");
    await page.click("#pr-play");
    await expect(page.locator("#pr-now")).toHaveText("e 3");
    await expect(page.locator("#pr-wait")).toHaveText("Your turn: play it", { timeout: 4000 });
    // it waits: nothing played, no moving on
    await page.waitForTimeout(800);
    await expect(page.locator("#pr-now")).toHaveText("e 3");
    // a wrong note: it says what it heard
    await page.evaluate(() => (window as any).__mic.set(440));
    await expect(page.locator("#pr-wait")).toContainText("Heard A:", { timeout: 3000 });
    // the right one: on to the next note
    await page.evaluate(() => (window as any).__mic.set(392));
    await expect(page.locator("#pr-now")).toHaveText("B 1", { timeout: 4000 });
    // tap the note to skip one
    await expect(page.locator("#pr-wait")).toHaveText("Your turn: play it", { timeout: 4000 });
    await page.click("#pr-note-card");
    await expect(page.locator("#pr-now")).toHaveText("G 2", { timeout: 3000 });
    await expect(page.locator("#pr-wait")).toHaveText("Your turn: play it", { timeout: 4000 });
    await page.evaluate(() => (window as any).__mic.set(0));
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__mic.set(220));
    await expect(page.locator(".toast")).toContainText("1 of 3 right first time", { timeout: 4000 });
    // at 0.25× it's the same game with Fretline's own pluck: it plays the bit, goes quiet, you play it back
    await page.click("#pr-play");
    await page.click('.pr-seg[data-opt="start"] button[data-v="0.25"]');
    await expect(page.locator(".pr-rung.now")).toHaveText("0.25×");
    await expect(page.locator("#pr-stage")).toContainText("Fretline's pluck plays a bit, then you");
    await page.evaluate(() => {
      const w = window as any;
      w.__plucks = 0;
      const orig = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...a: any[]) {
        w.__plucks++;
        return orig.apply(this, a as any);
      };
    });
    await page.click("#pr-play");
    await expect(page.locator("#pr-wait")).toContainText("Listen", { timeout: 3000 });
    // its three notes are played (the fake mic's room noise is one more sound source)
    await expect.poll(() => page.evaluate(() => (window as any).__plucks)).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => (window as any).__yt.state)).not.toBe(1); // the video stays out of it
    await expect(page.locator("#pr-wait")).toContainText("Your turn: play those 3 notes", { timeout: 10_000 });
    await page.evaluate(() => (window as any).__mic.set(392));
    await expect(page.locator("#pr-line .nb-cell.heard")).toHaveCount(1, { timeout: 4000 });
    await expect(page.locator("#pr-wait")).toContainText("Keep going: 2 more");
    // you stop playing: after a few seconds it moves on, the rest marked missed
    await page.evaluate(() => (window as any).__mic.set(0));
    await expect(page.locator(".toast")).toContainText("heard 1 of 3", { timeout: 8000 });
    // at 0.5× (the video's sound): it plays the part, stops, and you play it back
    await page.click("#pr-play");
    await page.click('.pr-seg[data-opt="start"] button[data-v="0.5"]');
    await expect(page.locator("#pr-stage")).toContainText("video sound plays a bit, then you");
    await page.click("#pr-play");
    await expect(page.locator("#pr-wait")).toContainText("Listen", { timeout: 3000 });
    expect(await page.evaluate(() => (window as any).__yt.rate)).toBe(0.5);
    await expect(page.locator("#pr-wait")).toContainText("Your turn: play those 3 notes", { timeout: 10_000 });
    expect(await page.evaluate(() => (window as any).__yt.state)).toBe(2);
    for (const f of [392, 261.63, 220]) {
      await page.evaluate((x) => (window as any).__mic.set(x), f);
      await page.waitForTimeout(700);
    }
    await expect(page.locator(".toast")).toContainText("heard 3 of 3", { timeout: 5000 });
  });

  test("Practice, Listen to me: one ringing note doesn't count for the same note played again", async ({ page }) => {
    await fakeSupabase(page);
    await fakeMic(page);
    await page.addInitScript(() => {
      const n = (t: number, string: number, fret: number) => ({ id: `v${Math.round(t * 100)}-${string}`, t, string, fret, source: "screen" });
      // a player that's slow like the real one: jumps and pauses land late, a coarse clock
      (window as any).__ytLag = { seek: 300, pause: 500, clock: 250 };
      // G string fret 2 (A3, 220 Hz) three times
      const notes = [n(2, 3, 2), n(2.5, 3, 2), n(3, 3, 2)];
      const screen = { at: 1, v: 99, notes, pages: [{ start: 1.5, end: 6, notes: 3 }], capo: 0 };
      localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen }));
      localStorage.setItem("fretline:practice-listen", "true");
      localStorage.setItem("fretline:practice", JSON.stringify({ start: 0.5, goal: 1, pace: "normal", sound: "auto" }));
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.waitForFunction(() => (window as any).__yt);
    await page.click("#strip-practice");
    await page.click("#pr-play");
    // it plays the bit from the video first (sound on from the first note), and only then is it your turn
    await expect(page.locator("#pr-wait")).toContainText("Listen", { timeout: 3000 });
    await expect.poll(() => page.evaluate(() => (window as any).__yt.muted), { timeout: 5000 }).toBe(false);
    await expect(page.locator("#pr-wait")).toContainText("Your turn: play those 3 notes", { timeout: 12_000 });
    expect(await page.evaluate(() => (window as any).__yt.state)).toBe(2);
    expect(await page.evaluate(() => (window as any).__yt.t)).toBeGreaterThan(3.0); // all three notes were played to you
    // one pluck, left ringing: one note heard, not three
    await page.evaluate(() => (window as any).__mic.set(220));
    await expect(page.locator("#pr-wait")).toContainText("Keep going: 2 more", { timeout: 3000 });
    await page.waitForTimeout(1200);
    await expect(page.locator("#pr-line .nb-cell.heard")).toHaveCount(1);
    // plucked again: the second one
    await page.evaluate(() => (window as any).__mic.set(0));
    await page.waitForTimeout(250);
    await page.evaluate(() => (window as any).__mic.set(220));
    await expect(page.locator("#pr-wait")).toContainText("Keep going: 1 more", { timeout: 3000 });
  });

  test("Practice with a slow player (like the real one): rounds aren't skipped, and the stop is learned", async ({ page }) => {
    test.setTimeout(70_000);
    await fakeSupabase(page);
    await page.addInitScript(() => {
      // a jump lands 300 ms late, a pause 900 ms late, the clock is told 4 times a second
      (window as any).__ytLag = { seek: 300, pause: 900, clock: 250 };
      const n = (t: number, string: number, fret: number) => ({ id: `v${Math.round(t * 100)}-${string}`, t, string, fret, source: "screen" });
      const notes = [] as object[];
      for (let i = 0; i < 24; i++) notes.push(n(2 + i * 0.25, 1 + (i % 3), [3, 2, 0, 1][i % 4]));
      const screen = { at: 1, v: 99, notes, pages: [{ start: 1.5, end: 12, notes: notes.length }], capo: 0 };
      localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen }));
      localStorage.setItem("fretline:practice", JSON.stringify({ start: 0.5, goal: 1, pace: "slow", sound: "auto" }));
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.waitForFunction(() => (window as any).__yt);
    await page.click("#strip-practice");
    await page.click("#pr-up");
    await page.click("#pr-up");
    await expect(page.locator(".pr-rung.now")).toHaveText("1×");
    await page.click("#pr-play");
    // line 1 is 2.0–3.75 s and the next line starts at 4.0 s. A round takes
    // ~5 s here (jump, run-up, the line, the stop landing, the gap): after 7 s
    // it's in its second round, not rushed through several
    await page.waitForTimeout(7000);
    expect(await page.locator("#pr-stage").textContent()).toContain("round 2 of 4");
    expect(await page.evaluate(() => ((window as any).__yt.stops ?? []).length)).toBe(1);
    // the first stop came late (the next line's first note was heard); it learns
    await expect.poll(() => page.evaluate(() => ((window as any).__yt.stops ?? []).length), { timeout: 40_000 }).toBeGreaterThanOrEqual(4);
    const stops = await page.evaluate(() => (window as any).__yt.stops as number[]);
    expect(stops[0]).toBeGreaterThan(4.0);
    for (const k of [1, 2, 3]) {
      expect(stops[k]).toBeLessThanOrEqual(4.0);
      expect(stops[k]).toBeGreaterThan(3.75); // the line's own last note still sounds
    }
  });

  test("Practice list on the lessons page: next line, progress, best speed; Practice opens there", async ({ page }) => {
    await fakeSupabase(page);
    await page.addInitScript(() => {
      const n = (t: number, string: number, fret: number) => ({ id: `v${Math.round(t * 100)}-${string}`, t, string, fret, source: "screen" });
      const notes = [] as object[];
      for (let i = 0; i < 30; i++) notes.push(n(2 + i * 0.3, 1 + (i % 3), i % 4));
      const d = new Date();
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const progress = { done: [1], best: { "2": 0.75 }, days: { [key]: 600 }, last: { line: 2, at: Date.now() } };
      const screen = { at: 1, v: 99, notes, pages: [{ start: 1.5, end: 12, notes: 30 }] };
      localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen, progress }));
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.waitForFunction(() => (window as any).__yt);
    await page.click("#lesson-back");
    await expect(page.locator("#today")).toBeVisible();
    await expect(page.locator("#today-stats")).toContainText("1 day in a row · 10 min today");
    await expect(page.locator(".today-row .muted")).toContainText("line 2 of 4 · 1 done · best here 0.75×");
    await page.click(".today-go");
    await expect(page.locator("#practice")).toBeVisible();
    await expect(page.locator("#pr-from")).toHaveValue("2");
  });

  test("the tape stays where you scroll it, until Back to now", async ({ page }) => {
    await fakeSupabase(page);
    await fakeTabScan(page, gray, ocr);
    await page.addInitScript(() => ((window as any).__fretlineFakeConnection = "wifi"));
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.click("#scan-btn");
    await expect(page.locator("#toast")).toContainText(/Read \d+ notes/, { timeout: 15_000 });
    await page.waitForFunction(() => (window as any).__yt);
    await page.evaluate(() => (window as any).__yt.seekTo(3));
    await page.click("#lesson-play");
    await page.waitForTimeout(500);
    const max = await page.locator("#strip-staff").evaluate((el) => el.scrollWidth - el.clientWidth);
    test.skip(max < 40, "the whole tape fits on this screen");
    // scroll away from where the app put it
    await page.locator("#strip-staff").evaluate((el) => (el.scrollLeft = el.scrollLeft > 20 ? 0 : el.scrollWidth));
    await expect(page.locator("#strip-follow")).toBeVisible();
    const left = await page.locator("#strip-staff").evaluate((el) => el.scrollLeft);
    await page.waitForTimeout(3000);
    expect(await page.locator("#strip-staff").evaluate((el) => el.scrollLeft)).toBe(left);
    await page.click("#strip-follow");
    await expect(page.locator("#strip-follow")).toBeHidden();
    await expect.poll(() => page.locator("#strip-staff").evaluate((el) => el.scrollLeft)).not.toBe(left);
  });

  test("on mobile data: asks first; waiting for Wi-Fi starts it later", async ({ page }) => {
    await fakeSupabase(page);
    await fakeTabScan(page, gray, ocr);
    await page.addInitScript(() => ((window as any).__fretlineFakeConnection = "cellular"));
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.click("#scan-btn");
    await expect(page.locator("#scan-sheet")).toBeVisible();
    await expect(page.locator("#scan-sheet-text")).toContainText("about 42 MB");
    await page.click("#scan-wait");
    await expect(page.locator("#scan-sheet")).toBeHidden();
    expect(await page.evaluate(() => (window as any).__scanCalls)).toEqual([]);
    await page.evaluate(() => ((window as any).__fretlineFakeConnection = "wifi"));
    await expect.poll(() => page.evaluate(() => (window as any).__scanCalls.length), { timeout: 12_000 }).toBeGreaterThan(0);
  });

  test("a lesson read by the older reader can be read again, at 720p", async ({ page }) => {
    await fakeSupabase(page);
    await fakeTabScan(page, gray, ocr);
    await page.addInitScript(() => {
      (window as any).__fretlineFakeConnection = "wifi";
      const old = { at: 1, notes: [{ id: "v10-2", t: 1, string: 2, fret: 3, source: "screen" }], pages: [{ start: 0, end: 5, notes: 1 }] };
      localStorage.setItem("fretline:fixes:2Lq784V-KPw", JSON.stringify({ edits: {}, added: [], updatedAt: 1, screen: old }));
    });
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await expect(page.locator("#scan-btn")).toHaveText("Read again");
    await page.click("#scan-btn");
    await expect(page.locator("#toast")).toContainText(/Read \d+ notes/, { timeout: 15_000 });
    await expect(page.locator("#scan-btn")).toBeHidden();
    expect(await page.evaluate(() => (window as any).__scanHeight)).toBe(720);
  });

  test("pictures that aren't the page shown at that moment are thrown away", async ({ page }) => {
    await fakeSupabase(page);
    await fakeTabScan(page, gray, ocr, { staleBefore: 6 });
    await page.addInitScript(() => ((window as any).__fretlineFakeConnection = "wifi"));
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.click("#scan-btn");
    await expect(page.locator("#toast")).toContainText(/Read \d+ notes/, { timeout: 15_000 });
    const report = await page.evaluate(() => (window as any).__scanReport);
    const wrong = report.readings.filter((r: any) => r.wrongFrame).map((r: any) => r.t);
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong.every((t: number) => t < 6)).toBe(true);
  });

  test("a video without on-screen tab says so", async ({ page }) => {
    await fakeSupabase(page);
    await fakeTabScan(page, gray, ocr, { noTab: true });
    await page.addInitScript(() => ((window as any).__fretlineFakeConnection = "wifi"));
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await page.fill("#lesson-link", "2Lq784V-KPw");
    await page.click('#add-lesson-form button[type="submit"]');
    await page.click("#scan-btn");
    await expect(page.locator("#toast")).toHaveText("No tab shown on screen in this video.", { timeout: 10_000 });
    await expect(page.locator(".strip-empty")).toContainText("No tab shown on screen in this video.");
    const calls: string[] = await page.evaluate(() => (window as any).__scanCalls);
    expect(calls).toContain("deleteVideo");
    expect(calls.filter((c) => c === "download").length).toBe(1);
  });
});
