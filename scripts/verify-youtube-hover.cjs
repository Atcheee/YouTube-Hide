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
    for (const selector of [".ytp-chrome-top", ".ytp-fullscreen-grid"]) {
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
    await page.waitForFunction(() => hoverFixture.nativeHides > 0);
    // Native hideControls() latches display:none until showControls() runs.
    // Returning after cleanup (not just during the probe) must restore that API state.
    await page.mouse.move(500, 200);
    assert.equal(await page.evaluate(() => hoverFixture.controlsDisabled), false);
    assert.ok(await page.evaluate(() => hoverFixture.nativeShows > 0));
    for (const selector of [".ytp-chrome-top", ".ytp-chrome-bottom", ".ytp-fullscreen-quick-actions"]) {
      const visible = await page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.opacity === "1";
      });
      assert.equal(visible, true, `${selector} must respond to manual input after native cleanup`);
    }
    const hidesBeforeLeaving = await page.evaluate(() => hoverFixture.nativeHides);
    await page.mouse.move(1150, 740);
    await page.waitForFunction((previous) => hoverFixture.nativeHides > previous, hidesBeforeLeaving);
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
    for (const selector of [".ytp-chrome-top", ".ytp-chrome-bottom", ".ytp-fullscreen-grid", ".ytp-fullscreen-quick-actions"]) {
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
    assert.ok(await page.evaluate(() => hoverFixture.nativeHides > 0), "MAIN-world cleanup must reach the native player API");
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
    console.log("Passed: quiet automatic checks, manual native-control restoration before/after skip, stationary-pointer layout events, manual previews, rewind protection.");
  } finally {
    await context.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
