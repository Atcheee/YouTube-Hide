const { chromium } = require("playwright-core");
const { readFileSync, existsSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const extension = join(__dirname, "..");
  const executablePath = [process.env.CRUNCHYROLL_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  if (!executablePath) throw new Error("Set CRUNCHYROLL_TEST_BROWSER to a Chromium browser executable.");
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "playback-keys-")), {
    executablePath, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await worker.evaluate(() => chrome.storage.sync.set({ crunchyrollFiveSecondSeekEnabled: true }));
    const fixture = readFileSync(join(extension, "tests/fixtures/crunchyroll-speed-player.html"), "utf8");
    const page = context.pages()[0];
    await page.route("https://www.crunchyroll.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <script>
        window.nativeArrows = 0;
        // The application installs this before document_idle content scripts.
        window.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          nativeArrows++;
          document.querySelector('video').currentTime += event.key === 'ArrowLeft' ? -10 : 10;
          event.preventDefault();
        }, true);
      </script>${fixture}` }));
    await page.goto("https://www.crunchyroll.com/watch/KEYS");
    const wave = Buffer.alloc(44 + 16000 * 60 * 2);
    wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28);
    wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    await page.evaluate(source => { document.querySelector("video").src = source; }, `data:audio/wav;base64,${wave.toString("base64")}`);
    await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
    await page.evaluate(async () => {
      const video = document.querySelector("video");
      video.currentTime = 30;
      await new Promise(resolve => video.addEventListener("seeked", resolve, { once: true }));
    });
    await page.getByRole("button", { name: "Play", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator("video").evaluate(video => video.currentTime), 25, "The first press with Play focused must seek exactly five seconds");
    await page.getByRole("slider", { name: "Timeline", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("video").evaluate(video => video.currentTime), 30);
    for (let i = 0; i < 4; i++) await page.keyboard.down("ArrowLeft");
    await page.keyboard.up("ArrowLeft");
    assert.equal(await page.locator("video").evaluate(video => video.currentTime), 10, "Held-key repeats must each use five seconds");
    assert.equal(await page.evaluate(() => nativeArrows), 0, "Native ten-second handlers must never run alongside custom seeking");
    await worker.evaluate(() => chrome.storage.sync.set({ crunchyrollFiveSecondSeekEnabled: false }));
    await page.getByRole("button", { name: "Jump forward 10 seconds", exact: true }).waitFor();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => nativeArrows), 1);
    assert.equal(await page.locator("video").evaluate(video => video.currentTime), 20);
    console.log("Passed: first arrow press, focused Play/timeline controls, repeated keys, early native-capture conflict, and immediate native restoration when disabled.");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
