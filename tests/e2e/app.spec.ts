import { expect, test } from "@playwright/test";
import { fakeMic, fakeNative, fakeRelease, fakeSupabase, shot, signedIn } from "./fakes";

const E2 = 82.4069;
const A2 = 110;
const D2 = 73.4162;
const cents = (f: number, c: number) => f * Math.pow(2, c / 1200);

test.beforeEach(async ({ page }) => {
  await fakeSupabase(page);
});

test("locked until signed in", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.locator("#entry-screen")).toBeVisible();
  await expect(page.locator("#view-tuner")).toBeHidden();
  await shot(page, "01-sign-in", info.project.name);

  await page.fill("#entry-email", "aaditya@example.com");
  await page.fill("#entry-password", "wrong-password");
  await page.click("#entry-submit");
  await expect(page.locator("#entry-error")).toHaveText("Wrong email or password.");

  await page.fill("#entry-password", "right-password");
  await page.click("#entry-submit");
  await expect(page.locator("#entry-screen")).toBeHidden();
  await expect(page.locator("#view-tuner")).toBeVisible();

  await page.click("#menu-btn");
  await expect(page.locator("#menu-name")).toHaveText("Aaditya");
  await expect(page.locator("#app-version")).toContainText("Version 0.");
  await shot(page, "02-menu", info.project.name);

  page.once("dialog", (d) => d.accept());
  await page.click("#sign-out-btn");
  await expect(page.locator("#entry-screen")).toBeVisible();
});

test.describe("tuner", () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
    await fakeMic(page);
  });

  test("reads strings in auto mode and marks them tuned", async ({ page }, info) => {
    await page.goto("/");
    await expect(page.locator(".string")).toHaveCount(6);
    await shot(page, "03-tuner-idle", info.project.name);

    await page.click("#listen-btn");
    await expect(page.locator("#listen-btn")).toHaveText("Stop listening");

    await page.evaluate((f) => (window as any).__mic.set(f), cents(A2, -12));
    await expect(page.locator("#cents")).toHaveText(/1[0-4] cents flat, tune up/);
    await expect(page.locator("#note-name")).toHaveText("A");
    await expect(page.locator("#readout")).toHaveAttribute("data-state", "off");
    await expect(page.locator('.string[data-index="1"]')).toHaveClass(/active/);
    await shot(page, "04-tuner-flat", info.project.name);

    await page.evaluate((f) => (window as any).__mic.set(f), E2);
    await expect(page.locator("#cents")).toHaveText("In tune");
    await expect(page.locator("#note-name")).toHaveText("E");
    await expect(page.locator("#note-octave")).toHaveText("2");
    await expect(page.locator('.string[data-index="0"]')).toHaveClass(/tuned/, { timeout: 4000 });
    await shot(page, "05-tuner-in-tune", info.project.name);

    // Way off: tells you what you're playing.
    await page.evaluate((f) => (window as any).__mic.set(f), cents(E2, -200));
    await expect(page.locator("#cents")).toHaveText(/That's D2\. Tune up to E2|tune up/);

    await page.evaluate(() => (window as any).__mic.set(0));
    await expect(page.locator("#readout")).toHaveAttribute("data-state", "idle", { timeout: 4000 });

    await page.click("#listen-btn");
    await expect(page.locator("#listen-btn")).toHaveText("Start listening");
  });

  test("pick a string: reads against the chosen string", async ({ page }) => {
    await page.goto("/");
    await page.click("#listen-btn");
    await page.click('.mode-btn[data-mode="manual"]');
    await page.click('.string[data-index="0"]'); // low E
    // Playing an A while tuning the low E: far off, so it names the note.
    await page.evaluate((f) => (window as any).__mic.set(f), A2);
    await expect(page.locator("#note-name")).toHaveText("E");
    await expect(page.locator("#cents")).toHaveText("That's A2. Tune down to E2");
  });

  test("drop D, a custom tuning and a song are saved", async ({ page }, info) => {
    await page.goto("/");
    await page.click("#tuning-btn");
    await expect(page.locator("#tuning-sheet")).toBeVisible();
    await shot(page, "06-tuning-sheet", info.project.name);
    await page.locator(".tuning-pick", { hasText: "Drop D" }).click();
    await expect(page.locator("#tuning-sheet")).toBeHidden();
    await expect(page.locator("#tuning-name")).toHaveText("Drop D");

    await page.click("#listen-btn");
    await page.evaluate((f) => (window as any).__mic.set(f), D2);
    await expect(page.locator("#cents")).toHaveText("In tune");
    await expect(page.locator("#note-name")).toHaveText("D");

    // New tuning: drop D with the B string down to A ("DADGAE").
    await page.click("#tuning-btn");
    await page.click("#new-tuning-btn");
    await page.fill("#editor-name", "My DADGAE");
    await page.getByRole("button", { name: "Lower string 2" }).click();
    await page.getByRole("button", { name: "Lower string 2" }).click();
    await expect(page.locator(".editor-row output").nth(1)).toHaveText("A3");
    await shot(page, "07-editor", info.project.name);
    await page.click("#editor-save");
    await expect(page.locator("#tuning-name")).toHaveText("My DADGAE");
    await expect(page.locator("#tuning-instrument")).toHaveText("Guitar, D A D G A E");

    await page.click("#tuning-btn");
    await page.fill("#song-input", "Neon");
    await page.click('#song-form button[type="submit"]');
    await expect(page.locator(".song-row")).toContainText("Neon");
    await shot(page, "08-songs", info.project.name);

    await page.reload();
    await expect(page.locator("#tuning-name")).toHaveText("My DADGAE");
    await page.click("#tuning-btn");
    await expect(page.locator(".song-row")).toContainText("My DADGAE");
    await page.locator(".tuning-pick", { hasText: "Standard" }).first().click();
    await expect(page.locator("#tuning-name")).toHaveText("Standard");
    await page.click("#tuning-btn");
    await page.locator(".song-pick", { hasText: "Neon" }).click();
    await expect(page.locator("#tuning-name")).toHaveText("My DADGAE");
  });

  test("bass and ukulele", async ({ page }) => {
    await page.goto("/");
    await page.click("#tuning-btn");
    await page.click('#instrument-tabs [data-inst="bass"]');
    await page.locator(".tuning-pick", { hasText: "Standard" }).click();
    await expect(page.locator(".string")).toHaveCount(4);
    await page.click("#listen-btn");
    await page.evaluate((f) => (window as any).__mic.set(f), 41.2034); // E1
    await expect(page.locator("#cents")).toHaveText("In tune");
    await expect(page.locator("#note-octave")).toHaveText("1");

    await page.click("#tuning-btn");
    await page.click('#instrument-tabs [data-inst="ukulele"]');
    await page.locator(".tuning-pick", { hasText: "Standard (high G)" }).click();
    await page.evaluate((f) => (window as any).__mic.set(f), 392); // G4
    await expect(page.locator("#cents")).toHaveText("In tune");
    await expect(page.locator("#note-name")).toHaveText("G");
  });

  test("hear it plays a tone and pauses the mic", async ({ page }, info) => {
    await page.goto("/");
    await page.click('.mode-btn[data-mode="tone"]');
    await expect(page.locator("#listen-btn")).toBeHidden();
    await page.check("#sustain");
    await page.click('.string[data-index="5"]');
    await expect(page.locator('.string[data-index="5"]')).toHaveClass(/playing/);
    await expect(page.locator("#cents")).toHaveText("Playing");
    await shot(page, "09-hear-it", info.project.name);
    await page.click('.string[data-index="5"]');
    await expect(page.locator('.string[data-index="5"]')).not.toHaveClass(/playing/);
  });

  test("reference pitch changes the reading", async ({ page }) => {
    await page.goto("/");
    await page.click("#a4-btn");
    for (let i = 0; i < 2; i++) await page.click("#a4-down");
    await expect(page.locator("#a4-out")).toHaveText("438 Hz");
    await page.keyboard.press("Escape");
    await expect(page.locator("#a4-value")).toHaveText("438");
    await page.click("#listen-btn");
    await page.evaluate((f) => (window as any).__mic.set(f), A2 * (438 / 440));
    await expect(page.locator("#cents")).toHaveText("In tune");
  });

  test("lessons tab explains what's coming", async ({ page }, info) => {
    await page.goto("/");
    await page.click('.tab[data-view="lessons"]');
    await expect(page.locator("#view-lessons")).toBeVisible();
    await shot(page, "10-lessons", info.project.name);
    await page.click("#go-tuner");
    await expect(page.locator("#view-tuner")).toBeVisible();
  });
});

test("buds connected: uses the phone's mic, and the mic can be switched", async ({ page }, info) => {
  await signedIn(page);
  await fakeMic(page, { buds: true });
  await page.goto("/");
  await page.click("#listen-btn");
  await expect(page.locator("#mic-btn")).toHaveText("Mic: Speakerphone");
  await page.evaluate((f) => (window as any).__mic.set(f), 110);
  await expect(page.locator("#cents")).toHaveText("In tune");
  expect(Number((await page.locator("#level-fill").evaluate((e) => (e as HTMLElement).style.width)).replace("%", ""))).toBeGreaterThan(30);
  await shot(page, "12-mic-row", info.project.name);

  // Switching to the buds' mic: nothing heard → the hint shows.
  await page.click("#mic-btn");
  await expect(page.locator("#mic-btn")).toHaveText("Mic: Bluetooth headset");
  await expect(page.locator("#mic-quiet")).toBeVisible({ timeout: 8000 });
  await page.click("#mic-btn");
  await expect(page.locator("#mic-btn")).toHaveText(/Mic: (Speakerphone|Default)/);
});

test("mic refused: says how to fix it", async ({ page }) => {
  await signedIn(page);
  await fakeMic(page, { deny: true });
  await page.goto("/");
  await page.click("#listen-btn");
  await expect(page.locator("#mic-error")).toContainText("Allow it in your phone's Settings");
  await expect(page.locator("#listen-btn")).toHaveText("Start listening");
});

test("android: update banner and back button", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await signedIn(page);
  await fakeMic(page);
  await fakeNative(page);
  await fakeRelease(page, "v9.0.0-build99");
  await page.goto("/");
  await expect(page.locator("#update-banner")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#update-version")).toHaveText("Fretline 9.0.0 is ready");
  await shot(page, "11-update-banner", info.project.name);

  await page.click("#tuning-btn");
  await expect(page.locator("#tuning-sheet")).toBeVisible();
  expect(await page.evaluate(() => (window as any).fretlineBack())).toBe(true);
  await expect(page.locator("#tuning-sheet")).toBeHidden();
  await page.click('.tab[data-view="lessons"]');
  expect(await page.evaluate(() => (window as any).fretlineBack())).toBe(true);
  await expect(page.locator("#view-tuner")).toBeVisible();
  expect(await page.evaluate(() => (window as any).fretlineBack())).toBe(false);
});

test("no update banner when already up to date", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await signedIn(page);
  await fakeNative(page);
  await fakeRelease(page, "v0.0.1-build1");
  await page.goto("/");
  await page.waitForTimeout(6000);
  await expect(page.locator("#update-banner")).toBeHidden();
});
