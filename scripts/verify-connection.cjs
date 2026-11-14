const { chromium } = require("playwright-core");
const { readFileSync, writeFileSync, readdirSync, cpSync, mkdtempSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const root = join(__dirname, "..");
  const extension = mkdtempSync(join(tmpdir(), "playback-connection-extension-"));
  for (const file of readdirSync(root)) {
    if (/\.(js|css|html|json)$/.test(file) || file === "icons") cpSync(join(root, file), join(extension, file), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  // Model a tab that predates extension installation: no automatic scripts ran.
  // The popup still reads the production registrations when choosing recovery files.
  writeFileSync(join(extension, "manifest.json"), JSON.stringify({ ...manifest, content_scripts: [] }));
  const executablePath = [process.env.PLAYBACK_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "playback-connection-profile-")), {
    executablePath, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const page = context.pages()[0];
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    const youtube = `<!doctype html><html><body>
      <ytd-mini-guide-renderer><div>
        <ytd-mini-guide-entry-renderer id="shorts"><a href="/shorts/">Shorts</a></ytd-mini-guide-entry-renderer>
        <ytd-mini-guide-entry-renderer><a href="/feed/subscriptions">Subscriptions</a></ytd-mini-guide-entry-renderer>
        <ytd-mini-guide-entry-renderer><a href="/feed/you">You</a></ytd-mini-guide-entry-renderer>
      </div></ytd-mini-guide-renderer>
      <div id="movie_player"><div class="ytp-timely-actions-overlay"><button onclick="window.jumps++">Jump ahead<span class="ytSpecTouchFeedbackShapeFill"></span></button></div></div>
      <script>window.jumps = 0; window.pageState = 'preserved';</script></body></html>`;
    const player = readFileSync(join(root, "tests/fixtures/crunchyroll-speed-player.html"), "utf8");
    await page.route("https://**/*", route => {
      const url = new URL(route.request().url());
      if (url.hostname === "www.youtube.com") return route.fulfill({ contentType: "text/html", body: youtube });
      if (url.hostname === "www.crunchyroll.com") return route.fulfill({ contentType: "text/html", body: '<iframe src="https://static.crunchyroll.com/player.html"></iframe>' });
      if (url.hostname === "static.crunchyroll.com") return route.fulfill({ contentType: "text/html", body: player });
      return route.abort();
    });
    async function openPopup() {
      const popup = await context.newPage();
      await popup.addInitScript(registrations => {
        const getManifest = chrome.runtime.getManifest.bind(chrome.runtime);
        chrome.runtime.getManifest = () => ({ ...getManifest(), content_scripts: registrations });
      }, manifest.content_scripts);
      await page.bringToFront();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.waitForFunction(() => document.getElementById("site-status").textContent.includes("Connected"));
      assert.equal(await popup.locator("#refresh-hint").isHidden(), true);
      return popup;
    }
    await page.goto("https://www.youtube.com/watch?v=CONNECTION");
    assert.equal(await page.locator(".playback-plus-watch-later").count(), 0);
    const popup = await openPopup();
    await page.waitForFunction(() => window.jumps === 1);
    assert.equal(await page.locator("#shorts").evaluate(el => getComputedStyle(el).display), "none");
    await popup.locator('label:has(input[data-setting="hideShortsEnabled"])').click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("shorts")).display !== "none");
    await popup.close();
    const reopened = await openPopup();
    await reopened.close();
    // Explicitly repeat injection to catch duplicated observers, handlers or skip memory.
    await worker.evaluate(async files => {
      const [tab] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
    }, manifest.content_scripts[0].js);
    assert.equal(await page.evaluate(() => window.jumps), 1);
    assert.equal(await page.evaluate(() => window.pageState), "preserved");
    assert.equal(await page.locator(".playback-plus-watch-later").count(), 1);
    assert.equal(navigations, 1);
    await page.goto("https://www.crunchyroll.com/watch/CONNECTION");
    const crunchyrollPopup = await openPopup();
    await worker.evaluate(() => chrome.storage.local.set({ crunchyrollPlaybackSpeed: 1.75 }));
    const frame = page.frames().find(frame => frame.url().includes("static.crunchyroll.com"));
    await frame.waitForFunction(() => document.querySelector("video").playbackRate === 1.75);
    await frame.getByTestId("playback-speed-button").click();
    assert.equal(await frame.locator("#youtube-hide-crunchyroll-speed").isVisible(), true);
    await frame.getByRole("slider", { name: "Playback speed", exact: true }).press("Escape");
    const wave = Buffer.alloc(44 + 16000 * 60 * 2);
    wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28);
    wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    await frame.evaluate(source => {
      const video = document.querySelector("video");
      video.src = source;
      video.style.cssText = "display:block;width:640px;height:360px";
      window.nativeSeeks = 0;
      for (const [label, sign] of [["Jump backward 10 seconds", -1], ["Jump forward 10 seconds", 1]]) {
        document.querySelector(`button[aria-label="${label}"]`).addEventListener("click", () => {
          nativeSeeks++; video.currentTime += sign * 10;
        });
      }
    }, `data:audio/wav;base64,${wave.toString("base64")}`);
    await frame.waitForFunction(() => document.querySelector("video").readyState >= 2);
    await frame.evaluate(() => { document.querySelector("video").currentTime = 30; });
    await crunchyrollPopup.locator('label:has(input[data-setting="crunchyrollFiveSecondSeekEnabled"])').click();
    await crunchyrollPopup.locator('label:has(input[data-setting="crunchyrollKeyboardShortcutsEnabled"])').click();
    const forward = frame.getByRole("button", { name: "Forward 5 seconds", exact: true });
    await forward.click();
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 35);
    await frame.getByRole("button", { name: "Rewind 5 seconds", exact: true }).click();
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 30);
    await frame.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("ArrowRight");
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 35);
    await page.keyboard.press("j");
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 25);
    await page.keyboard.press("l");
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 35);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 30);
    await page.keyboard.press("k");
    await frame.waitForFunction(() => !document.querySelector("video").paused);
    await page.keyboard.press("k");
    await frame.waitForFunction(() => document.querySelector("video").paused);
    assert.equal(await frame.evaluate(() => nativeSeeks), 0);
    await crunchyrollPopup.locator('label:has(input[data-setting="crunchyrollFiveSecondSeekEnabled"])').click();
    await frame.getByRole("button", { name: "Jump forward 10 seconds", exact: true }).waitFor();
    await frame.evaluate(() => { document.querySelector("video").currentTime = 30; });
    await frame.getByRole("button", { name: "Jump forward 10 seconds", exact: true }).click();
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 40);
    assert.equal(await frame.evaluate(() => nativeSeeks), 1);
    await frame.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("j");
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 30, "J must stay enabled after five-second seeking is disabled");
    await crunchyrollPopup.locator('label:has(input[data-setting="crunchyrollKeyboardShortcutsEnabled"])').click();
    await frame.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("l");
    assert.equal(await frame.locator("video").evaluate(video => video.currentTime), 30, "Disabling J/K/L must release the extension shortcut");
    assert.equal(navigations, 2);
    await crunchyrollPopup.close();
    console.log("Passed: cold-tab recovery, live settings, popup reopen, idempotent injection, one-time skip, Crunchyroll frame recovery, 5s buttons/arrows, 10s J/L, K pause/play, native seek restoration, no page reloads.");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
