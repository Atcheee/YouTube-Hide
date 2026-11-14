const { chromium } = require("playwright-core");
const { readFileSync, existsSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const executablePath = [process.env.PLAYBACK_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  if (!executablePath) throw new Error("Set PLAYBACK_TEST_BROWSER to a Chromium browser executable.");
  const extension = join(__dirname, "..");
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "playback-plus-popup-")), {
    executablePath, headless: true, viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    await worker.evaluate(() => chrome.storage.sync.set({ hideShortsEnabled: false }));
    const page = context.pages()[0] || await context.newPage();
    const fixture = readFileSync(join(extension, "tests", "fixtures", "crunchyroll-speed-player.html"), "utf8");
    await page.route("**/*", (route) => route.request().url().startsWith("https://www.crunchyroll.com/watch/POPUPTEST/")
      ? route.fulfill({ contentType: "text/html", body: fixture }) : route.abort());
    await page.goto("https://www.crunchyroll.com/watch/POPUPTEST/local-fixture");
    await page.evaluate(() => {
      window.nativeClicks = 0;
      document.querySelector('[data-testid="playback-speed-button"]').addEventListener("click", () => { nativeClicks += 1; });
    });
    const popup = await context.newPage();
    const errors = [];
    popup.on("pageerror", (error) => errors.push(error.message));
    await page.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => !document.getElementById("master-toggle").disabled);
    assert.equal(await popup.locator("#shorts-toggle").isChecked(), false);
    const images = mkdtempSync(join(tmpdir(), "playback-plus-popup-images-"));
    const sizes = {};
    async function capture(site) {
      sizes[site] = await popup.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
      assert.equal(sizes[site].width, 376, "Popup must not overflow horizontally");
      assert.ok(sizes[site].height <= 600, `Default ${site} popup settings must fit within 600px; got ${sizes[site].height}px`);
      await popup.setViewportSize({ width: 376, height: sizes[site].height });
      await popup.screenshot({ path: join(images, `${site}.png`), fullPage: true, animations: "disabled" });
    }
    await popup.getByRole("tab", { name: "YouTube", exact: true }).click();
    await capture("youtube");
    await popup.getByRole("tab", { name: "Crunchyroll", exact: true }).click();
    await popup.getByRole("button", { name: "1.5x", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("video").playbackRate === 1.5);
    const toggle = (key) => popup.locator(`label:has(input[data-setting="${key}"])`).click();
    await toggle("crunchyrollSpeedEnabled");
    await page.getByTestId("playback-speed-button").click();
    assert.equal(await page.evaluate(() => nativeClicks), 1);
    await toggle("crunchyrollSpeedEnabled");
    await page.getByTestId("playback-speed-button").click();
    assert.equal(await page.locator("#youtube-hide-crunchyroll-speed").isVisible(), true);
    await toggle("extensionEnabled");
    await page.waitForFunction(() => document.getElementById("youtube-hide-crunchyroll-speed").hidden);
    await page.evaluate(() => {
      const video = document.querySelector("video");
      video.playbackRate = 1.25;
      video.dispatchEvent(new Event("ratechange"));
    });
    assert.equal(await page.locator("video").evaluate((video) => video.playbackRate), 1.25);
    await toggle("extensionEnabled");
    await page.waitForFunction(() => document.querySelector("video").playbackRate === 1.5);
    await capture("crunchyroll");
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("playback-speed").value === "1.5");
    assert.equal(await popup.locator("#shorts-toggle").isChecked(), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ extensionLoaded: true, popupControlsMedia: true, nativeMenuRestored: true,
      masterSwitchWorks: true, preferencesPreserved: true, sizes, screenshots: images }));
  } finally {
    await context.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
