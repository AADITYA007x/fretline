import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { fakeLessonInfo, fakeNative, fakeSupabase, fakeYouTube, shot, signedIn } from "./fakes";

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
  await page.click("#lesson-speed");
  await expect(page.locator("#lesson-speed")).toHaveText("0.75×");
  await page.click("#lesson-speed");
  await expect(page.locator("#lesson-speed")).toHaveText("0.5×");
  expect(await page.evaluate(() => (window as any).__yt.rate)).toBe(0.5);

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
  await expect(page.locator(".pane-empty")).toHaveText("This video has no chapters.");
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
