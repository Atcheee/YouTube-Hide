const { chromium } = require("playwright-core");
const { existsSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const extension = join(__dirname, "..");
  const executablePath = [process.env.PLAYBACK_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  if (!executablePath) throw new Error("Set PLAYBACK_TEST_BROWSER to a Chromium browser executable.");
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "playback-hbo-")), {
    executablePath, headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const page = context.pages()[0];
    const errors = [];
    page.on("pageerror", error => errors.push(error));
    const url = "https://www.hbomax.com/se/sv/video/watch/HBOTEST";
    await page.route(url, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html>
      <div id="player-container" style="position:relative;width:800px;height:450px">
        <video style="width:800px;height:450px"></video>
        <div id="surface" style="position:absolute;inset:0"></div>
      </div>
      <div id="top-gradient" class="TopGradient-Fuse-Web-Play-fixture" style="height:24px;background:linear-gradient(black,transparent)"></div>
      <div class="BottomGradient-Fuse-Web-Play-fixture" style="height:24px;background:linear-gradient(transparent,black)"></div>
      <div data-testid="protection_layer" style="height:24px;background:#0008" onclick="videoSurfaceClicks++"></div>
      <div data-testid="buffering"><div class="StyledProtection-fixture" style="background:#0008"><span role="status">Buffering</span></div></div>
      <button id="back" aria-label="Spola bakåt 10 sekunder"><span><svg width="24" height="24" viewBox="0 0 24 24"><text x="6" y="16">10</text></svg></span></button>
      <button id="forward" aria-label="10 seconds forward"><svg width="24" height="24" viewBox="0 0 24 24"><text x="6" y="16">10</text></svg></button>
      <div id="toolbar" style="display:flex;align-items:center;gap:8px"><button aria-label="Volume">Volume</button><span style="padding-bottom:24px"><button aria-label="Helskärm" style="display:grid"><svg width="20" height="20" aria-hidden="true"></svg></button></span></div>
      <button aria-label="Back" id="navigation">Back</button>
      <input aria-label="Search">
      <div id="player-overlay" style="display:none;position:fixed;inset:0;z-index:2147483647;background:transparent"></div>
      <script>
        window.nativeDoubleClicks = 0;
        window.fullscreenChanges = 0;
        window.fallbackFullscreen = null;
        window.introsSkipped = 0;
        window.videoSurfaceClicks = 0;
        window.nativeSpeedClicks = 0;
        const video = document.querySelector('video');
        document.getElementById('forward').onclick = () => video.currentTime += 10;
        window.addEventListener('keydown', event => {
          if (event.key === 'ArrowLeft') video.currentTime -= 10;
        }, true);
        window.addEventListener('click', event => {
          if (event.target.closest('#playback-plus-hbo-speed')) {
            nativeSpeedClicks++;
            event.stopImmediatePropagation();
          }
        }, true);
        window.addEventListener('dblclick', () => nativeDoubleClicks++);
        const fullscreenButton = document.querySelector('[aria-label="Helskärm"]');
        fullscreenButton.onclick = () => {
          fullscreenChanges++;
          fullscreenButton.setAttribute('aria-label', fullscreenChanges % 2 ? 'Avsluta helskärm' : 'Helskärm');
        };
        document.addEventListener('fullscreenchange', () => { fallbackFullscreen = document.fullscreenElement?.id; });
        document.addEventListener('fullscreenerror', event => { fallbackFullscreen = event.target.id; });
        window.offerIntro = () => {
          const button = document.createElement('button');
          button.textContent = 'Hoppa över intro';
          button.onclick = () => { introsSkipped++; button.remove(); };
          document.body.appendChild(button);
        };
      </script>` }));

    await page.goto(url);
    const wave = Buffer.alloc(44 + 16000 * 60 * 2);
    wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    const media = page.locator("video");
    await media.evaluate((video, source) => { video.src = source; }, `data:audio/wav;base64,${wave.toString("base64")}`);
    await page.waitForFunction(() => document.querySelector("video").seekable.length > 0);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#top-gradient")).visibility === "hidden");
    const clickLayer = page.getByTestId("protection_layer");
    await clickLayer.click();
    assert.equal(await page.evaluate(() => videoSurfaceClicks), 1);
    assert.equal(await clickLayer.evaluate(layer => getComputedStyle(layer).backgroundColor), "rgba(0, 0, 0, 0)");
    assert.equal(await page.getByRole("status", { name: "" }).filter({ hasText: "Buffering" }).isVisible(), true);
    await worker.evaluate(() => chrome.storage.sync.set({ hbomaxRemoveDimmingEnabled: false }));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#top-gradient")).visibility === "visible");
    assert.equal(await clickLayer.evaluate(layer => getComputedStyle(layer).backgroundColor), "rgba(0, 0, 0, 0.533)");
    await media.evaluate(video => { video.currentTime = 30; });
    await page.getByRole("button", { name: "Forward 5 seconds", exact: true }).click();
    assert.equal(await media.evaluate(video => video.currentTime), 35);
    await page.getByRole("button", { name: "Rewind 5 seconds", exact: true }).click();
    const icons = await page.locator("#back svg, #forward svg").evaluateAll(elements => elements.filter(svg => svg.querySelector(":scope > .playback-plus-hbo-seek")).map(svg => {
      const original = svg.getBoundingClientRect();
      const icon = svg.querySelector(".playback-plus-hbo-seek");
      const replacement = icon.getBoundingClientRect();
      const fits = replacement.width > 10 && replacement.height > 10 && replacement.left >= original.left &&
        replacement.right <= original.right && replacement.top >= original.top && replacement.bottom <= original.bottom;
      return { fits, originalHidden: getComputedStyle(svg.firstElementChild).visibility === "hidden" };
    }));
    assert.deepEqual(icons, [{ fits: true, originalHidden: true }, { fits: true, originalHidden: true }]);
    assert.equal(await page.locator("#navigation").getAttribute("aria-label"), "Back");
    assert.equal(await media.evaluate(video => video.currentTime), 30);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await media.evaluate(video => video.currentTime), 25);
    await page.keyboard.press("j");
    assert.equal(await media.evaluate(video => video.currentTime), 15);
    await page.keyboard.press("l");
    assert.equal(await media.evaluate(video => video.currentTime), 25);
    await page.keyboard.press("k");
    await page.waitForFunction(() => !document.querySelector("video").paused);
    await page.keyboard.press("k");
    assert.equal(await media.evaluate(video => video.paused), true);
    await page.getByRole("textbox", { name: "Search" }).press("l");
    assert.equal(await page.getByRole("textbox", { name: "Search" }).inputValue(), "l");
    await page.locator("#surface").dblclick();
    assert.equal(await page.evaluate(() => fullscreenChanges), 1);
    assert.equal(await page.evaluate(() => nativeDoubleClicks), 0);
    await page.keyboard.press("f");
    assert.equal(await page.evaluate(() => fullscreenChanges), 2);
    await page.getByRole("textbox", { name: "Search" }).press("f");
    assert.equal(await page.evaluate(() => fullscreenChanges), 2);
    await page.locator("#navigation").dblclick();
    assert.equal(await page.evaluate(() => fullscreenChanges), 2);
    const speed = page.locator("#toolbar").getByRole("button", { name: "Playback speed", exact: true });
    await page.locator("#toolbar").evaluate(toolbar => { toolbar.style.pointerEvents = "none"; });
    await speed.click({ timeout: 3000 });
    assert.equal(await page.evaluate(() => nativeSpeedClicks), 0);
    const speedMenu = page.getByRole("dialog", { name: "Playback speed" });
    await speedMenu.waitFor({ timeout: 3000 });
    await page.locator("#player-overlay").evaluate(overlay => { overlay.style.display = "block"; });
    await speedMenu.getByRole("button", { name: "1.25 times normal speed" }).click({ timeout: 3000 });
    await page.locator("#player-overlay").evaluate(overlay => { overlay.style.display = "none"; });
    await page.keyboard.press("Escape");
    assert.equal(await speedMenu.isVisible(), false);
    await speed.click();
    assert.equal(await speed.evaluate(button => button.nextElementSibling.querySelector("button").getAttribute("aria-label")), "Helskärm");
    await page.locator('[data-speed="1.25"]').click();
    assert.equal(await media.evaluate(video => video.playbackRate), 1.25);
    assert.equal(await speed.textContent(), "1.25x");
    const alignment = await speed.evaluate(button => {
      const center = element => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
      return Math.abs(center(button) - center(button.nextElementSibling.querySelector("svg")));
    });
    assert.ok(alignment <= 1, `Speed button sits ${alignment}px away from the fullscreen icon center`);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, url);
    await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector("video");
        const nativeBuffered = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "buffered").get;
        Object.defineProperty(video, "buffered", { get() {
          if (!video.dataset.bufferAhead) return nativeBuffered.call(video);
          return { length: 1, start: () => 0, end: () => video.currentTime + Number(video.dataset.bufferAhead) };
        } });
      }
    }), tabId);
    await media.evaluate(async video => {
      video.dataset.bufferAhead = "1";
      await video.play();
    });
    await page.waitForFunction(() => document.querySelector("video").playbackRate === 1);
    assert.match(await speed.getAttribute("title"), /resume at 1.25x/);
    await media.evaluate(video => {
      video.dataset.bufferAhead = "5";
      video.dispatchEvent(new Event("progress"));
    });
    assert.equal(await media.evaluate(video => video.playbackRate), 1);
    await media.evaluate(video => {
      video.dataset.bufferAhead = "12";
      video.dispatchEvent(new Event("progress"));
    });
    await page.waitForFunction(() => document.querySelector("video").playbackRate === 1.25);
    await media.evaluate(video => {
      video.pause();
      delete video.dataset.bufferAhead;
      video.currentTime = 25;
    });
    await page.evaluate(() => offerIntro());
    await page.waitForFunction(() => introsSkipped === 1);
    await page.evaluate(() => offerIntro());
    await page.getByRole("button", { name: "Hoppa över intro", exact: true }).waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get("hbomaxPlaybackSpeed")).hbomaxPlaybackSpeed), 1.25);
    await page.locator('#toolbar button[aria-label="Helskärm"]').evaluate(button => button.remove());
    await page.locator("#surface").dblclick();
    await page.waitForFunction(() => fallbackFullscreen !== null);
    assert.equal(await page.evaluate(() => fallbackFullscreen), "player-container");
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    await worker.evaluate(() => chrome.storage.sync.set({ hbomaxEnabled: false }));
    await page.getByRole("button", { name: "10 seconds forward", exact: true }).click();
    assert.equal(await page.locator("#forward svg text").evaluate(node => getComputedStyle(node).visibility), "visible");
    assert.ok(await media.evaluate(video => video.currentTime >= 35 && video.currentTime < 36));
    assert.equal(await page.locator("#playback-plus-hbo-speed").count(), 0);
    assert.deepEqual(errors, []);
    console.log("HBO Max fixture passed: dimming toggle, seeking, keys, fullscreen routing, speed menu clicks through player overlays, low-buffer recovery, and intro skip.");
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
