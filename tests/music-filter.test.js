const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");

const script = readFileSync(join(__dirname, "..", "content.js"), "utf8");
const fixture = readFileSync(join(__dirname, "fixtures", "youtube-music-card.html"), "utf8");
const hidden = card => card.classList.contains("hide-streamed-days-video");

function setup(t, html = fixture) {
  const { window } = new JSDOM(html, { url: "https://www.youtube.com/", runScripts: "outside-only" });
  const observers = [];
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  t.after(() => { observers.forEach(observer => observer.disconnect()); window.close(); });
  const frames = [];
  window.requestAnimationFrame = callback => frames.push(callback);
  const change = installSettings(window, { hideStreamedEnabled: false, hideShortsEnabled: false, hideMixEnabled: false });
  window.chrome.runtime.onMessage = { addListener() {} };
  window.eval(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return {
    document: window.document, change,
    async flush() {
      await Promise.resolve(); // Deliver DOM mutations before processing the queued scan.
      while (frames.length) frames.shift()();
    }
  };
}

test("music filter hides the supplied lockup's entire grid item, leaving ordinary videos visible", async t => {
  const page = setup(t, fixture + fixture);
  const [music, ordinary] = page.document.querySelectorAll("ytd-rich-item-renderer");
  ordinary.querySelector(".ytBadgeShapeIcon").remove();
  await page.flush();
  assert.equal(hidden(music), true);
  assert.equal(hidden(ordinary), false, "artist-channel badge and duration alone do not identify a music video");
  assert.equal(hidden(music.querySelector("yt-lockup-view-model")), false, "hide the outer card so no empty grid cell remains");
});

for (const key of ["hideMusicEnabled", "youtubeEnabled", "extensionEnabled"]) {
  test(`${key} restores music cards and reapplies the music filter live`, async t => {
    const page = setup(t);
    const card = page.document.querySelector("ytd-rich-item-renderer");
    await page.flush();
    assert.equal(hidden(card), true);
    page.change({ [key]: false });
    await page.flush();
    assert.equal(hidden(card), false);
    page.change({ [key]: true });
    await page.flush();
    assert.equal(hidden(card), true);
  });
}

test("music cards added after the initial scan are hidden", async t => {
  const page = setup(t, "");
  await page.flush();
  page.document.body.insertAdjacentHTML("beforeend", fixture);
  await page.flush();
  assert.equal(hidden(page.document.querySelector("ytd-rich-item-renderer")), true);
});

test("late music-note glyph updates hide recycled cards and restore ordinary cards", async t => {
  // Some renderers populate the SVG path after inserting the thumbnail structure.
  const page = setup(t, fixture.replace('class="ytBadgeShapeIcon"', 'class="pending-icon"'));
  const card = page.document.querySelector("ytd-rich-item-renderer");
  const path = card.querySelector("yt-thumbnail-view-model path");
  const musicPath = path.getAttribute("d");
  path.setAttribute("d", "M0 0h12v12H0z");
  await page.flush();
  assert.equal(hidden(card), false);
  path.setAttribute("d", musicPath);
  await page.flush();
  assert.equal(hidden(card), true);
  path.setAttribute("d", "M0 0h12v12H0z");
  await page.flush();
  assert.equal(hidden(card), false);
});

test("classic thumbnail music markers are rescanned when updated in place", async t => {
  const page = setup(t, '<ytd-video-renderer><ytd-thumbnail-overlay-time-status-renderer overlay-style="DEFAULT">2:40</ytd-thumbnail-overlay-time-status-renderer></ytd-video-renderer>');
  const card = page.document.querySelector("ytd-video-renderer");
  const badge = card.firstElementChild;
  await page.flush();
  assert.equal(hidden(card), false);
  badge.setAttribute("overlay-style", "MUSIC");
  await page.flush();
  assert.equal(hidden(card), true);
  badge.removeAttribute("overlay-style");
  await page.flush();
  assert.equal(hidden(card), false);
});
