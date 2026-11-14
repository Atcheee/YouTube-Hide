const { chromium } = require("playwright-core");
const { readFileSync, existsSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");

function silentWave() {
  const size = 16000 * 30 * 2;
  const data = Buffer.alloc(44 + size);
  data.write("RIFF", 0); data.writeUInt32LE(36 + size, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(size, 40);
  return `data:audio/wav;base64,${data.toString("base64")}`;
}

(async () => {
  const executablePath = [process.env.YOUTUBE_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  if (!executablePath) throw new Error("Set YOUTUBE_TEST_BROWSER to a Chromium browser executable.");
  const extension = join(__dirname, "..");
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "youtube-hide-hover-")), {
    executablePath, headless: true, viewport: { width: 1280, height: 800 },
    args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const html = readFileSync(join(__dirname, "..", "tests", "fixtures", "youtube-hover-player.html"), "utf8");
    await page.route("**/*", (route) => route.request().url().startsWith("https://www.youtube.com/watch?v=HOVERTEST")
      ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
    await page.goto("https://www.youtube.com/watch?v=HOVERTEST");
    await page.evaluate(async (source) => {
      const video = document.querySelector("video");
      video.src = source;
      await video.play();
    }, silentWave());
    await page.waitForFunction(() => hoverFixture.hovers > 0 && document.querySelector("#movie_player").dataset.nativeHover === "true");
    const beforeReturn = await page.locator(".ytp-chrome-bottom").evaluate((bar) => getComputedStyle(bar).opacity);
    const quickActionOpacity = await page.locator(".ytp-fullscreen-quick-actions").evaluate((row) => getComputedStyle(row).opacity);
    // Real browser input returns over the video while an artificial timeline hover is active.
    await page.mouse.move(500, 200);
    const afterReturn = await page.locator(".ytp-tooltip").evaluate((tooltip) => ({
      visible: getComputedStyle(tooltip).display !== "none",
      nativeHover: document.querySelector("#movie_player").dataset.nativeHover
    }));
    console.log(JSON.stringify({ unattendedBarOpacity: beforeReturn, quickActionOpacity, afterReturn }));
    assert.equal(beforeReturn, "0", "Artificial activity must not wake the unattended control bar");
    assert.equal(quickActionOpacity, "0", "Artificial activity must not show the fullscreen Like/Dislike/Comments/Share row");
    assert.equal(afterReturn.visible, false, "Returning to the video must not reveal a stale timeline thumbnail");
    assert.equal(afterReturn.nativeHover, "false", "Returning off the timeline must complete artificial leave events");
    assert.equal(await page.locator(".ytp-fullscreen-quick-actions").evaluate((row) => getComputedStyle(row).opacity), "1");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
      document.querySelector("#movie_player").dataset.nativeHover = "true";
    });
    assert.equal(await page.locator(".ytp-tooltip").evaluate((tooltip) => getComputedStyle(tooltip).display), "none");
    // Intentional timeline hover should still display the native preview.
    await page.locator(".ytp-progress-bar").hover();
    assert.notEqual(await page.locator(".ytp-tooltip").evaluate((tooltip) => getComputedStyle(tooltip).display), "none");
    await page.mouse.move(500, 200);
    assert.equal(await page.evaluate(() => hoverFixture.seeks), 0);
    await page.mouse.move(1150, 740);
    await page.evaluate(() => { hoverFixture.offerJump = true; });
    await page.waitForFunction(() => hoverFixture.jumps === 1);
    assert.equal(await page.locator(".ytp-chrome-bottom").evaluate((bar) => getComputedStyle(bar).opacity), "0");
    assert.equal(await page.locator(".ytp-tooltip").evaluate((tooltip) => getComputedStyle(tooltip).display), "none");
    assert.equal(await page.locator(".ytp-fullscreen-quick-actions").evaluate((row) => getComputedStyle(row).opacity), "0");
    assert.equal(await page.evaluate(() => hoverFixture.actions), 0);
    assert.ok(await page.evaluate(() => hoverFixture.playerLeaves > 0));
    await page.evaluate(() => { document.querySelector("video").currentTime = 0; });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await page.evaluate(() => hoverFixture.jumps), 1);
    console.log("Passed: quiet unattended controls, focus return, manual previews, automatic skip, rewind protection.");
  } finally {
    await context.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
