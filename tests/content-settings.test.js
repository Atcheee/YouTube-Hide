const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");
const installSettings = require("../test-support/settings.cjs");
const script = readFileSync(join(__dirname, "..", "content.js"), "utf8");

for (const key of ["extensionEnabled", "youtubeEnabled"]) {
  test(`${key} unhides filtered YouTube cards and reapplies saved filters when resumed`, async (t) => {
    const dom = new JSDOM('<ytd-video-renderer>Streamed 3 days ago</ytd-video-renderer><ytd-video-renderer><a href="/shorts/example">Short</a></ytd-video-renderer>', { url: "https://www.youtube.com/", runScripts: "outside-only" });
    const { window } = dom;
    const observers = [];
    const NativeObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeObserver { constructor(callback) { super(callback); observers.push(this); } };
    t.after(() => { observers.forEach((observer) => observer.disconnect()); window.close(); });
    window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
    const change = installSettings(window, { hideShortsEnabled: false });
    window.chrome.runtime.onMessage = { addListener() {} };
    window.eval(script);
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    const [streamed, short] = window.document.querySelectorAll("ytd-video-renderer");
    assert.equal(streamed.classList.contains("hide-streamed-days-video"), true);
    assert.equal(short.classList.contains("hide-streamed-days-video"), false);
    change({ [key]: false });
    await flush();
    assert.equal(streamed.classList.contains("hide-streamed-days-video"), false);
    change({ [key]: true });
    await flush();
    assert.equal(streamed.classList.contains("hide-streamed-days-video"), true);
    assert.equal(short.classList.contains("hide-streamed-days-video"), false);
  });
}
