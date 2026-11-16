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
          if (!['ArrowLeft', 'ArrowRight', 'j', 'k', 'l'].includes(event.key)) return;
          nativeArrows++;
          document.querySelector('video').currentTime += event.key === 'ArrowLeft' ? -10 : 10;
          event.preventDefault();
        }, true);
      </script><style>#player-container{position:relative;width:900px;height:550px}video{width:100%;height:100%}[data-testid=bottom-right-controls-stack]{position:absolute;right:12px;bottom:12px}.native-captions{position:absolute;bottom:2%;left:20%;height:24px}</style>${fixture}` }));
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
    // Test routing to the app's fullscreen control. Headless Brave denies the
    // actual fullscreen permission, so the fixture models the app's enter/exit state.
    await page.evaluate(() => {
      window.fullscreenToggles = 0;
      const control = document.createElement('button');
      control.id = 'fixture-fullscreen';
      control.dataset.testid = 'fullscreen-button';
      control.setAttribute('aria-label', 'Enter fullscreen');
      control.textContent = 'Fullscreen';
      control.addEventListener('click', () => {
        fullscreenToggles++;
        control.setAttribute('aria-label', fullscreenToggles % 2 ? 'Exit fullscreen' : 'Enter fullscreen');
      });
      document.getElementById('player-container').appendChild(control);
    });
    await page.locator('video').dblclick();
    assert.equal(await page.evaluate(() => fullscreenToggles), 1);
    assert.equal(await page.locator('#fixture-fullscreen').getAttribute('aria-label'), 'Exit fullscreen');
    await page.locator('video').dblclick();
    assert.equal(await page.evaluate(() => fullscreenToggles), 2);
    await page.locator('#fixture-fullscreen').evaluate(control => control.remove());
    await page.evaluate(() => {
      const caption = document.createElement('div');
      caption.className = 'native-captions'; caption.textContent = 'Native caption';
      document.getElementById('player-container').appendChild(caption);
    });
    await page.getByTestId('playback-speed-button').click();
    const speed = page.getByRole('slider', { name: 'Playback speed', exact: true });
    await speed.press('ArrowLeft');
    assert.equal(await page.locator('video').evaluate(video => video.playbackRate), .95);
    for (const key of ['ArrowUp', 'ArrowDown', 'j', 'k', 'l']) await speed.press(key);
    assert.equal(await page.locator('video').evaluate(video => video.currentTime), 20);
    assert.equal(await page.evaluate(() => nativeArrows), 1, 'The speed picker must block earlier native shortcuts');
    const panel = page.locator('#youtube-hide-crunchyroll-speed');
    const left = await panel.evaluate(panel => panel.style.left);
    await page.locator('#player-container').evaluate(player => { player.style.width = '700px'; player.style.height = '400px'; });
    await page.waitForFunction(previous => document.getElementById('youtube-hide-crunchyroll-speed').style.left !== previous, left);
    const captionOffset = await page.locator('.native-captions').evaluate(caption =>
      document.getElementById('player-container').getBoundingClientRect().bottom - caption.getBoundingClientRect().bottom);
    assert.ok(Math.abs(captionOffset - 8) < .2, 'Player tools must not shift native captions');
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.crunchyroll.com/*' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.getElementById('player-container') });
        document.dispatchEvent(new Event('fullscreenchange'));
      } });
    });
    assert.equal(await panel.evaluate(panel => panel.parentElement.id), 'player-container');
    const bounds = await panel.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    await speed.press('Escape');
    assert.equal(await panel.isVisible(), false);
    assert.equal(await page.getByTestId('playback-speed-button').evaluate(button => document.activeElement === button), true);
    console.log('Passed: first/repeated seeks, double-click native fullscreen-control routing, speed-dialog shortcut isolation, player-only resizes, native caption geometry, simulated fullscreen menu hosting, and Escape focus restoration.');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
