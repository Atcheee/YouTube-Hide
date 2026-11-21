const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");

const script = readFileSync(join(__dirname, "..", "jump-ahead.js"), "utf8");
const overlay = readFileSync(join(__dirname, "fixtures", "jump-ahead.html"), "utf8");
const styles = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

function setup(t, markup = overlay, url = "https://www.youtube.com/watch?v=first", settings = {}) {
  const dom = new JSDOM(`<style>${styles}</style><div id="movie_player"><video></video>${markup}</div>`, {
    url,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const { document } = window;
  const userInputHandlers = [];
  const addListener = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, ...options) => {
    userInputHandlers.push({ type, listener });
    return addListener(type, listener, ...options);
  };
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
  const changeSettings = installSettings(window, settings);
  window.eval(script);
  document.dispatchEvent(new window.Event("DOMContentLoaded"));

  return {
    window,
    document,
    changeSettings,
    get clicks() { return clicks; },
    get button() { return document.querySelector("button"); },
    get player() { return document.getElementById("movie_player"); },
    async flush() {
      await new Promise(setImmediate);
    },
    poll() { pollers.forEach((callback) => callback()); },
    userPointerMove(target) {
      // DOM-created events are always untrusted. Exercise the native-input boundary.
      userInputHandlers.filter((entry) => entry.type === "pointermove")
        .forEach(({ listener }) => listener({ isTrusted: true, type: "pointermove", target, buttons: 0 }));
    },
    userEvent(type, target, extras = {}) {
      userInputHandlers.filter((entry) => entry.type === type)
        .forEach(({ listener }) => listener({ isTrusted: true, type, target, buttons: 0, ...extras }));
    },
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

test("skips successive segments in one video while leaving rewinds and stale prompts alone", async (t) => {
  const page = setup(t);
  const video = page.player.querySelector("video");
  video.currentTime = 12;
  page.button.addEventListener("click", () => { video.currentTime = 25; }, { once: true });
  await page.flush();
  assert.equal(page.clicks, 1);

  // A stale button can still be visible after the playhead advances.
  video.currentTime = 29;
  page.event("timeupdate", video);
  await page.flush();
  assert.equal(page.clicks, 1);

  const prompt = page.button.parentElement.closest(".ytp-timely-actions-overlay");
  prompt.hidden = true;
  await page.flush();
  video.currentTime = 42;
  page.button.addEventListener("click", () => { video.currentTime = 61; }, { once: true });
  prompt.hidden = false;
  await page.flush();
  assert.equal(page.clicks, 2, "a later segment may reuse the native button");
  assert.equal(video.currentTime, 61);

  page.player.querySelector(".ytp-timely-actions-overlay").remove();
  page.player.insertAdjacentHTML("beforeend", overlay);
  for (const position of [9, 23, 41, 58]) {
    video.currentTime = position;
    page.event("seeked", video);
    await page.flush();
    assert.equal(page.clicks, 2, "rewinding into either skipped segment stays manual");
  }
});

test("a manual Jump ahead with an asynchronous landing protects only earlier playback", async (t) => {
  const page = setup(t);
  const video = page.player.querySelector("video");
  video.currentTime = 12;
  page.button.click();
  video.currentTime = 30;
  page.event("seeking", video);
  await page.flush();
  assert.equal(page.clicks, 1);
  page.player.querySelector(".ytp-timely-actions-overlay").remove();
  video.currentTime = 25;
  page.player.insertAdjacentHTML("beforeend", overlay);
  await page.flush();
  assert.equal(page.clicks, 1);
  video.currentTime = 50;
  page.event("timeupdate", video);
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

test("timeline checks reveal and skip a prompt without leaving a thumbnail preview open", async (t) => {
  const page = setup(t, "");
  const { video, timeline, container } = addTimeline(page);
  const tooltip = page.document.createElement("div");
  tooltip.className = "ytp-tooltip";
  tooltip.style.visibility = "hidden";
  page.player.appendChild(tooltip);
  let hovers = 0;
  let leaves = 0;
  let timelineClicks = 0;
  let entered = false;
  container.addEventListener("mouseenter", () => { entered = true; });
  timeline.addEventListener("mouseleave", () => {
    leaves += 1;
    tooltip.style.visibility = "hidden";
  });
  timeline.addEventListener("mousemove", (event) => {
    hovers += 1;
    assert.equal(entered, true);
    assert.equal(event.clientX, 260);
    assert.equal(event.clientY, 403);
    tooltip.style.visibility = "visible";
    assert.equal(page.window.getComputedStyle(tooltip).display, "none");
    page.window.queueMicrotask(() => page.player.insertAdjacentHTML("beforeend", overlay));
  });
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "click"]) {
    timeline.addEventListener(type, () => { timelineClicks += 1; });
  }
  await page.flush();
  assert.equal(hovers, 1);
  assert.equal(leaves, 1);
  assert.equal(timelineClicks, 0);
  assert.equal(video.currentTime, 120);
  assert.equal(page.clicks, 1);
  assert.equal(page.window.getComputedStyle(tooltip).display, "none");
  // A delayed thumbnail update must remain hidden after the synthetic hover ends.
  tooltip.style.visibility = "visible";
  page.event("seeked", video);
  page.poll();
  await page.flush();
  assert.equal(hovers, 1);
  assert.equal(page.clicks, 1);
  assert.equal(page.window.getComputedStyle(tooltip).display, "none");
});

test("an unsuccessful timeline check sends leave events and keeps delayed previews suppressed", async (t) => {
  const page = setup(t, "");
  const { timeline } = addTimeline(page);
  let expireProbe;
  const setTimeout = page.window.setTimeout.bind(page.window);
  t.mock.method(page.window, "setTimeout", (callback, delay) => {
    if (delay === 250) { expireProbe = callback; return -1; }
    return setTimeout(callback, delay);
  });
  let hovered = false;
  timeline.addEventListener("mouseenter", () => { hovered = true; });
  timeline.addEventListener("mouseleave", () => { hovered = false; });
  await page.flush();
  assert.equal(hovered, true);
  expireProbe();
  assert.equal(hovered, false);
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), true);
  assert.equal(page.clicks, 0);
  page.event("yt-navigate-start");
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), false);
});

test("genuine user input restores normal previews and hands control back without a fake leave", async (t) => {
  const page = setup(t, "");
  const { timeline } = addTimeline(page);
  const tooltip = page.document.createElement("div");
  tooltip.className = "ytp-tooltip";
  page.player.appendChild(tooltip);
  let leaves = 0;
  timeline.addEventListener("mouseleave", () => { leaves += 1; });
  await page.flush();
  assert.equal(page.window.getComputedStyle(tooltip).display, "none");
  page.userPointerMove(timeline);
  assert.equal(leaves, 0);
  assert.notEqual(page.window.getComputedStyle(tooltip).display, "none");
  let manualHover = false;
  timeline.addEventListener("mousemove", () => {
    manualHover = true;
    page.player.insertAdjacentHTML("beforeend", overlay);
  });
  timeline.dispatchEvent(new page.window.MouseEvent("mousemove", { bubbles: true }));
  await page.flush();
  assert.equal(manualHover, true);
  assert.equal(page.clicks, 1);
  assert.notEqual(page.window.getComputedStyle(tooltip).display, "none");
});

test("a real timeline hover is left alone by background polling", async (t) => {
  const page = setup(t, "");
  const { timeline, container } = addTimeline(page);
  page.userPointerMove(timeline);
  const nativeMatches = container.matches.bind(container);
  t.mock.method(container, "matches", (selector) => selector === ":hover" || nativeMatches(selector));
  let fakeMoves = 0;
  page.player.addEventListener("mousemove", () => { fakeMoves += 1; });
  await page.flush();
  page.poll();
  await page.flush();
  assert.equal(fakeMoves, 0);
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), false);
  assert.ok(timeline.isConnected);
});

test("returning from another monitor onto the video closes fake timeline hover before restoring controls", async (t) => {
  const page = setup(t, "");
  const { timeline, video } = addTimeline(page);
  video.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 400 });
  let leavePosition;
  timeline.addEventListener("mouseleave", (event) => { leavePosition = [event.clientX, event.clientY]; });
  await page.flush();
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
  page.userPointerMove(video);
  assert.deepEqual(leavePosition, [410, 220]);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), false);
  const manualTooltip = page.document.createElement("div");
  manualTooltip.className = "ytp-tooltip";
  page.player.appendChild(manualTooltip);
  assert.notEqual(page.window.getComputedStyle(manualTooltip).display, "none");
});

test("visible-tab window blur ends fake hover and focus does not unmask delayed previews", async (t) => {
  const page = setup(t, "");
  Object.defineProperty(page.document, "hidden", { value: false });
  const { timeline } = addTimeline(page);
  let hovers = 0;
  let leaves = 0;
  timeline.addEventListener("mouseenter", () => { hovers += 1; });
  timeline.addEventListener("mouseleave", () => { leaves += 1; });
  await page.flush();
  page.event("blur", page.window);
  assert.equal(leaves, 1);
  assert.equal(page.document.hidden, false);
  page.event("focus", page.window);
  await page.flush();
  assert.equal(hovers, 1);
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), true);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
});

test("video-surface activity is visually suppressed before it wakes controls, even without a timeline", async (t) => {
  const page = setup(t, "");
  const video = setPlaying(page);
  let wasQuietBeforeActivity = false;
  page.player.addEventListener("mousemove", () => {
    wasQuietBeforeActivity = page.player.classList.contains("youtube-hide-auto-activity");
  });
  await page.flush();
  assert.equal(wasQuietBeforeActivity, true);
  page.userPointerMove(video);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
});

test("polling leaves a real video-surface hover alone while still clicking ready skip prompts", async (t) => {
  const page = setup(t, "");
  addTimeline(page);
  page.userPointerMove(page.document.querySelector("video"));
  const nativeMatches = page.player.matches.bind(page.player);
  t.mock.method(page.player, "matches", (selector) => selector === ":hover" || nativeMatches(selector));
  let movements = 0;
  page.player.addEventListener("mousemove", () => { movements += 1; });
  await page.flush();
  page.poll();
  await page.flush();
  assert.equal(movements, 0);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  page.player.insertAdjacentHTML("beforeend", overlay);
  await page.flush();
  assert.equal(page.clicks, 1);
});

test("layout boundary events cannot unmask unattended title, controls, or fullscreen arrow", async (t) => {
  const page = setup(t, "");
  const { timeline } = addTimeline(page);
  page.player.insertAdjacentHTML("beforeend", '<div class="ytp-chrome-top">Title</div><div class="ytp-chrome-bottom"></div><div class="ytp-fullscreen-grid"></div>');
  await page.flush();
  for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter"]) {
    page.userEvent(type, timeline);
  }
  for (const selector of [".ytp-chrome-top", ".ytp-chrome-bottom", ".ytp-fullscreen-grid"]) {
    assert.equal(page.window.getComputedStyle(page.player.querySelector(selector)).opacity, "0");
  }
  page.userPointerMove(timeline);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
});

test("stale CSS hover cannot block automatic checks or call native control APIs", async (t) => {
  const page = setup(t, "");
  const { timeline, container } = addTimeline(page);
  for (const element of [page.player, timeline, container]) {
    const matches = element.matches.bind(element);
    t.mock.method(element, "matches", (selector) => selector === ":hover" || matches(selector));
  }
  let nativeHides = 0;
  page.player.hideControls = () => { nativeHides += 1; };
  timeline.addEventListener("mousemove", () => page.player.insertAdjacentHTML("beforeend", overlay));
  await page.flush();
  assert.equal(page.clicks, 1);
  assert.equal(nativeHides, 0);
});

test("stationary mouse input expires without boundary events extending its activity", async (t) => {
  const page = setup(t, "");
  const video = setPlaying(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let movements = 0;
  page.player.addEventListener("mousemove", () => { movements += 1; });
  page.userPointerMove(video);
  await page.flush();
  now += 2999;
  page.userEvent("pointerover", video);
  page.poll();
  await page.flush();
  assert.equal(movements, 0);
  now += 1;
  page.poll();
  await page.flush();
  assert.equal(movements, 1);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
});

test("held mouse input prevents probes until release and idle", async (t) => {
  const page = setup(t, "");
  const video = setPlaying(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let movements = 0;
  page.player.addEventListener("mousemove", () => { movements += 1; });
  page.userEvent("pointerdown", video, { buttons: 1 });
  now += 10000;
  page.poll();
  await page.flush();
  assert.equal(movements, 0);
  page.userEvent("pointerup", video);
  now += 3000;
  page.poll();
  await page.flush();
  assert.equal(movements, 1);
});

test("pointer exit resumes automatic checks while Brave remains focused", async (t) => {
  const page = setup(t, "");
  const video = setPlaying(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  page.userPointerMove(video);
  await page.flush();
  page.userEvent("pointerout", video, { relatedTarget: page.player });
  now += 1000;
  page.poll();
  await page.flush();
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  page.userEvent("pointerout", page.player, { relatedTarget: null });
  await page.flush();
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
});

test("pausing restores native controls and does not call native hideControls", async (t) => {
  const page = setup(t, "");
  const video = setPlaying(page);
  let nativeHides = 0;
  page.player.hideControls = () => { nativeHides += 1; };
  await page.flush();
  assert.equal(nativeHides, 0);
  Object.defineProperty(video, "paused", { configurable: true, value: true });
  page.event("pause", video);
  assert.equal(nativeHides, 0);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
});

for (const key of ["extensionEnabled", "youtubeEnabled", "youtubeAutoJumpEnabled"]) {
  test(`${key} stops YouTube skips and hover checks, then resumes without resetting skip memory`, async (t) => {
    const page = setup(t, "", "https://www.youtube.com/watch?v=first", { [key]: false });
    setPlaying(page);
    let movements = 0;
    page.player.addEventListener("mousemove", () => { movements += 1; });
    page.player.insertAdjacentHTML("beforeend", overlay);
    await page.flush();
    assert.equal(page.clicks, 0);
    assert.equal(movements, 0);
    page.changeSettings({ [key]: true });
    await page.flush();
    assert.equal(page.clicks, 1);
    page.changeSettings({ [key]: false });
    page.changeSettings({ [key]: true });
    await page.flush();
    assert.equal(page.clicks, 1);
  });
}

test("turning YouTube auto-skip off ends an active probe and restores native UI", async (t) => {
  const page = setup(t, "");
  const { timeline } = addTimeline(page);
  let leaves = 0;
  timeline.addEventListener("mouseleave", () => { leaves += 1; });
  await page.flush();
  page.changeSettings({ youtubeAutoJumpEnabled: false });
  assert.equal(leaves, 1);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), false);
});

test("skip notice can be hidden without disabling YouTube auto-skip", async (t) => {
  const page = setup(t, overlay, "https://www.youtube.com/watch?v=first", { showSkipNotice: false });
  await page.flush();
  assert.equal(page.clicks, 1);
  assert.equal(page.player.querySelector(".youtube-hide-jump-notice"), null);
  page.changeSettings({ showSkipNotice: true });
  page.navigate("/watch?v=next");
  await page.flush();
  assert.ok(page.player.querySelector(".youtube-hide-jump-notice"));
  page.changeSettings({ showSkipNotice: false });
  assert.equal(page.player.querySelector(".youtube-hide-jump-notice"), null);
});

for (const type of ["pointermove", "pointerdown", "click", "wheel", "keydown"]) {
  test(`manual ${type} removes masks without changing native control state`, async (t) => {
    const page = setup(t, "");
    const video = setPlaying(page);
    let hides = 0;
    let shows = 0;
    page.player.hideControls = () => { hides += 1; };
    page.player.showControls = () => { shows += 1; };
    await page.flush();
    assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
    page.userEvent(type, video);
    assert.equal(hides, 0);
    assert.equal(shows, 0);
    assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  });
}

test("turning auto-skip off releases masks without changing native control state", async (t) => {
  const page = setup(t, "");
  setPlaying(page);
  let nativeCalls = 0;
  page.player.hideControls = page.player.showControls = () => { nativeCalls += 1; };
  await page.flush();
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
  page.changeSettings({ youtubeAutoJumpEnabled: false });
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  assert.equal(nativeCalls, 0);
});

test("native controls are never disabled when no matching restore API exists", async (t) => {
  const page = setup(t, "");
  setPlaying(page);
  let hides = 0;
  page.player.hideControls = () => { hides += 1; };
  delete page.player.showControls;
  await page.flush();
  assert.equal(hides, 0);
});

test("stationary manual control-bar hover is not interrupted after the video idle timeout", async (t) => {
  const page = setup(t, "");
  setPlaying(page);
  page.player.insertAdjacentHTML("beforeend", '<div class="ytp-chrome-bottom"><button>Settings</button></div>');
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let movements = 0;
  page.player.addEventListener("mousemove", () => { movements += 1; });
  page.userPointerMove(page.player.querySelector("button"));
  await page.flush();
  now += 10000;
  page.poll();
  await page.flush();
  assert.equal(movements, 0);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
});

test("manual input does not override native control state the extension did not hide", async (t) => {
  const page = setup(t, "");
  let shows = 0;
  page.player.showControls = () => { shows += 1; };
  await page.flush();
  page.userPointerMove(page.player.querySelector("video"));
  assert.equal(shows, 0);
});

test("open menus remain protected past idle and probes resume only after closing", async t => {
  const page = setup(t, "");
  const { timeline } = addTimeline(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let movements = 0;
  page.player.addEventListener("mousemove", () => movements++);
  await page.flush();
  const menu = page.document.createElement("div");
  menu.className = "ytp-popup ytp-settings-menu";
  menu.setAttribute("role", "menu");
  page.player.appendChild(menu);
  await page.flush();
  const before = movements;
  now += 10000; page.poll(); await page.flush();
  assert.equal(movements, before);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), false);
  menu.hidden = true;
  now += 1000; page.poll(); await page.flush();
  assert.ok(movements > before);
  assert.ok(timeline.isConnected);
});

test("keyboard focus in native controls is not masked after the keyboard idle timeout", async t => {
  const page = setup(t, '<div class="ytp-chrome-bottom"><button>Settings</button></div>');
  setPlaying(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let focused = true;
  t.mock.method(page.document, "hasFocus", () => focused);
  page.button.focus();
  await page.flush();
  now += 10000; page.poll(); await page.flush();
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), false);
  focused = false;
  now += 1000; page.poll(); await page.flush();
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
});

test("resizing cancels stale coordinates while retaining idle masks against delayed native UI", async t => {
  const page = setup(t, "");
  const { timeline } = addTimeline(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  const points = [];
  timeline.addEventListener("mousemove", event => points.push([event.clientX, event.clientY]));
  await page.flush();
  assert.deepEqual(points[0], [260, 403]);
  timeline.getBoundingClientRect = () => ({ left: 50, top: 300, width: 400, height: 6 });
  page.event("resize", page.window);
  assert.equal(page.player.classList.contains("youtube-hide-auto-activity"), true);
  assert.equal(page.player.classList.contains("youtube-hide-timeline-probe"), true);
  for (let i = 0; i < 2; i++) { now += 1001; page.poll(); await page.flush(); }
  assert.deepEqual(points.at(-1), [130, 303]);
});

test("a check uses either timeline or video-surface movement, not both", async t => {
  const page = setup(t, "");
  const { video, timeline } = addTimeline(page);
  let now = 1000;
  t.mock.method(page.window.Date, "now", () => now);
  let surfaces = 0; let timelines = 0;
  video.addEventListener("mousemove", () => surfaces++);
  timeline.addEventListener("mousemove", () => timelines++);
  await page.flush();
  assert.equal(timelines + surfaces, 1);
  now += 1001; page.poll(); await page.flush();
  assert.equal(timelines + surfaces, 2);
  assert.equal(timelines, 1);
  assert.equal(surfaces, 1);
});
