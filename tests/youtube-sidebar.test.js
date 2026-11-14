const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");
const script = readFileSync(join(__dirname, "..", "youtube-sidebar.js"), "utf8");
const hidden = "playback-plus-sidebar-hidden";
const shortcut = ".playback-plus-watch-later";
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function sidebar(compact) {
  const entry = compact ? "ytd-mini-guide-entry-renderer" : "ytd-guide-entry-renderer";
  return `<${compact ? "ytd-mini-guide-renderer" : "ytd-guide-renderer"}>
    <div id="items-${compact}">
      <${entry}><a href="/">Home</a></${entry}>
      <${entry} data-shorts><a href="/shorts/">Shorts</a></${entry}>
      <${entry} data-subscriptions><a href="/feed/subscriptions">Subscriptions</a></${entry}>
      <${entry} data-you><a href="/feed/you">You</a></${entry}>
    </div>
  </${compact ? "ytd-mini-guide-renderer" : "ytd-guide-renderer"}>`;
}

async function setup(t, html = sidebar(true) + sidebar(false), settings = {}) {
  const dom = new JSDOM(html, { url: "https://www.youtube.com/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const change = installSettings(dom.window, settings);
  dom.window.eval(script);
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  await flush();
  return { window: dom.window, document: dom.window.document, change };
}

test("compact and expanded sidebars hide Shorts and put Watch later directly before Subscriptions", async t => {
  const { document } = await setup(t);
  for (const root of document.querySelectorAll("ytd-mini-guide-renderer, ytd-guide-renderer")) {
    assert.equal(root.querySelector("[data-shorts]").classList.contains(hidden), true);
    const subscription = root.querySelector("[data-subscriptions]");
    const link = subscription.previousElementSibling;
    assert.equal(link.matches(shortcut), true);
    assert.equal(link.nextElementSibling, subscription);
    assert.equal(subscription.nextElementSibling.hasAttribute("data-you"), true);
    assert.equal(link.getAttribute("href"), "/playlist?list=WL");
    assert.equal(link.getAttribute("aria-label"), "Watch later");
    assert.equal(link.classList.contains("playback-plus-watch-later-compact"), root.matches("ytd-mini-guide-renderer"));
  }
});

test("lazy You menu entries are hidden and native Watch later stays intact for restoration", async t => {
  const { document, change } = await setup(t);
  const popup = document.createElement("div");
  popup.innerHTML = '<ytd-guide-entry-renderer><a href="/playlist?list=WL" title="Watch later"><svg></svg><span>Watch later</span></a></ytd-guide-entry-renderer><ytd-guide-entry-renderer><a href="/feed/history">History</a></ytd-guide-entry-renderer>';
  document.body.append(popup);
  await flush();
  const original = popup.firstElementChild;
  assert.equal(original.classList.contains(hidden), true);
  assert.equal(popup.lastElementChild.classList.contains(hidden), false);
  change({ youtubeEnabled: false });
  await flush();
  assert.equal(original.classList.contains(hidden), false);
  assert.equal(original.querySelector("a").getAttribute("href"), "/playlist?list=WL");
  assert.equal(document.querySelector(shortcut), null);
  assert.equal(document.querySelector("[data-shorts]").classList.contains(hidden), false);
  change({ youtubeEnabled: true });
  await flush();
  assert.equal(original.classList.contains(hidden), true);
  assert.equal(document.querySelectorAll(shortcut).length, 2);
});

test("sidebar replacements and reused hrefs update without duplicate shortcuts", async t => {
  const { document, window } = await setup(t);
  document.querySelector("ytd-mini-guide-renderer").outerHTML = sidebar(true);
  await flush();
  window.history.pushState({}, "", "/playlist?list=WL");
  document.dispatchEvent(new window.Event("yt-navigate-finish"));
  await flush();
  for (const link of document.querySelectorAll(shortcut)) assert.equal(link.getAttribute("aria-current"), "page");
  assert.equal(document.querySelectorAll(shortcut).length, 2);
  const shorts = document.querySelector("[data-shorts]");
  shorts.querySelector("a").href = "/feed/trending";
  await flush();
  assert.equal(shorts.classList.contains(hidden), false);
  const subscriptions = document.querySelector("[data-subscriptions]");
  subscriptions.querySelector("a").href = "/feed/history";
  await flush();
  assert.equal(document.querySelectorAll(shortcut).length, 1);
});

test("Shorts preference is independent of Watch later and master pause restores both", async t => {
  const { document, change } = await setup(t, sidebar(true), { hideShortsEnabled: false });
  const shorts = document.querySelector("[data-shorts]");
  assert.equal(shorts.classList.contains(hidden), false);
  assert.ok(document.querySelector(shortcut));
  change({ hideShortsEnabled: true });
  await flush();
  assert.equal(shorts.classList.contains(hidden), true);
  change({ extensionEnabled: false });
  await flush();
  assert.equal(shorts.classList.contains(hidden), false);
  assert.equal(document.querySelector(shortcut), null);
});

test("does not hide Watch later if no sidebar can host its replacement or hide content links", async t => {
  const { document } = await setup(t, '<ytd-guide-renderer><ytd-guide-entry-renderer><a href="/playlist?list=WL">Watch later</a></ytd-guide-entry-renderer></ytd-guide-renderer><main><a href="/shorts/abc">Short video</a></main>');
  assert.equal(document.querySelector(`.${hidden}`), null);
  assert.equal(document.querySelector(shortcut), null);
});

test("Watch later preference restores You menu independently of Shorts and survives sidebar updates", async t => {
  const html = sidebar(true) + '<ytd-guide-entry-renderer id="original"><a href="/playlist?list=WL">Watch later</a></ytd-guide-entry-renderer>';
  const { document, change } = await setup(t, html, { youtubeWatchLaterShortcutEnabled: false });
  const original = document.getElementById("original");
  assert.equal(document.querySelector(shortcut), null);
  assert.equal(original.classList.contains(hidden), false);
  assert.equal(document.querySelector("[data-shorts]").classList.contains(hidden), true);
  change({ youtubeWatchLaterShortcutEnabled: true });
  await flush();
  assert.ok(document.querySelector(shortcut));
  assert.equal(original.classList.contains(hidden), true);
  change({ youtubeWatchLaterShortcutEnabled: false });
  await flush();
  document.querySelector("ytd-mini-guide-renderer").outerHTML = sidebar(true);
  await flush();
  assert.equal(document.querySelector(shortcut), null);
  assert.equal(original.classList.contains(hidden), false);
  assert.equal(document.querySelector("[data-shorts]").classList.contains(hidden), true);
});
