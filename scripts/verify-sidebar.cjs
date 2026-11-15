const { chromium } = require("playwright-core");
const { existsSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const extension = join(__dirname, "..");
  const executablePath = [process.env.YOUTUBE_TEST_BROWSER,
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  if (!executablePath) throw new Error("Set YOUTUBE_TEST_BROWSER to a Chromium browser executable.");
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "playback-sidebar-")), {
    executablePath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const page = context.pages()[0];
    await page.route("https://www.youtube.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <style>body{background:#111;color:white;font:14px Arial}ytd-guide-renderer{display:block;width:216px;padding:12px}#sections{width:100%}h3{display:flex;margin:0;font-size:16px}a{color:inherit}ytd-guide-entry-renderer{display:block;padding:10px 0}</style>
      <ytd-guide-renderer><div id="sections">
        <ytd-guide-section-renderer><ytd-guide-entry-renderer><a href="/">Home</a></ytd-guide-entry-renderer><ytd-guide-entry-renderer id="shorts"><a href="/shorts/">Shorts</a></ytd-guide-entry-renderer></ytd-guide-section-renderer>
        <ytd-guide-section-renderer id="subscriptions"><h3><ytd-guide-entry-renderer><a href="/feed/subscriptions">Subscriptions</a></ytd-guide-entry-renderer></h3><div><ytd-guide-entry-renderer><a href="/@channel">Channel</a></ytd-guide-entry-renderer></div></ytd-guide-section-renderer>
      </div></ytd-guide-renderer>` }));
    await page.goto("https://www.youtube.com/");
    const shortcut = page.locator(".playback-plus-watch-later");
    await shortcut.waitFor();
    const layout = await shortcut.evaluate(link => {
      const row = link.getBoundingClientRect();
      const heading = document.querySelector("h3").getBoundingClientRect();
      const label = link.querySelector("span");
      return { parent: link.parentElement.id, width: row.width, rowHeight: row.height,
        labelHeight: label.getBoundingClientRect().height, whiteSpace: getComputedStyle(label).whiteSpace,
        headingBelow: heading.top >= row.bottom, headingText: document.querySelector("h3").textContent };
    });
    assert.equal(layout.parent, "sections");
    assert.equal(layout.width, 216);
    assert.equal(layout.rowHeight, 40);
    assert.ok(layout.labelHeight < 25, "Watch later must fit on one line");
    assert.equal(layout.whiteSpace, "nowrap");
    assert.equal(layout.headingBelow, true);
    assert.equal(layout.headingText, "Subscriptions");
    assert.equal(await page.locator("#shorts").isVisible(), false);
    console.log(JSON.stringify({ expandedGuide: layout, shortsHidden: true }));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
