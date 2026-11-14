const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");

const script = readFileSync(join(__dirname, "..", "jump-ahead.js"), "utf8");
const overlay = readFileSync(join(__dirname, "fixtures", "jump-ahead.html"), "utf8");

function setup(t, markup = overlay, url = "https://www.youtube.com/watch?v=first") {
  const dom = new JSDOM(`<div id="movie_player"><video></video>${markup}</div>`, {
    url,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;
  const observers = [];
  const NativeMutationObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  t.after(() => {
    // Disconnect before jsdom tears down location and removes the document body.
    observers.forEach((observer) => observer.disconnect());
    window.close();
  });
  const pollers = [];
  let clicks = 0;
  // jsdom has no layout. Supply a box; CSS and hidden-ancestor checks remain real.
  window.Element.prototype.getClientRects = () => [{ width: 140, height: 40 }];
  window.requestAnimationFrame = () => { throw new Error("Animation frames unavailable in background tab"); };
  window.setInterval = (callback, delay) => {
    assert.equal(delay, 1000);
    pollers.push(callback);
    return pollers.length;
  };
  document.addEventListener("click", () => { clicks += 1; });
  window.eval(script);
  document.dispatchEvent(new window.Event("DOMContentLoaded"));

  return {
    window,
    document,
    get clicks() { return clicks; },
    get button() { return document.querySelector("button"); },
    get player() { return document.getElementById("movie_player"); },
    async flush() {
      await new Promise(setImmediate);
    },
    poll() { pollers.forEach((callback) => callback()); },
    event(name, target = document) { target.dispatchEvent(new window.Event(name)); },
    navigate(url) {
      this.event("yt-navigate-start");
      window.history.pushState({}, "", url);
      this.event("yt-navigate-finish");
    }
  };
}

test("clicks the supplied Jump ahead overlay once, even after rewinds and DOM replacement", async (t) => {
  const page = setup(t);
  await page.flush();
  assert.equal(page.clicks, 1);
  for (const event of ["timeupdate", "seeked", "playing"]) {
    page.event(event, page.document.querySelector("video"));
    await page.flush();
  }
  page.player.innerHTML = overlay;
  page.event("yt-navigate-finish");
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("each new video gets one click; playlist changes and returning to old videos do not reset it", async (t) => {
  const page = setup(t);
  await page.flush();
  page.navigate("/watch?v=first&list=WL&index=4&t=10");
  await page.flush();
  assert.equal(page.clicks, 1);
  page.navigate("/watch?v=second");
  await page.flush();
  assert.equal(page.clicks, 2);
  page.navigate("/feed/history");
  await page.flush();
  page.navigate("/watch?v=first");
  await page.flush();
  assert.equal(page.clicks, 2);
});

test("does not click stale controls during navigation", async (t) => {
  const page = setup(t);
  page.event("yt-navigate-start");
  page.window.history.pushState({}, "", "/watch?v=second");
  page.button.style.color = "red";
  await page.flush();
  assert.equal(page.clicks, 0);
  page.event("yt-navigate-finish");
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("detects an overlay inserted after startup", async (t) => {
  const page = setup(t, "");
  await page.flush();
  assert.equal(page.clicks, 0);
  page.player.insertAdjacentHTML("beforeend", overlay);
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("ignores unrelated feedback shapes and buttons outside the correct overlay/player", async (t) => {
  const page = setup(t, overlay.replace("Jump ahead", "Play"));
  page.document.body.insertAdjacentHTML("beforeend", overlay);
  page.player.insertAdjacentHTML("beforeend", '<button>Jump ahead<div class="ytSpecTouchFeedbackShapeFill"></div></button>');
  await page.flush();
  assert.equal(page.clicks, 0);
  page.document.querySelector(".ytSpecButtonShapeNextButtonTextContent").firstChild.data = "Jump ahead";
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("a manual skip before the first scan prevents later automatic skips", async (t) => {
  const page = setup(t);
  page.button.querySelector(".ytSpecButtonShapeNextButtonTextContent").click();
  assert.equal(page.clicks, 1);
  await page.flush();
  page.player.innerHTML = overlay;
  page.event("seeked");
  await page.flush();
  assert.equal(page.clicks, 1);
  assert.equal(page.document.querySelector(".youtube-hide-jump-notice"), null);
});

test("automatic skip shows a player notice for two seconds without repeating on rewind", async (t) => {
  const page = setup(t);
  let dismiss;
  t.mock.method(page.window, "setTimeout", (callback, delay) => {
    assert.equal(delay, 2000);
    dismiss = callback;
    return 1;
  });
  await page.flush();
  const notice = page.player.querySelector(".youtube-hide-jump-notice");
  assert.ok(notice);
  assert.equal(notice.textContent, "Jumped ahead");
  assert.equal(notice.getAttribute("role"), "status");
  assert.equal(notice.parentElement, page.player);
  dismiss();
  assert.equal(page.player.querySelector(".youtube-hide-jump-notice"), null);
  page.event("seeked");
  await page.flush();
  assert.equal(page.player.querySelector(".youtube-hide-jump-notice"), null);
  assert.equal(page.clicks, 1);
});

test("navigation clears the notice and the next video's skip shows one new notice", async (t) => {
  const page = setup(t);
  await page.flush();
  assert.equal(page.player.querySelectorAll(".youtube-hide-jump-notice").length, 1);
  page.event("yt-navigate-start");
  assert.equal(page.player.querySelector(".youtube-hide-jump-notice"), null);
  page.window.history.pushState({}, "", "/watch?v=second");
  page.event("yt-navigate-finish");
  await page.flush();
  assert.equal(page.player.querySelectorAll(".youtube-hide-jump-notice").length, 1);
  assert.equal(page.clicks, 2);
});

for (const [name, hide, show] of [
  ["hidden ancestor", (p) => { p.player.hidden = true; }, (p) => { p.player.hidden = false; }],
  ["inert ancestor", (p) => p.player.setAttribute("inert", ""), (p) => p.player.removeAttribute("inert")],
  ["aria-hidden ancestor", (p) => p.player.setAttribute("aria-hidden", "true"), (p) => p.player.removeAttribute("aria-hidden")],
  ["display:none", (p) => { p.player.style.display = "none"; }, (p) => { p.player.style.display = ""; }],
  ["visibility:hidden", (p) => { p.button.style.visibility = "hidden"; }, (p) => { p.button.style.visibility = ""; }],
  ["transparent ancestor", (p) => { p.player.style.opacity = "0"; }, (p) => { p.player.style.opacity = "1"; }],
  ["disabled button", (p) => { p.button.disabled = true; }, (p) => { p.button.disabled = false; }],
  ["aria-disabled button", (p) => p.button.setAttribute("aria-disabled", "true"), (p) => p.button.setAttribute("aria-disabled", "false")]
]) {
  test(`waits until ${name} becomes available without consuming its one click`, async (t) => {
    const page = setup(t);
    hide(page);
    await page.flush();
    assert.equal(page.clicks, 0);
    show(page);
    await page.flush();
    assert.equal(page.clicks, 1);
  });
}

test("waits for a layout box, including a visibility change without DOM mutation", async (t) => {
  const page = setup(t);
  page.button.getClientRects = () => [];
  await page.flush();
  assert.equal(page.clicks, 0);
  page.button.getClientRects = () => [{ width: 140, height: 40 }];
  page.event("transitionend", page.button);
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("does not click a watch-page control without a video ID", async (t) => {
  const page = setup(t, overlay, "https://www.youtube.com/");
  await page.flush();
  assert.equal(page.clicks, 0);
});

function setPlaying(page) {
  const video = page.player.querySelector("video");
  Object.defineProperties(video, {
    paused: { value: false, configurable: true },
    readyState: { value: 4, configurable: true }
  });
  return video;
}

test("reveals a hover-created prompt in a background tab without focus or animation frames", async (t) => {
  const page = setup(t, "");
  const video = setPlaying(page);
  Object.defineProperty(page.document, "hidden", { value: true });
  t.mock.method(page.window, "focus", () => assert.fail("Must not focus the tab"));
  let movements = 0;
  page.player.addEventListener("mousemove", (event) => {
    assert.equal(event.target, video);
    assert.equal(event.isTrusted, false);
    movements += 1;
    page.player.insertAdjacentHTML("beforeend", overlay);
  });
  await page.flush();
  assert.equal(movements, 1);
  assert.equal(page.clicks, 1);
  page.player.querySelector(".ytp-overlay-inline-container").remove();
  page.player.insertAdjacentHTML("beforeend", overlay);
  page.event("seeked", video);
  page.poll();
  await page.flush();
  assert.equal(movements, 1);
  assert.equal(page.clicks, 1);
});

test("reveals faded player actions in a visible but unfocused window", async (t) => {
  const page = setup(t);
  setPlaying(page);
  Object.defineProperty(page.document, "hidden", { value: false });
  t.mock.method(page.document, "hasFocus", () => false);
  const actions = page.player.querySelector(".ytp-timely-actions-overlay");
  actions.style.opacity = "0";
  page.player.addEventListener("mousemove", () => { actions.style.opacity = "1"; });
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("fallback polling detects availability without DOM, playback or animation-frame events", async (t) => {
  const page = setup(t);
  let hasBox = false;
  page.button.getClientRects = () => hasBox ? [{ width: 140, height: 40 }] : [];
  await page.flush();
  assert.equal(page.clicks, 0);
  hasBox = true;
  page.poll();
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("unattended playback checks are limited to one simulated movement per second", async (t) => {
  const page = setup(t, "");
  const video = setPlaying(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let movements = 0;
  page.player.addEventListener("mousemove", () => { movements += 1; });
  await page.flush();
  assert.equal(movements, 1);
  page.event("timeupdate", video);
  page.poll();
  await page.flush();
  assert.equal(movements, 1);
  now += 1000;
  page.poll();
  await page.flush();
  assert.equal(movements, 2);
  assert.equal(page.clicks, 0);
});

test("focused playback also requests hover actions when the cursor is away from the timeline", async (t) => {
  const page = setup(t, "");
  setPlaying(page);
  Object.defineProperty(page.document, "hidden", { value: false });
  t.mock.method(page.document, "hasFocus", () => true);
  let movements = 0;
  page.player.addEventListener("mousemove", () => { movements += 1; });
  await page.flush();
  assert.equal(movements, 1);
});

test("does not click hidden actions if YouTube ignores simulated movement", async (t) => {
  const page = setup(t);
  setPlaying(page);
  page.button.style.opacity = "0";
  await page.flush();
  page.poll();
  await page.flush();
  assert.equal(page.clicks, 0);
  assert.equal(page.player.querySelector(".youtube-hide-jump-notice"), null);
});

test("paused video does not receive simulated movement", async (t) => {
  const page = setup(t, "");
  let movements = 0;
  page.player.addEventListener("mousemove", () => { movements += 1; });
  await page.flush();
  page.poll();
  await page.flush();
  assert.equal(movements, 0);
});

function addTimeline(page, duration = 600, currentTime = 120) {
  const video = setPlaying(page);
  Object.defineProperty(video, "duration", { value: duration });
  video.currentTime = currentTime;
  page.player.insertAdjacentHTML("beforeend",
    '<div class="ytp-progress-bar-container"><div class="ytp-progress-bar" role="slider"></div></div>');
  const timeline = page.player.querySelector(".ytp-progress-bar");
  timeline.getBoundingClientRect = () => ({ left: 100, top: 400, width: 800, height: 6 });
  return { video, timeline, container: timeline.parentElement };
}

test("background skip checks never activate timeline previews or seek the video", async (t) => {
  const page = setup(t, "");
  const { video, timeline, container } = addTimeline(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let timelineEvents = 0;
  for (const target of [timeline, container]) {
    for (const type of ["mouseover", "mouseenter", "mousemove", "pointerover", "pointerenter",
      "pointermove", "mousedown", "mouseup", "pointerdown", "pointerup", "click"]) {
      target.addEventListener(type, () => { timelineEvents += 1; });
    }
  }
  for (let check = 0; check < 3; check += 1) {
    now += 1000;
    page.poll();
    page.event("timeupdate", video);
    await page.flush();
  }
  assert.equal(timelineEvents, 0);
  assert.equal(video.currentTime, 120);
  assert.equal(page.clicks, 0);
  page.player.insertAdjacentHTML("beforeend", overlay);
  await page.flush();
  assert.equal(page.clicks, 1);
  assert.equal(timelineEvents, 0);
});

test("real timeline hover still works and a resulting Jump ahead prompt is clicked only once", async (t) => {
  const page = setup(t, "");
  const { timeline, video } = addTimeline(page);
  let previews = 0;
  timeline.addEventListener("mousemove", () => {
    previews += 1;
    page.player.insertAdjacentHTML("beforeend", overlay);
  });
  await page.flush();
  assert.equal(previews, 0);
  timeline.dispatchEvent(new page.window.MouseEvent("mousemove", { bubbles: true }));
  await page.flush();
  assert.equal(previews, 1);
  assert.equal(page.clicks, 1);
  page.event("seeked", video);
  page.poll();
  await page.flush();
  assert.equal(previews, 1);
  assert.equal(page.clicks, 1);
});
