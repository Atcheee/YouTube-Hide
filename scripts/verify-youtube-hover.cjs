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

async function sampleUnattendedFrames(page, simulateBlur = true) {
  return page.evaluate(async (simulateBlur) => {
    const frames = [];
    const initialChecks = hoverFixture.checks;
    const end = performance.now() + 3300;
    if (simulateBlur) window.dispatchEvent(new Event('blur'));
    while (performance.now() < end) {
      await new Promise(requestAnimationFrame);
      const player = document.getElementById('movie_player');
      const watermark = player.querySelector('.iv-branding').getBoundingClientRect();
      frames.push({
        watermarkBottom: player.getBoundingClientRect().bottom - watermark.bottom,
        titleOpacity: getComputedStyle(player.querySelector('.ytp-fullscreen-metadata')).opacity,
        barOpacity: getComputedStyle(player.querySelector('.ytp-chrome-bottom')).opacity,
        cursor: getComputedStyle(document.elementFromPoint(500, 200) || player).cursor,
        captions: ['bottom-caption', 'positioned-caption', 'top-caption'].map(id => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return Math.round((player.getBoundingClientRect().bottom - rect.bottom) * 10) / 10;
        })
      });
    }
    return { frames: frames.length, offsets: [...new Set(frames.map(frame => Math.round(frame.watermarkBottom * 10) / 10))],
      titleFlashed: frames.some(frame => frame.titleOpacity !== '0'),
      barFlashed: frames.some(frame => frame.barOpacity !== '0'), checks: hoverFixture.checks - initialChecks,
      cursors: [...new Set(frames.map(frame => frame.cursor))],
      captionOffsets: [0, 1, 2].map(index => [...new Set(frames.map(frame => frame.captions[index]))]),
      fullscreen: document.fullscreenElement === document.getElementById('movie_player'),
      fullscreenLayout: document.getElementById('movie_player').classList.contains('ytp-fullscreen'),
      fillsViewport: document.getElementById('movie_player').getBoundingClientRect().width === innerWidth &&
        document.getElementById('movie_player').getBoundingClientRect().height === innerHeight,
      visible: !document.hidden, focused: document.hasFocus() };
  }, simulateBlur);
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
    for (const selector of [".ytp-chrome-top", ".ytp-fullscreen-metadata", ".ytp-fullscreen-grid"]) {
      assert.equal(await page.locator(selector).evaluate((element) => getComputedStyle(element).opacity), "0");
    }
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
    // Leave the real pointer on the video. The idle timeout must hide it once,
    // and repeated automatic checks must not bring it back for a painted frame.
    await page.waitForFunction(() => document.getElementById('movie_player').classList.contains('youtube-hide-auto-activity'));
    const parkedCursor = await sampleUnattendedFrames(page, false);
    assert.ok(parkedCursor.checks >= 2);
    assert.deepEqual(parkedCursor.cursors, ['none'], 'A parked cursor must stay hidden across automatic hover checks');
    assert.ok(parkedCursor.captionOffsets.every(offsets => offsets.length === 1),
      `Captions must not move during automatic checks: ${JSON.stringify(parkedCursor.captionOffsets)}`);
    assert.ok(Math.abs(parkedCursor.captionOffsets[0][0] - 540 * .02) < .2);
    assert.ok(Math.abs(parkedCursor.captionOffsets[1][0] - 540 * .35) < .2, 'Custom caption bottom position must be preserved');
    await page.mouse.move(501, 200);
    assert.notEqual(await page.locator('video').evaluate(video => getComputedStyle(video).cursor), 'none',
      'Real mouse movement must immediately restore the cursor');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('bottom-caption')).marginBottom === '64px');
    const manualCaption = await page.locator('#bottom-caption').evaluate(caption => {
      const player = document.getElementById('movie_player');
      return player.getBoundingClientRect().bottom - caption.getBoundingClientRect().bottom;
    });
    assert.ok(Math.abs(manualCaption - (540 * .02 + 64)) < .2, 'Manual controls must still lift captions clear of the bar');
    console.log(JSON.stringify({ parkedCursor }));
    // A menu opened by the player must stay usable even after input becomes idle.
    await page.evaluate(() => {
      const menu = document.createElement('div');
      menu.id = 'fixture-menu';
      menu.className = 'ytp-popup ytp-settings-menu';
      menu.setAttribute('role', 'menu');
      menu.style.cssText = 'position:absolute;right:10px;top:50px;width:180px;height:120px;background:#222';
      document.getElementById('movie_player').appendChild(menu);
    });
    await page.waitForFunction(() => !document.getElementById('movie_player').classList.contains('youtube-hide-auto-activity'));
    const menuChecks = await page.evaluate(() => hoverFixture.checks);
    await page.waitForTimeout(3400);
    assert.equal(await page.evaluate(() => hoverFixture.checks), menuChecks, 'Idle menus must not receive synthetic hover checks');
    await page.locator('#fixture-menu').evaluate(menu => menu.remove());
    await page.mouse.move(1150, 740);
    await page.waitForFunction(() => document.getElementById('movie_player').classList.contains('youtube-hide-auto-activity'));
    // Theater-style resizes must cancel the old hover and recompute coordinates.
    await page.locator('#movie_player').evaluate(player => { player.style.width = '800px'; player.style.height = '450px'; });
    await page.waitForFunction(() => document.getElementById('movie_player').dataset.nativeHover === 'false');
    await page.waitForFunction(() => document.getElementById('movie_player').classList.contains('youtube-hide-auto-activity'));
    assert.equal(await page.locator('#bottom-caption').evaluate(caption => getComputedStyle(caption).marginBottom), '0px');
    await page.locator('#movie_player').evaluate(player => {
      player.classList.add('ytp-player-minimized');
      player.style.width = '400px'; player.style.height = '225px';
    });
    await page.waitForFunction(() => document.getElementById('movie_player').classList.contains('youtube-hide-auto-activity'));
    assert.ok(Math.abs(await page.locator('.iv-branding').evaluate(watermark =>
      document.getElementById('movie_player').getBoundingClientRect().bottom - watermark.getBoundingClientRect().bottom) - 36) < .2,
      'Mini-player checks must use the mini-player overlay offset');
    await page.locator('#movie_player').evaluate(player => {
      player.classList.remove('ytp-player-minimized');
      player.style.width = '960px'; player.style.height = '540px';
    });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(() => document.querySelector("#movie_player").classList.contains("youtube-hide-auto-activity"));
    await page.evaluate(() => {
      document.querySelector("#movie_player").dataset.nativeHover = "true";
    });
    assert.equal(await page.locator(".ytp-tooltip").evaluate((tooltip) => getComputedStyle(tooltip).display), "none");
    // Intentional timeline hover should still display the native preview.
    await page.locator(".ytp-progress-bar").hover();
    assert.notEqual(await page.locator(".ytp-tooltip").evaluate((tooltip) => getComputedStyle(tooltip).display), "none");
    await page.mouse.move(500, 200);
    assert.equal(await page.evaluate(() => hoverFixture.seeks), 0);
    await page.mouse.move(1150, 740);
    await page.waitForFunction(() => document.querySelector("#movie_player").classList.contains("youtube-hide-auto-activity") &&
      document.querySelector("#movie_player").dataset.nativeHover === "false");
    // Sample every painted frame over several unattended checks. Visibility-only
    // assertions miss the watermark being lifted by an invisible quick-action row.
    const unattended = await sampleUnattendedFrames(page);
    assert.ok(unattended.frames > 30);
    assert.ok(unattended.checks >= 2);
    assert.deepEqual(unattended.offsets, [24], "Channel watermark must not move between hover checks");
    assert.equal(unattended.titleFlashed, false);
    assert.equal(unattended.barFlashed, false);
    assert.equal(await page.evaluate(() => hoverFixture.nativeHides + hoverFixture.nativeShows), 0);
    console.log(JSON.stringify({ unattended }));
    await page.mouse.move(500, 200);
    assert.equal(await page.evaluate(() => hoverFixture.controlsDisabled), false);
    for (const selector of [".ytp-chrome-top", ".ytp-fullscreen-metadata", ".ytp-chrome-bottom", ".ytp-fullscreen-quick-actions"]) {
      const visible = await page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.opacity === "1";
      });
      assert.equal(visible, true, `${selector} must respond to manual input after automatic cleanup`);
    }
    const leavesBeforeLeaving = await page.evaluate(() => hoverFixture.playerLeaves);
    await page.mouse.move(1150, 740);
    await page.waitForFunction((previous) => hoverFixture.playerLeaves > previous &&
      document.querySelector("#movie_player").classList.contains("youtube-hide-auto-activity"), leavesBeforeLeaving);
    // A layout change can produce trusted over/enter events with no mouse movement.
    // Move a player descendant under the stationary pointer on the surrounding page.
    await page.evaluate(() => {
      window.layoutBoundaryEvents = [];
      for (const type of ["pointerover", "mouseover", "pointermove", "mousemove"]) {
        document.addEventListener(type, (event) => {
          if (event.isTrusted && event.target.id === "layout-hover-target") layoutBoundaryEvents.push(type);
        }, true);
      }
      const target = document.createElement("div");
      target.id = "layout-hover-target";
      target.style.cssText = "position:fixed;left:1100px;top:700px;width:100px;height:80px;background:#333";
      document.querySelector("#movie_player").appendChild(target);
    });
    await page.waitForFunction(() => layoutBoundaryEvents.includes("pointerover"));
    const layoutEvents = await page.evaluate(() => layoutBoundaryEvents);
    assert.ok(layoutEvents.includes("mouseover"));
    assert.ok(!layoutEvents.includes("pointermove"), "Layout-only boundary changes must not be treated as movement");
    for (const selector of [".ytp-chrome-top", ".ytp-fullscreen-metadata", ".ytp-chrome-bottom", ".ytp-fullscreen-grid", ".ytp-fullscreen-quick-actions"]) {
      assert.equal(await page.locator(selector).evaluate((element) => getComputedStyle(element).opacity), "0",
        `${selector} must remain suppressed after stationary-pointer layout events`);
    }
    // CSS hover can remain stale across monitor transitions. It must not block a skip.
    const session = await context.newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#movie_player" });
    await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
    assert.equal(await page.locator("#movie_player").evaluate((player) => player.matches(":hover")), true);
    await page.evaluate(() => { hoverFixture.offerJump = true; });
    await page.waitForFunction(() => hoverFixture.jumps === 1);
    assert.equal(await page.locator(".ytp-chrome-bottom").evaluate((bar) => getComputedStyle(bar).opacity), "0");
    assert.equal(await page.locator(".ytp-tooltip").evaluate((tooltip) => getComputedStyle(tooltip).display), "none");
    assert.equal(await page.locator(".ytp-fullscreen-quick-actions").evaluate((row) => getComputedStyle(row).opacity), "0");
    assert.equal(await page.evaluate(() => hoverFixture.actions), 0);
    assert.ok(await page.evaluate(() => hoverFixture.playerLeaves > 0));
    assert.equal(await page.evaluate(() => hoverFixture.nativeHides + hoverFixture.nativeShows), 0, "Probes must not toggle native control APIs");
    console.log(JSON.stringify({ stationaryLayoutEvents: layoutEvents, nativeHides: await page.evaluate(() => hoverFixture.nativeHides) }));
    await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    await session.detach();
    // Skip memory stops future probes, so manual restoration must also work here.
    await page.mouse.move(500, 200);
    assert.equal(await page.evaluate(() => hoverFixture.controlsDisabled), false);
    assert.equal(await page.locator(".ytp-chrome-bottom").evaluate((bar) => getComputedStyle(bar).display), "block");
    await page.locator(".ytp-progress-bar").hover();
    assert.notEqual(await page.locator(".ytp-tooltip").evaluate((tooltip) => getComputedStyle(tooltip).display), "none");
    await page.evaluate(() => { document.querySelector("video").currentTime = 0; });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await page.evaluate(() => hoverFixture.jumps), 1);

    // Model YouTube's fullscreen classes and viewport geometry, with simulated
    // application blur but a visible tab. This avoids native fullscreen/focus
    // permission differences in headless Brave; no physical monitor is tested.
    await page.goto("https://www.youtube.com/watch?v=HOVERTESTFULLSCREEN");
    await page.evaluate(async (source) => {
      const player = document.getElementById('movie_player');
      player.classList.add('ytp-fullscreen', 'ytp-big-mode');
      player.style.cssText = 'position:fixed;inset:0;margin:0;width:100vw;height:100vh';
      const video = document.querySelector('video');
      video.src = source;
      await video.play();
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      window.dispatchEvent(new Event('blur'));
    }, silentWave());
    await page.mouse.move(-50, -50);
    await page.waitForFunction(() => document.getElementById('movie_player').classList.contains('youtube-hide-auto-activity'));
    const fullscreen = await sampleUnattendedFrames(page);
    assert.equal(fullscreen.fullscreenLayout, true);
    assert.equal(fullscreen.fillsViewport, true);
    assert.equal(fullscreen.visible, true);
    assert.equal(fullscreen.focused, false);
    assert.ok(fullscreen.checks >= 2);
    assert.deepEqual(fullscreen.offsets, [24]);
    assert.equal(fullscreen.titleFlashed, false);
    assert.equal(fullscreen.barFlashed, false);
    assert.ok(fullscreen.captionOffsets.every(offsets => offsets.length === 1), 'Fullscreen captions must stay stationary');
    assert.ok(Math.abs(fullscreen.captionOffsets[0][0] - 800 * .02) < .2);
    assert.ok(Math.abs(fullscreen.captionOffsets[1][0] - 800 * .35) < .2);
    // Cue changes and late caption nodes must retain their authored positions.
    await page.evaluate(() => {
      const caption = document.getElementById('positioned-caption');
      const replacement = caption.cloneNode(true);
      replacement.textContent = 'New caption cue';
      replacement.style.height = '72px';
      caption.replaceWith(replacement);
      document.getElementById('top-caption').style.top = '15%';
    });
    assert.ok(Math.abs(await page.locator('#positioned-caption').evaluate(caption =>
      document.getElementById('movie_player').getBoundingClientRect().bottom - caption.getBoundingClientRect().bottom) - 800 * .35) < .2);
    assert.ok(Math.abs(await page.locator('#top-caption').evaluate(caption =>
      caption.getBoundingClientRect().top - document.getElementById('movie_player').getBoundingClientRect().top) - 800 * .15) < .2);
    await page.evaluate(() => { hoverFixture.offerJump = true; });
    await page.waitForFunction(() => hoverFixture.jumps === 1);
    assert.equal(await page.evaluate(() => hoverFixture.nativeHides + hoverFixture.nativeShows), 0);
    // Real pointer input must still reveal controls while the browser is unfocused.
    await page.mouse.move(500, 200);
    assert.equal(await page.locator('.ytp-fullscreen-metadata').evaluate(element => getComputedStyle(element).opacity), '1');
    assert.equal(await page.locator('.ytp-chrome-bottom').evaluate(element => getComputedStyle(element).opacity), '1');
    console.log(JSON.stringify({ fullscreen, fullscreenLayoutSimulated: true, applicationFocusSimulated: true }));
    console.log("Passed: stationary captions, cursor and watermark across automatic checks, custom caption positions/cue updates, manual UI, automatic skip, rewind protection.");
  } finally {
    await context.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
