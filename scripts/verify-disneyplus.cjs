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
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "playback-disney-")), {
    executablePath, headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const page = context.pages()[0];
    const errors = [];
    page.on("pageerror", error => errors.push(error));
    const url = "https://www.disneyplus.com/en-se/play/DISNEYTEST";
    await page.route(url, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html>
      <disney-web-player id="web-player"></disney-web-player>
      <button id="next">Next episode</button>
      <input id="search" aria-label="Search">
      <script>
        window.fullscreenClicks = 0;
        window.skips = 0;
        window.nativeJumps = 0;
        const shell = document.querySelector('disney-web-player').attachShadow({ mode: 'open' });
        shell.innerHTML = '<video style="width:640px;height:360px"></video><div id="window-shade" style="position:absolute;inset:8px auto auto 8px;width:640px;height:360px;background:#0006;pointer-events:none"></div><disney-controls></disney-controls>';
        const controls = shell.querySelector('disney-controls').attachShadow({ mode: 'closed' });
        controls.innerHTML = '<style>.controls__footer::before { content: ""; background-image: linear-gradient(black, transparent); }</style>' +
          '<div class="btm-media-overlays-container"><div><div class="windowed-Scrim" style="background:#0008"></div></div>' +
          '<div class="controls__footer"><div class="controls__right" style="display:grid;grid-auto-flow:column;pointer-events:none">' +
          '<button aria-label="Gå tillbaka 10 sekunder"><svg width="24" height="24" viewBox="0 0 24 24"><text>10</text></svg></button>' +
          '<button data-testid="seekForwardButton" aria-label="Hoppa fram 10 sekunder"><svg width="24" height="24" viewBox="0 0 24 24"><text>10</text></svg></button>' +
          '<button aria-label="Helskärm" data-testid="fullscreen-button">Fullscreen</button></div>' +
          '<input class="progress-bar" type="range" aria-label="Timeline"><input type="range" aria-label="Volume"></div></div>';
        const video = shell.querySelector('video');
        controls.querySelectorAll('button').forEach(button => { button.style.pointerEvents = 'auto'; });
        const originalToolbar = controls.querySelector('.controls__right').cloneNode(true);
        window.rebuildToolbar = () => {
          originalToolbar.className = 'actions';
          originalToolbar.style.justifyContent = 'end';
          controls.querySelector('.controls__right').replaceWith(originalToolbar);
        };
        controls.querySelector('[data-testid="seekForwardButton"]').onpointerup = () => video.currentTime += 10;
        controls.querySelector('[data-testid="seekForwardButton"]').onclick = () => { nativeJumps++; video.currentTime += 10; };
        controls.querySelector('[aria-label="Gå tillbaka 10 sekunder"]').onclick = () => { nativeJumps++; video.currentTime -= 10; };
        controls.querySelector('[data-testid="fullscreen-button"]').onclick = () => fullscreenClicks++;
        window.addEventListener('keydown', event => {
          if (event.key === 'ArrowLeft') video.currentTime -= 10;
        }, true);
        window.addEventListener('keyup', event => {
          if (event.key === 'ArrowLeft') video.currentTime -= 10;
        }, true);
        window.offerIntro = () => {
          const button = document.createElement('button');
          button.textContent = 'Hoppa över introt';
          button.dataset.testid = 'skip-intro-button';
          button.onclick = () => { skips++; button.remove(); };
          controls.append(button);
        };
        document.querySelector('#next').onclick = () => {
          history.pushState({}, '', '/en-se/play/DISNEYTEST2');
        };
      </script>` }));
    await page.goto(url);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const wave = Buffer.alloc(44 + 16000 * 65 * 2);
    wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    const media = page.locator("disney-web-player video");
    await media.evaluate((video, source) => { video.src = source; }, `data:audio/wav;base64,${wave.toString("base64")}`);
    await page.waitForFunction(() => video.seekable.length);
    await page.waitForFunction(() => getComputedStyle(controls.querySelector(".controls__footer"), "::before").backgroundImage === "none");
    assert.equal(await page.evaluate(() => getComputedStyle(controls.querySelector(".windowed-Scrim")).backgroundColor), "rgba(0, 0, 0, 0)");
    await page.waitForFunction(() => getComputedStyle(shell.querySelector("#window-shade")).backgroundColor === "rgba(0, 0, 0, 0)");
    const clickControl = async selector => {
      await page.waitForFunction(selector => controls.querySelector(selector)?.getBoundingClientRect().width > 0, selector);
      const { x, y } = await page.evaluate(selector => {
        const box = controls.querySelector(selector).getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }, selector);
      await page.mouse.click(x, y);
    };
    await clickControl(".controls__right #playback-plus-disney-speed");
    const speedPicker = page.getByRole("dialog", { name: "Playback speed" });
    assert.equal(await speedPicker.evaluate(panel => document.activeElement === panel), true);
    assert.equal(await page.evaluate(() => getComputedStyle(controls.querySelector("#playback-plus-disney-speed")).userSelect), "none");
    await speedPicker.getByRole("button", { name: "1.25 times normal speed" }).click();
    assert.equal(await media.evaluate(video => video.playbackRate), 1.25);
    const saved = await worker.evaluate(() => chrome.storage.local.get(["disneyplusPlaybackSpeed", "hbomaxPlaybackSpeed"]));
    assert.deepEqual(saved, { disneyplusPlaybackSpeed: 1.25 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    assert.equal(await speedPicker.getByRole("slider").evaluate(slider => document.activeElement === slider), true);
    await page.keyboard.press("Escape");

    await media.evaluate(video => { video.currentTime = 30; });
    await clickControl('[aria-label="Forward 5 seconds"]');
    assert.equal(await media.evaluate(video => video.currentTime), 35);
    await page.evaluate(() => controls.querySelector(".progress-bar").focus());
    await page.keyboard.press("ArrowLeft");
    assert.equal(await media.evaluate(video => video.currentTime), 30);
    await page.evaluate(() => controls.querySelector('[aria-label="Timeline"]').classList.remove("progress-bar"));
    await page.keyboard.press("j");
    assert.equal(await media.evaluate(video => video.currentTime), 20);
    await page.keyboard.press("l");
    assert.equal(await media.evaluate(video => video.currentTime), 30);
    assert.equal(await page.evaluate(() => nativeJumps), 0);
    await page.locator("#search").press("j");
    await page.locator("#search").press("l");
    assert.equal(await page.locator("#search").inputValue(), "jl");
    assert.equal(await media.evaluate(video => video.currentTime), 30);

    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, url);
    await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector("disney-web-player").shadowRoot.querySelector("video");
        Object.defineProperty(video, "seekable", { configurable: true, value: { length: 0 } });
      }
    }), tabId);
    await page.evaluate(() => controls.querySelector('[aria-label="Timeline"]').focus());
    await page.keyboard.press("j");
    assert.equal(await media.evaluate(video => video.currentTime), 20);
    await page.keyboard.press("l");
    assert.equal(await media.evaluate(video => video.currentTime), 30);
    assert.equal(await page.evaluate(() => nativeJumps), 2);
    await worker.evaluate(tabId => chrome.scripting.executeScript({
      target: { tabId },
      func: () => { delete document.querySelector("disney-web-player").shadowRoot.querySelector("video").seekable; }
    }), tabId);
    await page.evaluate(() => controls.querySelector('[aria-label="Timeline"]').classList.add("progress-bar"));
    await page.evaluate(() => {
      window.hiveSeeks = [];
      const timeline = { info: { playheadPositionMs: 120000, durationMs: 240000 } };
      document.querySelector("disney-web-player").mediaPlayer = {
        timeline,
        seek(position) {
          hiveSeeks.push(position);
          timeline.info.playheadPositionMs = position;
        }
      };
    });
    for (const key of ["j", "l", "ArrowLeft", "ArrowRight"]) await page.keyboard.press(key);
    assert.deepEqual(await page.evaluate(() => hiveSeeks), [110000, 120000, 115000, 120000]);
    assert.equal(await media.evaluate(video => video.currentTime), 30);
    await page.evaluate(() => { delete document.querySelector("disney-web-player").mediaPlayer; });
    await page.keyboard.press("k");
    assert.equal(await media.evaluate(video => video.paused), false);
    await page.keyboard.press("k");
    assert.equal(await media.evaluate(video => video.paused), true);
    await media.dblclick();
    await page.keyboard.press("f");
    assert.equal(await page.evaluate(() => fullscreenClicks), 2);

    await page.evaluate(() => rebuildToolbar());
    await clickControl(".actions #playback-plus-disney-speed");
    await page.getByRole("dialog", { name: "Playback speed" }).waitFor({ timeout: 3000 });
    assert.equal(await page.evaluate(() => controls.querySelectorAll("#playback-plus-disney-speed").length), 1);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const actions = controls.querySelector(".actions");
      const fullscreen = document.createElement("toggle-fullscreen");
      const inner = fullscreen.attachShadow({ mode: "closed" });
      inner.innerHTML = '<button class="fullscreen-icon" aria-label="Helskärm">Fullscreen</button>';
      actions.style.display = "block";
      actions.style.position = "absolute";
      actions.style.right = "12px";
      actions.style.top = "48px";
      actions.replaceChildren(fullscreen);
    });
    await page.waitForFunction(() => controls.querySelector("#playback-plus-disney-speed + toggle-fullscreen"));
    await page.evaluate(async () => {
      const modal = document.createElement("dialog");
      modal.id = "watch-dialog";
      modal.style.cssText = "inset:0;margin:0;width:100vw;height:100vh;max-width:none;max-height:none;box-sizing:border-box;";
      modal.append(document.querySelector("disney-web-player"));
      document.body.append(modal);
      modal.showModal();
      const bounds = controls.querySelector("#playback-plus-disney-speed").getBoundingClientRect();
      const hitLayer = document.createElement("div");
      hitLayer.id = "player-hit-layer";
      Object.assign(hitLayer.style, {
        position: "fixed", left: bounds.left - 20 + "px", top: bounds.top + "px",
        width: bounds.width + 20 + "px", height: bounds.height + "px", zIndex: "10"
      });
      modal.append(hitLayer);
      window.speedButtonHitTarget = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.id;
      window.nativeVideoGestures = 0;
      for (const type of ["pointerdown", "click"]) {
        window.addEventListener(type, event => {
          if (event.target !== hitLayer) return;
          nativeVideoGestures++;
          video.pause();
        }, true);
      }
      await video.play();
    });
    assert.equal(await page.evaluate(() => speedButtonHitTarget), "player-hit-layer");
    await clickControl("#playback-plus-disney-speed");
    const modalPicker = page.locator("#watch-dialog").getByRole("dialog", { name: "Playback speed" });
    assert.equal(await page.evaluate(() => nativeVideoGestures), 0);
    assert.equal(await media.evaluate(video => video.paused), false);
    await modalPicker.getByRole("button", { name: "1.5 times normal speed" }).click({ timeout: 3000 });
    assert.equal(await media.evaluate(video => video.playbackRate), 1.5);
    const speedStyle = await page.evaluate(() => {
      const speed = controls.querySelector("#playback-plus-disney-speed");
      const rect = speed.getBoundingClientRect();
      return { text: speed.textContent, width: rect.width, height: rect.height, font: getComputedStyle(speed).fontSize };
    });
    assert.equal(speedStyle.text, "1.5×");
    assert.equal(speedStyle.font, "18px");
    assert.ok(speedStyle.width >= 44 && speedStyle.height >= 44);
    await page.keyboard.press("Escape");
    const outsideSpeed = await page.locator("#player-hit-layer").boundingBox();
    await page.mouse.click(outsideSpeed.x + 5, outsideSpeed.y + outsideSpeed.height / 2);
    assert.ok(await page.evaluate(() => nativeVideoGestures > 0));
    assert.equal(await media.evaluate(video => video.paused), true);
    await page.evaluate(() => {
      const modal = document.querySelector("#watch-dialog");
      video.pause();
      modal.close();
      modal.before(document.querySelector("disney-web-player"));
      modal.remove();
    });

    await page.evaluate(() => offerIntro());
    await page.waitForFunction(() => skips === 1);
    await page.evaluate(() => offerIntro());
    assert.equal(await page.evaluate(() => Boolean(controls.querySelector('[data-testid="skip-intro-button"]'))), true);
    await page.locator("#next").click();
    await page.waitForFunction(() => skips === 2);

    await worker.evaluate(() => chrome.storage.sync.set({ disneyplusRemoveDimmingEnabled: false, disneyplusFiveSecondSeekEnabled: false }));
    await page.waitForFunction(() => getComputedStyle(controls.querySelector(".controls__footer"), "::before").backgroundImage !== "none");
    assert.equal(await page.evaluate(() => getComputedStyle(controls.querySelector(".windowed-Scrim")).backgroundColor), "rgba(0, 0, 0, 0.533)");
    assert.equal(await page.evaluate(() => getComputedStyle(shell.querySelector("#window-shade")).backgroundColor), "rgba(0, 0, 0, 0.4)");
    await page.evaluate(() => {
      window.detachedActions = controls.querySelector(".actions");
      window.detachedActions.remove();
    });
    await page.waitForFunction(() => !controls.querySelector("#playback-plus-disney-speed"));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.getByRole("tab", { name: "Disney+", exact: true }).click();
    await popup.locator('#disneyplus-speed-controls [data-speed="1.25"]').click();
    await page.waitForFunction(() => video.playbackRate === 1.25);
    await popup.close();
    await page.evaluate(() => controls.querySelector(".controls__footer").prepend(window.detachedActions));
    await page.waitForFunction(() => controls.querySelector("#playback-plus-disney-speed")?.textContent === "1.25×");
    await worker.evaluate(() => chrome.storage.sync.set({ disneyplusEnabled: false }));
    await page.waitForFunction(() => !controls.querySelector("#playback-plus-disney-speed"));
    assert.deepEqual(errors, []);
    console.log("Disney+ fixture passed: toolbar and popup speed controls, shadow DOM fullscreen control, overlay toggle, seeking, keys, and one intro skip per title.");
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
