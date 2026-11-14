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
  const frames = [];
  let clicks = 0;
  // jsdom has no layout. Supply a box; CSS and hidden-ancestor checks remain real.
  window.Element.prototype.getClientRects = () => [{ width: 140, height: 40 }];
  window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
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
      await Promise.resolve();
      frames.splice(0).forEach((callback) => callback());
      await Promise.resolve();
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
