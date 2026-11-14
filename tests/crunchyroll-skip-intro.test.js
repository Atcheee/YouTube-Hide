const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { JSDOM } = require("jsdom");

const script = readFileSync(join(__dirname, "..", "crunchyroll-skip-intro.js"), "utf8");
const background = readFileSync(join(__dirname, "..", "background.js"), "utf8");
const fixture = readFileSync(join(__dirname, "fixtures", "crunchyroll-skip-intro.html"), "utf8");

function setup(t, { url = "https://www.crunchyroll.com/watch/EPISODE1/title", markup = fixture, relay } = {}) {
  const dom = new JSDOM(`<div id="player"><video></video>${markup}</div>`, { url, runScripts: "outside-only" });
  if (relay) dom.reconfigure({ windowTop: {} });
  const { window } = dom;
  const { document } = window;
  const listeners = [];
  const observers = [];
  const pollers = [];
  const timers = new Map();
  const messages = [];
  let timerId = 0;
  let now = 1000;
  let clicks = 0;
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  t.after(() => {
    observers.forEach((observer) => observer.disconnect());
    window.close();
  });
  window.chrome = { runtime: {
    id: "test-extension",
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: (message, callback) => {
      messages.push(message);
      if (relay) relay(message, callback);
      else callback({ ok: true });
    }
  } };
  window.Date.now = () => now;
  window.Element.prototype.getClientRects = () => [{ width: 160, height: 44 }];
  const video = document.querySelector("video");
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  video.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 450 });
  window.requestAnimationFrame = () => assert.fail("Background skipping must not need animation frames");
  window.focus = () => assert.fail("Must not focus the tab");
  window.setInterval = (callback) => { pollers.push(callback); return pollers.length; };
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = (id) => timers.delete(id);
  document.addEventListener("click", () => { clicks += 1; });
  document.addEventListener("mousemove", () => assert.fail("Crunchyroll does not need simulated hover"));
  window.eval(script);
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return {
    window, document, video, listeners, timers, messages,
    get button() { return document.querySelector("button"); },
    get player() { return document.getElementById("player"); },
    get notice() { return document.querySelector(".youtube-hide-crunchyroll-notice"); },
    get clicks() { return clicks; },
    flush: () => new Promise(setImmediate),
    poll() { now += 1001; pollers.forEach((callback) => callback()); },
    event(name, target = document) { target.dispatchEvent(new window.Event(name)); },
    navigate(path) { window.history.pushState({}, "", path); this.poll(); }
  };
}

function makeRelay(topPage) {
  let listener;
  runInNewContext(background, { URL, chrome: {
    runtime: { onMessage: { addListener: (callback) => { listener = callback; } } },
    tabs: { sendMessage(tabId, message, options, callback) {
      assert.equal(tabId, 7);
      assert.equal(options.frameId, 0);
      queueMicrotask(() => topPage.listeners[0](message, { id: "test-extension" }, callback));
    } }
  } });
  return (message, callback) => queueMicrotask(() => listener(message, {
    url: "https://static.crunchyroll.com/vilos-v2/web/vilos/player.html",
    frameId: 3, tab: { id: 7 }
  }, callback));
}

test("clicks supplied hover-hidden intro button without hover and only once after a rewind", async (t) => {
  const page = setup(t);
  page.button.style.opacity = "0";
  page.button.style.pointerEvents = "none";
  await page.flush();
  assert.equal(page.clicks, 1);
  assert.equal(page.button.getAttribute("aria-hidden"), "true");
  assert.equal(page.notice.textContent, "Jumped ahead");
  page.button.remove();
  page.player.insertAdjacentHTML("beforeend", fixture);
  page.event("seeked", page.video);
  page.poll();
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("also clicks the visible intro state", async (t) => {
  const page = setup(t);
  page.button.setAttribute("aria-hidden", "false");
  page.button.classList.replace("kat:opacity-0", "kat:opacity-100");
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("each episode gets one skip, including localized URLs and return navigation", async (t) => {
  const page = setup(t);
  await page.flush();
  page.navigate("/en/watch/EPISODE2/another-title");
  await page.flush();
  assert.equal(page.clicks, 2);
  page.navigate("/watch/EPISODE1/title");
  await page.flush();
  assert.equal(page.clicks, 2);
});

test("manual skip suppresses later auto-skip and shows no automatic notice", async (t) => {
  const page = setup(t);
  page.button.querySelector("span").click();
  await page.flush();
  page.poll();
  await page.flush();
  assert.equal(page.clicks, 1);
  assert.equal(page.notice, null);
});

test("notice centers on the video, moves into fullscreen, and expires after two seconds", async (t) => {
  const page = setup(t);
  await page.flush();
  assert.equal(page.notice.style.left, "410px");
  assert.equal(page.notice.style.top, "245px");
  assert.equal(page.notice.getAttribute("role"), "status");
  Object.defineProperty(page.document, "fullscreenElement", { value: page.player });
  page.event("fullscreenchange");
  assert.equal(page.notice.parentElement, page.player);
  const timer = [...page.timers.values()][0];
  assert.equal(timer.delay, 2000);
  timer.callback();
  assert.equal(page.notice, null);
});

test("detects intro button inserted during playback", async (t) => {
  const page = setup(t, { markup: "" });
  await page.flush();
  page.player.insertAdjacentHTML("beforeend", fixture);
  await page.flush();
  assert.equal(page.clicks, 1);
});

for (const [name, block, unblock] of [
  ["disabled", (p) => { p.button.disabled = true; }, (p) => { p.button.disabled = false; }],
  ["aria-disabled", (p) => p.button.setAttribute("aria-disabled", "true"), (p) => p.button.removeAttribute("aria-disabled")],
  ["hidden ancestor", (p) => { p.player.hidden = true; }, (p) => { p.player.hidden = false; }],
  ["display:none", (p) => { p.button.style.display = "none"; }, (p) => { p.button.style.display = ""; }],
  ["unloaded video", (p) => Object.defineProperty(p.video, "readyState", { value: 0 }), (p) => Object.defineProperty(p.video, "readyState", { value: 4 })]
]) {
  test(`does not consume the skip while ${name}`, async (t) => {
    const page = setup(t);
    block(page);
    await page.flush();
    assert.equal(page.clicks, 0);
    unblock(page);
    page.poll();
    await page.flush();
    assert.equal(page.clicks, 1);
  });
}

test("does not click recaps, credits, or text-only lookalikes", async (t) => {
  for (const markup of [fixture.replaceAll("Skip Intro", "Skip Credits"),
    fixture.replaceAll("Skip Intro", "Skip Recap"), fixture.replace("skip-intro-icon", "other-icon")]) {
    const page = setup(t, { markup });
    await page.flush();
    assert.equal(page.clicks, 0);
  }
});

test("does not skip outside watch pages", async (t) => {
  const page = setup(t, { url: "https://www.crunchyroll.com/series/SERIES1" });
  await page.flush();
  assert.equal(page.clicks, 0);
});

test("player-frame claims survive iframe replacement and reset for a different episode", async (t) => {
  const top = setup(t, { markup: "" });
  const relay = makeRelay(top);
  const frame = setup(t, { url: "https://static.crunchyroll.com/vilos-v2/web/vilos/player.html", relay });
  await frame.flush();
  assert.equal(frame.clicks, 1);
  const replacement = setup(t, { url: "https://static.crunchyroll.com/vilos-v2/web/vilos/player.html", relay });
  await replacement.flush();
  assert.equal(replacement.clicks, 0);
  top.navigate("/watch/EPISODE2/title");
  replacement.poll();
  await replacement.flush();
  assert.equal(replacement.clicks, 1);
});

test("a manual intro skip in the player frame is remembered on the watch page", async (t) => {
  const top = setup(t, { markup: "" });
  const frame = setup(t, { url: "https://static.crunchyroll.com/vilos-v2/web/vilos/player.html", relay: makeRelay(top) });
  frame.button.click();
  await frame.flush();
  frame.poll();
  await frame.flush();
  assert.equal(frame.clicks, 1);
  assert.equal(frame.notice, null);
});

test("relay rejects unrelated domains and lookalike hosts", () => {
  let listener;
  runInNewContext(background, { URL, chrome: {
    runtime: { onMessage: { addListener: (callback) => { listener = callback; } } },
    tabs: { sendMessage: () => assert.fail("Must not relay unrelated frames") }
  } });
  for (const url of ["https://evilcrunchyroll.com/", "https://crunchyroll.com.evil.example/", "https://youtube.com/"]) {
    assert.equal(listener({ type: "crunchyroll-skip-intro" }, { url, frameId: 1, tab: { id: 7 } }, () => {}), false);
  }
});

test("manifest registers Crunchyroll player frames and keeps YouTube scripts scoped to YouTube", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));
  const crunchyroll = manifest.content_scripts.find((entry) => entry.js.includes("crunchyroll-skip-intro.js"));
  assert.equal(crunchyroll.all_frames, true);
  assert.ok(crunchyroll.matches.includes("*://*.crunchyroll.com/*"));
  assert.equal(crunchyroll.js.includes("content.js"), false);
  assert.equal(manifest.background.service_worker, "background.js");
});

test("matches the supplied Bitmovin player wrapper on the failing episode URL", async (t) => {
  const page = setup(t, { markup: "", url: "https://www.crunchyroll.com/watch/G4VUQ2GZ7/maxing-defense-and-christmas" });
  const player = page.player;
  player.id = "player-container";
  player.className = "player-container";
  const mediaRoot = page.document.createElement("div");
  mediaRoot.className = "bitmovinplayer-container aspect-16x9";
  page.video.before(mediaRoot);
  mediaRoot.appendChild(page.video);
  player.insertAdjacentHTML("beforeend", `<div style="width:100%;height:100%;position:absolute;top:0;left:0">
    <div class="katamariDesktop kat:h-full kat:w-full"><div data-testid="player-controls-root"
    class="kat:relative kat:flex kat:flex-col kat:h-full kat:w-full kat:cursor-none">${fixture}</div></div></div>`);
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("intro controls do not require media in the same document", async (t) => {
  const page = setup(t, { markup: "" });
  page.video.remove();
  page.player.innerHTML = `<div data-testid="player-controls-root">${fixture}</div>`;
  const controls = page.player.firstElementChild;
  controls.getBoundingClientRect = () => ({ left: 20, top: 30, width: 1000, height: 600 });
  await page.flush();
  assert.equal(page.clicks, 1);
  assert.equal(page.notice.style.left, "520px");
  assert.equal(page.notice.style.top, "330px");
});

test("finds intro controls inside an open shadow root", async (t) => {
  const page = setup(t, { markup: "" });
  const host = page.document.createElement("div");
  page.player.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<div data-testid="player-controls-root">${fixture}</div>`;
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("cancelled frame requests release their claim so a replacement button can be skipped", async (t) => {
  const top = setup(t, { markup: "" });
  const relay = makeRelay(top);
  let frame;
  let replace = true;
  frame = setup(t, { url: "https://static.crunchyroll.com/vilos-v2/web/vilos/player.html", relay: (message, callback) => {
    relay(message, (response) => {
      if (!message.action && !message.manual && replace) {
        replace = false;
        frame.button.remove();
        frame.player.insertAdjacentHTML("beforeend", fixture);
      }
      callback(response);
    });
  } });
  await frame.flush();
  assert.equal(frame.clicks, 0);
  frame.poll();
  await frame.flush();
  assert.equal(frame.clicks, 1);
});

test("diagnostics report the actual reason a detected button cannot be clicked", async (t) => {
  const page = setup(t);
  Object.defineProperty(page.video, "readyState", { value: 0 });
  await page.flush();
  page.listeners[0]({ type: "crunchyroll-report-status" }, { id: "test-extension" }, () => {});
  const status = page.messages.find((message) => message.type === "crunchyroll-status").status;
  assert.equal(status.buttons, 1);
  assert.equal(status.videos, 1);
  assert.equal(status.state, "Video is loading, ended, or seeking");
  assert.equal(status.version, "1.7.2");
});

test("background diagnostics collect reports from watch and player frames", () => {
  let listener;
  let finish;
  let result;
  runInNewContext(background, { URL, setTimeout: (callback) => { finish = callback; }, chrome: {
    runtime: { onMessage: { addListener: (callback) => { listener = callback; } } },
    tabs: { sendMessage(tabId, message, callback) {
      assert.equal(tabId, 7);
      assert.equal(message.type, "crunchyroll-report-status");
      listener({ type: "crunchyroll-status", status: { frame: "Watch page", buttons: 0 } },
        { url: "https://www.crunchyroll.com/watch/EPISODE1/title", frameId: 0, tab: { id: 7 } }, () => {});
      listener({ type: "crunchyroll-status", status: { frame: "Player frame", buttons: 1 } },
        { url: "https://static.crunchyroll.com/player.html", frameId: 3, tab: { id: 7 } }, () => {});
      callback({ ok: true });
    } }
  } });
  listener({ type: "crunchyroll-get-status", tabId: 7 }, {}, (response) => { result = response; });
  finish();
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[1].buttons, 1);
});
