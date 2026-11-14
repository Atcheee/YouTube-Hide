const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");
const script = readFileSync(join(__dirname, "..", "crunchyroll-seek.js"), "utf8");
const flush = () => new Promise(setImmediate);

async function setup(t, settings = {}) {
  const dom = new JSDOM(`<div id="player-container"><video></video>
    <button aria-label="Jump backward 10 seconds"><svg></svg></button>
    <button aria-label="Jump forward 10 seconds" title="Forward"><svg></svg></button>
    <button aria-label="Skip Intro">Skip Intro</button><input type="range"><div role="dialog" tabindex="0"></div>
    </div><input id="search"><div contenteditable="true"><span id="editor">Text</span></div>`, {
    url: "https://www.crunchyroll.com/watch/SEEK", runScripts: "outside-only"
  });
  const { window } = dom;
  const observers = [];
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  t.after(async () => { observers.forEach(observer => observer.disconnect()); await flush(); window.close(); });
  const { document } = window;
  const video = document.querySelector("video");
  Object.defineProperties(video, {
    duration: { configurable: true, value: 100 }, readyState: { configurable: true, value: 4 },
    seekable: { configurable: true, value: { length: 0 } }
  });
  video.getClientRects = () => [{}];
  video.currentTime = 50;
  const change = installSettings(window, settings);
  let nativeClicks = 0;
  let nativeKeys = 0;
  const [back, forward, intro] = document.querySelectorAll("button");
  for (const [button, sign] of [[back, -1], [forward, 1]]) button.addEventListener("click", () => {
    nativeClicks++;
    video.currentTime += sign * 10;
  });
  document.addEventListener("keydown", event => {
    if (["ArrowLeft", "ArrowRight", "j", "l"].includes(event.key)) nativeKeys++;
  });
  window.eval(script);
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await flush();
  return { window, document, video, back, forward, intro, change,
    get nativeClicks() { return nativeClicks; }, get nativeKeys() { return nativeKeys; },
    key(key, target = document.body, options = {}) {
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
      target.dispatchEvent(event);
      return event;
    }
  };
}

test("five-second seeking is opt-in and native ten-second buttons work by default", async t => {
  const page = await setup(t);
  page.forward.click();
  assert.equal(page.video.currentTime, 60);
  assert.equal(page.nativeClicks, 1);
  assert.equal(page.back.getAttribute("aria-label"), "Jump backward 10 seconds");
});

test("enabled buttons seek five seconds exactly once and update accessible and visual labels", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  page.forward.querySelector("svg").dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(page.video.currentTime, 55);
  page.back.click();
  assert.equal(page.video.currentTime, 50);
  assert.equal(page.nativeClicks, 0);
  assert.equal(page.back.getAttribute("aria-label"), "Rewind 5 seconds");
  assert.equal(page.forward.getAttribute("title"), "Forward 5 seconds");
  assert.equal(page.back.querySelector(".playback-plus-seek-icon text").textContent, "5");
  assert.equal(page.back.querySelectorAll("svg").length, 2, "Keep the site's native icon intact");
  let intros = 0;
  page.intro.addEventListener("click", () => intros++);
  page.intro.click();
  assert.equal(intros, 1);
  assert.equal(page.video.currentTime, 50);
});

for (const key of ["crunchyrollFiveSecondSeekEnabled", "crunchyrollEnabled", "extensionEnabled"]) {
  test(`${key} restores original button attributes, icons and native behavior when disabled`, async t => {
    const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
    page.change({ [key]: false });
    await flush();
    assert.equal(page.forward.getAttribute("aria-label"), "Jump forward 10 seconds");
    assert.equal(page.forward.getAttribute("title"), "Forward");
    assert.equal(page.back.hasAttribute("title"), false);
    assert.equal(page.forward.querySelectorAll("svg").length, 1);
    page.forward.click();
    assert.equal(page.video.currentTime, 60);
  });
}

test("arrows seek five seconds, J/L seek ten and editing, sliders and modified shortcuts remain native", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true, crunchyrollKeyboardShortcutsEnabled: true });
  for (const key of ["ArrowRight", "l"]) {
    page.key(key);
    assert.equal(page.video.currentTime, key === "l" ? 65 : 55);
  }
  for (const key of ["ArrowLeft", "j"]) page.key(key);
  assert.equal(page.video.currentTime, 50);
  assert.equal(page.nativeKeys, 0);
  page.key("j", page.back);
  assert.equal(page.video.currentTime, 40, "J must still work after clicking a seek button");
  for (const selector of ["#search", "#editor", '[type="range"]', '[role="dialog"]', 'button[aria-label="Skip Intro"]']) {
    assert.equal(page.key("ArrowRight", page.document.querySelector(selector)).defaultPrevented, false);
  }
  assert.equal(page.key("ArrowRight", page.document.body, { ctrlKey: true }).defaultPrevented, false);
  assert.equal(page.video.currentTime, 40);
});

test("K toggles playback once while focused on the player and leaves typing alone", async t => {
  const page = await setup(t, { crunchyrollKeyboardShortcutsEnabled: true });
  let paused = true;
  let plays = 0;
  let pauses = 0;
  Object.defineProperty(page.video, "paused", { get: () => paused });
  page.video.play = () => { plays++; paused = false; return Promise.resolve(); };
  page.video.pause = () => { pauses++; paused = true; };
  assert.equal(page.key("k").defaultPrevented, true);
  assert.equal(plays, 1);
  assert.equal(paused, false);
  page.key("k");
  assert.equal(pauses, 1);
  assert.equal(paused, true);
  assert.equal(page.key("k", page.document.querySelector("#search")).defaultPrevented, false);
  assert.equal(plays, 1);
});

test("seeks clamp to video limits and live seekable windows", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  page.video.currentTime = 2;
  page.back.click();
  assert.equal(page.video.currentTime, 0);
  page.video.currentTime = 98;
  page.forward.click();
  assert.equal(page.video.currentTime, 100);
  Object.defineProperty(page.video, "duration", { value: Infinity });
  Object.defineProperty(page.video, "seekable", { value: { length: 1, start: () => 30, end: () => 90 } });
  page.video.currentTime = 32;
  page.back.click();
  assert.equal(page.video.currentTime, 30);
  page.video.currentTime = 88;
  page.forward.click();
  assert.equal(page.video.currentTime, 90);
});

test("replacement buttons work and reinjection cannot apply two seeks", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  page.forward.outerHTML = '<button aria-label="Jump forward 10 seconds"><svg></svg></button>';
  await flush();
  page.window.eval(script);
  page.document.querySelector('button[aria-label="Forward 5 seconds"]').click();
  assert.equal(page.video.currentTime, 55);
  assert.equal(page.document.querySelectorAll(".playback-plus-seek-icon").length, 2);
});

test("unloaded media leaves native controls alone", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  Object.defineProperty(page.video, "readyState", { value: 0 });
  assert.equal(page.key("ArrowRight").defaultPrevented, false);
  page.forward.click();
  assert.equal(page.nativeClicks, 1);
});

for (const five of [false, true]) {
  for (const keyboard of [false, true]) {
    test(`independent switches: five-second=${five}, J/K/L=${keyboard}`, async t => {
      const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: five, crunchyrollKeyboardShortcutsEnabled: keyboard });
      assert.equal(page.key("ArrowRight").defaultPrevented, five);
      assert.equal(page.video.currentTime, five ? 55 : 50);
      assert.equal(page.key("l").defaultPrevented, keyboard);
      assert.equal(page.video.currentTime, 50 + (five ? 5 : 0) + (keyboard ? 10 : 0));
      page.video.currentTime = 50;
      page.forward.click();
      assert.equal(page.video.currentTime, five ? 55 : 60);
      page.change({ crunchyrollFiveSecondSeekEnabled: !five });
      await flush();
      assert.equal(page.key("j").defaultPrevented, keyboard, "Changing five-second seeking must preserve J/L preference");
      page.change({ crunchyrollKeyboardShortcutsEnabled: !keyboard });
      await flush();
      assert.equal(page.key("ArrowLeft").defaultPrevented, !five, "Changing J/K/L must preserve arrow preference");
    });
  }
}

test("site and master pause also disable J/K/L when five-second seeking is off", async t => {
  const page = await setup(t, { crunchyrollKeyboardShortcutsEnabled: true });
  for (const key of ["crunchyrollEnabled", "extensionEnabled"]) {
    page.change({ [key]: false });
    assert.equal(page.key("j").defaultPrevented, false);
    assert.equal(page.key("k").defaultPrevented, false);
    page.change({ [key]: true });
    assert.equal(page.key("j").defaultPrevented, true);
  }
});
