const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");
const script = readFileSync(join(__dirname, "..", "crunchyroll-seek.js"), "utf8");
const flush = () => new Promise(setImmediate);

async function setup(t, settings = {}, { earlyNative = false } = {}) {
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
  // The page owns the seek operation. The extension only sends native commands.
  Object.defineProperty(window.navigator, "mediaSession", { value: { setActionHandler() {}, setPositionState() {} } });
  window.eval(readFileSync(join(__dirname, "..", "crunchyroll-player-bridge.js"), "utf8"));
  const mediaTime = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "currentTime");
  for (const [action, sign] of [["seekbackward", -1], ["seekforward", 1]]) {
    window.navigator.mediaSession.setActionHandler(action, ({ seekOffset }) => {
      const min = video.seekable.length ? video.seekable.start(0) : 0;
      const max = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
      mediaTime.set.call(video, Math.max(min, Math.min(max, video.currentTime + sign * seekOffset)));
    });
  }
  window.navigator.mediaSession.setActionHandler("play", () => video.play());
  window.navigator.mediaSession.setActionHandler("pause", () => video.pause());
  const change = installSettings(window, settings);
  let nativeClicks = 0;
  let nativeKeys = 0;
  if (earlyNative) window.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    nativeKeys++;
    video.currentTime += event.key === "ArrowLeft" ? -10 : 10;
    event.preventDefault();
  }, true);
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
  for (const selector of ["#search", "#editor", '[type="range"]', '[role="dialog"]']) {
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

test("custom seek key releases never reach unmatched native keyup handlers", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  let releases = 0;
  page.document.addEventListener("keyup", () => releases++);
  page.key("ArrowLeft");
  const up = key => page.document.body.dispatchEvent(new page.window.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  up("ArrowLeft");
  assert.equal(releases, 0);
  up("ArrowRight");
  assert.equal(releases, 1, "Do not swallow keys the extension did not handle");
});

test("native engine seeking works without touching raw media time or play(), even when paused=false", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  const time = Object.getOwnPropertyDescriptor(page.window.HTMLMediaElement.prototype, "currentTime");
  Object.defineProperties(page.video, {
    paused: { configurable: true, value: false },
    currentTime: { get: () => time.get.call(page.video), set() { throw new Error("Raw seeking stalls this engine"); } }
  });
  page.video.play = () => { throw new Error("play() cannot repair an engine-desynchronized seek"); };
  page.key("ArrowLeft");
  assert.equal(page.video.currentTime, 45);
  assert.equal(page.video.paused, false);
});

test("missing native seek support leaves the site's keyboard handling untouched", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  page.window.navigator.mediaSession.setActionHandler("seekbackward", null);
  page.window.navigator.mediaSession.setActionHandler("seekforward", null);
  assert.equal(page.key("ArrowLeft").defaultPrevented, false);
  assert.equal(page.video.currentTime, 50);
});

test("late attachment uses the native React timeline time and seek callback", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  page.window.navigator.mediaSession.setActionHandler("seekbackward", null);
  page.window.navigator.mediaSession.setActionHandler("seekforward", null);
  const slider = page.document.createElement("input");
  slider.type = "range";
  slider.className = "timeline-slider";
  slider.min = "0";
  slider.max = "100";
  slider.value = "20";
  let nativePosition;
  slider.__reactFiber$test = { memoizedProps: {}, return: {
    memoizedProps: { duration: 100, seekTo: value => { nativePosition = value; slider.value = String(value); } }, return: null
  } };
  page.document.getElementById("player-container").appendChild(slider);
  Object.defineProperty(page.video, "currentTime", { get() { throw new Error("The raw media clock differs from the native timeline"); } });
  await flush();
  assert.equal(page.key("ArrowLeft").defaultPrevented, true);
  assert.equal(nativePosition, 15);
  page.key("ArrowRight");
  assert.equal(nativePosition, 20);
});

test("the MAIN bridge only accepts bounded commands on a video and installs once", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  page.window.eval(readFileSync(join(__dirname, "..", "crunchyroll-player-bridge.js"), "utf8"));
  let calls = 0;
  page.window.navigator.mediaSession.setActionHandler("seekbackward", () => calls++);
  page.key("ArrowLeft");
  assert.equal(calls, 1);
  const command = detail => new page.window.CustomEvent("playback-plus-native-command-v3", {
    bubbles: true, cancelable: true, detail: JSON.stringify(detail)
  });
  assert.equal(page.video.dispatchEvent(command({ action: "seekbackward", seconds: 500 })), true);
  assert.equal(page.document.body.dispatchEvent(command({ action: "seekbackward", seconds: 5 })), true);
  assert.equal(calls, 1);
});

test("the first arrow press beats a native window-capture ten-second shortcut", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true }, { earlyNative: true });
  page.key("ArrowLeft");
  assert.equal(page.video.currentTime, 45);
  assert.equal(page.nativeKeys, 0);
});

test("five-second arrows work immediately with focus on native Play and timeline controls", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  const play = page.document.createElement("button");
  play.setAttribute("aria-label", "Play");
  page.document.getElementById("player-container").appendChild(play);
  assert.equal(page.key("ArrowLeft", play).defaultPrevented, true);
  assert.equal(page.video.currentTime, 45);
  const timeline = page.document.querySelector('[type="range"]');
  timeline.classList.add("timeline-slider");
  assert.equal(page.key("ArrowRight", timeline).defaultPrevented, true);
  assert.equal(page.video.currentTime, 50);
});

test("held arrows accumulate while the native UI clock buffers and reset on episode changes", async t => {
  const page = await setup(t, { crunchyrollFiveSecondSeekEnabled: true });
  const positions = [];
  page.window.navigator.mediaSession.setActionHandler("seekto", ({ seekTime }) => positions.push(seekTime));
  page.window.navigator.mediaSession.setPositionState({ position: 50, duration: 100 });
  page.key("ArrowLeft"); page.key("ArrowLeft"); page.key("ArrowRight");
  assert.deepEqual(positions, [45, 40, 45]);
  page.window.history.pushState({}, "", "/watch/NEXT");
  page.window.navigator.mediaSession.setPositionState({ position: 20, duration: 100 });
  page.key("ArrowLeft");
  assert.equal(positions.at(-1), 15);
  page.video.dispatchEvent(new page.window.Event("loadedmetadata"));
  page.window.navigator.mediaSession.setPositionState({ position: 70, duration: 100 });
  page.key("ArrowRight");
  assert.equal(positions.at(-1), 75);
});
