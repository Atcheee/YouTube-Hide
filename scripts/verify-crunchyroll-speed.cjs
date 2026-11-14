const { chromium } = require("playwright-core");
const { readFileSync, existsSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");

function silentWave(seconds) {
  const sampleRate = 16000;
  const dataSize = sampleRate * seconds * 2;
  const data = Buffer.alloc(44 + dataSize);
  data.write("RIFF", 0); data.writeUInt32LE(36 + dataSize, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(dataSize, 40);
  return `data:audio/wav;base64,${data.toString("base64")}`;
}

(async () => {
  const executablePath = [process.env.CRUNCHYROLL_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  if (!executablePath) throw new Error("Set CRUNCHYROLL_TEST_BROWSER to a Chromium browser executable.");
  const extensionPath = join(__dirname, "..");
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "youtube-hide-browser-")), {
    executablePath, headless: true, viewport: { width: 1280, height: 800 },
    args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const fixture = readFileSync(join(__dirname, "..", "tests", "fixtures", "crunchyroll-speed-player.html"), "utf8");
    const html = `<style>
      html,body{margin:0;background:#111;color:white;font-family:Arial}
      #player-container{position:relative;width:100%;height:720px;background:linear-gradient(135deg,#3b3030,#161b24)}
      video{position:absolute;width:100%;height:100%}
      .player-overlay{position:absolute;inset:0}
      [data-testid=bottom-right-controls-stack]{position:absolute;right:24px;bottom:24px;display:flex;gap:12px;align-items:center}
      [data-testid=bottom-right-controls-stack] button{background:transparent;color:white;border:0;font:600 18px Arial;min-width:48px;height:48px;cursor:pointer}
      .speed-wrapper{border-bottom:3px solid white}
    </style>${fixture}`;
    // Serve a local fixture through routing. No Crunchyroll account or network
    // player is used, but the real extension's host matching and storage execute.
    await page.route("**/*", (route) => {
      if (route.request().url().startsWith("https://www.crunchyroll.com/watch/SPEEDTEST/")) {
        return route.fulfill({ contentType: "text/html", body: html });
      }
      return route.abort();
    });
    await page.goto("https://www.crunchyroll.com/watch/SPEEDTEST/local-fixture");
    await page.evaluate((source) => { document.querySelector("video").src = source; }, silentWave(12));
    await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
    await page.getByTestId("playback-speed-button").click();
    const header = await page.locator(".youtube-hide-speed-header").evaluate((element) => {
      const button = element.querySelector("button").getBoundingClientRect();
      const title = element.querySelector("h2").getBoundingClientRect();
      return { height: element.getBoundingClientRect().height, buttonWidth: button.width,
        buttonHeight: button.height, centerDifference: Math.abs(button.y + button.height / 2 - title.y - title.height / 2) };
    });
    assert.equal(header.height, 56);
    assert.equal(header.buttonWidth, 32);
    assert.equal(header.buttonHeight, 32);
    assert.ok(header.centerDifference < 1);
    await page.getByRole("button", { name: "2 times normal speed", exact: true }).click();
    assert.equal(await page.locator("video").evaluate((video) => video.playbackRate), 2);
    const start = await page.locator("video").evaluate(async (video) => {
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { time: video.currentTime, clock: performance.now() };
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const end = await page.locator("video").evaluate((video) => ({ time: video.currentTime, clock: performance.now() }));
    const ratio = (end.time - start.time) / ((end.clock - start.clock) / 1000);
    assert.ok(ratio > 1.6 && ratio < 2.4, `Expected 2x real playback; measured ${ratio.toFixed(2)}x`);
    await page.getByRole("slider", { name: "Playback speed", exact: true }).press("ArrowLeft");
    assert.equal(await page.locator("video").evaluate((video) => video.playbackRate), 1.95);
    await page.getByRole("slider", { name: "Playback speed", exact: true }).press("Escape");
    await page.getByTestId("playback-speed-button").click();
    await page.getByRole("button", { name: "1.25 times normal speed", exact: true }).click();
    const screenshot = join(mkdtempSync(join(tmpdir(), "youtube-hide-speed-")), "picker.png");
    await page.screenshot({ path: screenshot });
    await page.reload();
    await page.waitForFunction(() => document.querySelector("video").playbackRate === 1.25);
    assert.equal(await page.getByTestId("playback-speed-button").textContent(), "1.25x");
    // Match Crunchyroll Speeder's observed behavior: every player DOM update
    // reapplies its saved 1.3x value, regardless of the in-player selection.
    await page.evaluate(() => {
      window.competingSpeeder = new MutationObserver(() => { document.querySelector("video").playbackRate = 1.3; });
      window.competingSpeeder.observe(document.body, { attributes: true, childList: true, subtree: true });
      window.playerTicks = setInterval(() => { document.body.dataset.playerTick = String(performance.now()); }, 50);
    });
    await page.getByTestId("playback-speed-button").click();
    await page.getByRole("button", { name: "2 times normal speed", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".youtube-hide-speed-error").textContent.includes("Disable Crunchyroll Speeder"));
    assert.equal(await page.locator("video").evaluate((video) => video.playbackRate), 1.3);
    await page.evaluate(() => { competingSpeeder.disconnect(); clearInterval(playerTicks); });
    await page.getByRole("button", { name: "1.75 times normal speed", exact: true }).click();
    assert.equal(await page.locator("video").evaluate((video) => video.playbackRate), 1.75);
    assert.equal(await page.locator(".youtube-hide-speed-error").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: executablePath, extensionLoaded: true,
      measuredPlayback: `${ratio.toFixed(2)}x`, restoredAfterReload: "1.25x",
      competingExtensionDetected: true, recoveredAfterDisabling: "1.75x", screenshot }));
  } finally {
    await context.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
