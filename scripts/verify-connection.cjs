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
    assert.equal(navigations, 2);
    await crunchyrollPopup.close();
    console.log("Passed: cold-tab recovery, live settings, popup reopen, idempotent injection, one-time skip, cross-origin Crunchyroll frame recovery, no page reloads.");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
