const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");

const script = readFileSync(join(__dirname, "..", "crunchyroll-playback-speed.js"), "utf8");
const fixture = readFileSync(join(__dirname, "fixtures", "crunchyroll-speed-player.html"), "utf8");
const KEY = "crunchyrollPlaybackSpeed";

function setup(t, { saved = null, delayedStorage = false, settings = {} } = {}) {
  const dom = new JSDOM(fixture, { url: "https://www.crunchyroll.com/watch/G4VUQ2GZ7/title", runScripts: "outside-only" });
  const { window } = dom;
  const { document } = window;
  const observers = [];
  const changes = [];
  const writes = [];
  let finishStorage;
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  t.after(async () => {
    await new Promise(setImmediate);
    observers.forEach((observer) => observer.disconnect());
    window.close();
  });
  window.chrome = { storage: {
    local: {
      get(_defaults, callback) {
        finishStorage = () => callback({ [KEY]: saved });
        if (!delayedStorage) finishStorage();
      },
      set(value) { writes.push(value); }
    },
    onChanged: { addListener: (callback) => changes.push(callback) }
  } };
  window.setInterval = () => 1;
  const changeSettings = installSettings(window, settings);
  window.eval(script);
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return {
    window, document, writes, changeSettings,
    get video() { return document.querySelector("video"); },
    get button() { return document.querySelector('[data-testid="playback-speed-button"]'); },
    get panel() { return document.getElementById("youtube-hide-crunchyroll-speed"); },
    get slider() { return this.panel.querySelector("input"); },
    get output() { return this.panel.querySelector("output").textContent; },
    flush: () => new Promise(setImmediate),
    open() { this.button.click(); },
    event(name, target) { target.dispatchEvent(new window.Event(name, { bubbles: true })); },
    key(key) { this.slider.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); },
    loadStorage() { finishStorage(); },
    storageRate(rate) { changes.forEach((callback) => callback({ [KEY]: { newValue: rate } }, "local")); }
  };
}

test("native speed button opens the replacement picker and presets set actual media speed", async (t) => {
  const page = setup(t);
  await page.flush();
  let nativeMenuOpened = false;
  page.button.addEventListener("click", () => { nativeMenuOpened = true; });
  page.open();
  assert.equal(nativeMenuOpened, false);
  assert.equal(page.panel.hidden, false);
  assert.equal(page.button.getAttribute("aria-expanded"), "true");
  page.panel.querySelector('[data-speed="1.5"]').click();
  assert.equal(page.video.playbackRate, 1.5);
  assert.equal(page.video.defaultPlaybackRate, 1.5);
  assert.equal(page.output, "1.5x");
  assert.equal(page.button.textContent, "1.5x");
  assert.equal(page.panel.querySelector('[data-speed="1.5"]').getAttribute("aria-pressed"), "true");
  assert.equal(page.writes.at(-1)[KEY], 1.5);
});

for (const key of ["extensionEnabled", "crunchyrollEnabled", "crunchyrollSpeedEnabled"]) {
  test(`${key} restores the native speed menu and stops enforcing the saved rate`, async (t) => {
    const page = setup(t, { saved: 2, settings: { [key]: false } });
    await page.flush();
    let nativeClicks = 0;
    page.button.addEventListener("click", () => { nativeClicks += 1; });
    page.open();
    assert.equal(nativeClicks, 1);
    assert.equal(page.panel, null);
    assert.equal(page.video.playbackRate, 1);
    page.changeSettings({ [key]: true });
    await page.flush();
    assert.equal(page.video.playbackRate, 2);
    page.open();
    assert.equal(page.panel.hidden, false);
    page.changeSettings({ [key]: false });
    assert.equal(page.panel.hidden, true);
    assert.equal(page.button.hasAttribute("aria-controls"), false);
    page.video.playbackRate = 1.25;
    page.event("ratechange", page.video);
    assert.equal(page.video.playbackRate, 1.25);
    page.open();
    assert.equal(nativeClicks, 2);
  });
}

test("slider applies custom rates immediately, saves on change, and plus/minus step by 0.05", async (t) => {
  const page = setup(t);
  await page.flush();
  page.open();
  page.slider.value = "1.3";
  page.event("input", page.slider);
  assert.equal(page.video.playbackRate, 1.3);
  assert.equal(page.writes.length, 0);
  page.event("change", page.slider);
  assert.equal(page.writes.at(-1)[KEY], 1.3);
  page.panel.querySelector('[data-adjust="-1"]').click();
  assert.equal(page.video.playbackRate, 1.25);
  page.panel.querySelector('[data-adjust="1"]').click();
  assert.equal(page.video.playbackRate, 1.3);
});

test("keyboard controls change speed without seeking and Escape restores button focus", async (t) => {
  const page = setup(t);
  await page.flush();
  page.video.currentTime = 45;
  page.open();
  let playerKeys = 0;
  page.document.addEventListener("keydown", () => { playerKeys += 1; });
  page.key("ArrowRight");
  assert.equal(page.video.playbackRate, 1.05);
  assert.equal(page.video.currentTime, 45);
  assert.equal(playerKeys, 0);
  page.key("Home");
  assert.equal(page.video.playbackRate, 0.25);
  assert.equal(page.panel.querySelector('[data-adjust="-1"]').disabled, true);
  page.key("End");
  assert.equal(page.video.playbackRate, 4);
  assert.equal(page.panel.querySelector('[data-adjust="1"]').disabled, true);
  page.key("Escape");
  assert.equal(page.panel.hidden, true);
  assert.equal(page.document.activeElement, page.button);
  assert.equal(page.button.getAttribute("aria-expanded"), "false");
});

test("saved speed applies to replacement videos and survives player resets", async (t) => {
  const page = setup(t, { saved: 2 });
  await page.flush();
  assert.equal(page.video.playbackRate, 2);
  page.video.playbackRate = 1;
  page.event("ratechange", page.video);
  assert.equal(page.video.playbackRate, 2);
  const replacement = page.document.createElement("video");
  page.video.replaceWith(replacement);
  await page.flush();
  assert.equal(replacement.playbackRate, 2);
  assert.equal(replacement.defaultPlaybackRate, 2);
});

test("slow settings load cannot overwrite a new speed choice", async (t) => {
  const page = setup(t, { saved: 2, delayedStorage: true });
  await page.flush();
  page.open();
  page.panel.querySelector('[data-speed="1.75"]').click();
  page.loadStorage();
  await page.flush();
  assert.equal(page.video.playbackRate, 1.75);
});

test("speed changes from another player frame update the video and picker", async (t) => {
  const page = setup(t);
  await page.flush();
  page.open();
  page.storageRate(1.75);
  await page.flush();
  assert.equal(page.video.playbackRate, 1.75);
  assert.equal(page.output, "1.75x");
});

test("without a saved choice the picker adopts an already working external speed", async (t) => {
  const page = setup(t);
  page.video.playbackRate = 1.3;
  await page.flush();
  page.open();
  assert.equal(page.video.playbackRate, 1.3);
  assert.equal(page.output, "1.3x");
  assert.equal(page.writes.length, 0);
});

test("picker stays within fullscreen and closes on outside click or episode navigation", async (t) => {
  const page = setup(t);
  await page.flush();
  page.open();
  const root = page.document.getElementById("player-container");
  Object.defineProperty(page.document, "fullscreenElement", { value: root });
  page.event("fullscreenchange", page.document);
  assert.equal(page.panel.parentElement, root);
  page.event("pointerdown", page.video);
  assert.equal(page.panel.hidden, true);
  page.open();
  page.window.history.pushState({}, "", "/watch/NEXT/episode");
  page.event("popstate", page.window);
  await page.flush();
  assert.equal(page.panel.hidden, true);
});

test("rejected rate shows an error and displays actual speed instead of a false success", async (t) => {
  const page = setup(t);
  await page.flush();
  Object.defineProperty(page.video, "playbackRate", { get: () => 1, set: () => { throw new Error("Rejected"); } });
  page.open();
  page.panel.querySelector('[data-speed="3"]').click();
  assert.equal(page.output, "1x");
  assert.equal(page.panel.querySelector("[role=status]").hidden, false);
  assert.match(page.panel.querySelector("[role=status]").textContent, /could not apply/);
});

test("rate-reset loops are bounded instead of fighting the player indefinitely", async (t) => {
  const page = setup(t);
  await page.flush();
  page.open();
  page.panel.querySelector('[data-speed="2"]').click();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    page.video.playbackRate = 1;
    page.event("ratechange", page.video);
  }
  assert.equal(page.video.playbackRate, 1);
  assert.match(page.panel.querySelector("[role=status]").textContent, /Disable Crunchyroll Speeder/);
});

test("Speeder-style DOM observer conflict stops retrying and recovers once the competing controller is off", async (t) => {
  const page = setup(t);
  await page.flush();
  const competitor = new page.window.MutationObserver(() => { page.video.playbackRate = 1.3; });
  competitor.observe(page.document.body, { attributes: true, childList: true, subtree: true });
  page.open();
  page.panel.querySelector('[data-speed="2"]').click();
  for (let event = 0; event < 8; event += 1) {
    page.document.body.dataset.playerTick = String(event);
    await page.flush();
    page.event("ratechange", page.video);
  }
  await page.flush();
  assert.equal(page.video.playbackRate, 1.3);
  assert.match(page.panel.querySelector("[role=status]").textContent, /restoring 1\.3x/);
  competitor.disconnect();
  page.panel.querySelector('[data-speed="1.75"]').click();
  await page.flush();
  assert.equal(page.video.playbackRate, 1.75);
  assert.equal(page.output, "1.75x");
  assert.equal(page.panel.querySelector("[role=status]").hidden, true);
});
