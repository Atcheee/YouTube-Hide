const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");
const script = readFileSync(join(__dirname, "..", "crunchyroll-fullscreen.js"), "utf8");

function setup(t, settings = {}) {
  const dom = new JSDOM('<div id="player-container"><video></video><div class="player-overlay"></div><button aria-label="Enter fullscreen"><span>Fullscreen</span></button><input type="range"><div role="menu"></div></div><div id="outside"></div>', {
    url: "https://www.crunchyroll.com/watch/EPISODE", runScripts: "outside-only"
  });
  const { window } = dom;
  t.after(() => window.close());
  const { document } = window;
  const video = document.querySelector("video");
  const player = document.getElementById("player-container");
  const button = document.querySelector("button");
  window.Element.prototype.getClientRects = () => [{}];
  video.getBoundingClientRect = () => ({ left: 0, top: 0, right: 960, bottom: 540 });
  let fullscreen = null;
  Object.defineProperty(document, "fullscreenElement", { get: () => fullscreen });
  let clicks = 0;
  button.addEventListener("click", () => { clicks++; fullscreen = fullscreen ? null : player; });
  const change = installSettings(window, settings);
  window.eval(script);
  return { window, document, video, player, button, change,
    get clicks() { return clicks; }, get fullscreen() { return fullscreen; },
    doubleClick(target = video, extra = {}) {
      const event = new window.MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0, clientX: 200, clientY: 200, ...extra });
      target.dispatchEvent(event);
      return event;
    }
  };
}

test("video and overlay double clicks toggle the native fullscreen control exactly once", t => {
  const page = setup(t, { crunchyrollFiveSecondSeekEnabled: false, crunchyrollKeyboardShortcutsEnabled: false });
  let nativeDoubles = 0;
  page.player.addEventListener("dblclick", () => nativeDoubles++);
  assert.equal(page.doubleClick().defaultPrevented, true);
  assert.equal(page.fullscreen, page.player);
  page.doubleClick(page.document.querySelector(".player-overlay"));
  assert.equal(page.fullscreen, null);
  assert.equal(page.clicks, 2);
  assert.equal(nativeDoubles, 0);
});

test("controls, menus, outside clicks, and clicks outside the video bounds stay native", t => {
  const page = setup(t);
  for (const target of [page.button.querySelector("span"), page.document.querySelector("input"), page.document.querySelector('[role="menu"]'), page.document.getElementById("outside")]) {
    assert.equal(page.doubleClick(target).defaultPrevented, false);
  }
  assert.equal(page.doubleClick(page.player, { clientX: 1000 }).defaultPrevented, false);
  assert.equal(page.doubleClick(page.video, { ctrlKey: true }).defaultPrevented, false);
  assert.equal(page.clicks, 0);
});

for (const key of ["extensionEnabled", "crunchyrollEnabled"]) {
  test(`${key} disables double-click fullscreen immediately`, t => {
    const page = setup(t);
    page.change({ [key]: false });
    assert.equal(page.doubleClick().defaultPrevented, false);
    assert.equal(page.clicks, 0);
  });
}

test("fallback fullscreen API uses the player container and duplicate injection is harmless", t => {
  const page = setup(t);
  page.button.remove();
  let requested = 0;
  page.player.requestFullscreen = () => { requested++; return Promise.resolve(); };
  page.window.eval(script);
  page.doubleClick();
  assert.equal(requested, 1);
});

test("hover-hidden native fullscreen controls remain usable and fullscreen exit uses the API fallback", t => {
  const page = setup(t);
  page.button.setAttribute("aria-hidden", "true");
  page.doubleClick();
  assert.equal(page.fullscreen, page.player);
  page.button.remove();
  let exits = 0;
  page.document.exitFullscreen = () => { exits++; return Promise.resolve(); };
  page.doubleClick();
  assert.equal(exits, 1);
});
