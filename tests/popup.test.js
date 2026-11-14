const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { JSDOM } = require("jsdom");

const read = (name) => readFileSync(join(__dirname, "..", name), "utf8");
const version = JSON.parse(read("manifest.json")).version;

function setup(t, { url = "https://www.youtube.com/watch?v=video", sync = {}, local = {}, stale = false, recover = false, injectionFails = false } = {}) {
  const dom = new JSDOM(read("popup.html"), { url: "https://extension.test/popup.html", runScripts: "outside-only" });
  const { window } = dom;
  const closeWindow = window.close.bind(window);
  t.after(closeWindow);
  const listeners = [];
  const writes = [];
  const reloads = [];
  const injections = [];
  let connected = !stale;
  const values = { sync: { ...sync }, local: { ...local } };
  let failure = false;
  let closed = false;
  window.close = () => { closed = true; };
  const runtime = {
    getManifest: () => ({ version, content_scripts: JSON.parse(read("manifest.json")).content_scripts }),
    sendMessage: (_message, callback) => callback({ frames: [{ frame: "Player frame", state: "Waiting for Skip Intro" }] })
  };
  function update(area, update) {
    const changes = Object.fromEntries(Object.entries(update).map(([key, newValue]) => [key, { oldValue: values[area][key], newValue }]));
    Object.assign(values[area], update);
    listeners.forEach((listener) => listener(changes, area));
  }
  window.chrome = { runtime, storage: {
    onChanged: { addListener: (listener) => listeners.push(listener) },
    ...Object.fromEntries(["sync", "local"].map((area) => [area, {
      get: (defaults, callback) => callback({ ...defaults, ...values[area] }),
      set(value, callback) {
        writes.push({ area, value });
        if (failure) {
          failure = false;
          runtime.lastError = { message: "Storage unavailable" };
          callback?.();
          delete runtime.lastError;
        } else { update(area, value); callback?.(); }
      }
    }]))
  }, tabs: {
    query: (_query, callback) => callback([{ id: 7, url }]),
    sendMessage: (_id, _message, _options, callback) => callback({ version: connected ? version : "1.8.4" }),
    reload: (id, callback) => { reloads.push(id); callback(); }
  } };
  if (recover) window.chrome.scripting = {
    insertCSS(options, callback) { injections.push({ css: options }); callback(); },
    executeScript(options, callback) {
      injections.push({ js: options });
      if (injectionFails) runtime.lastError = { message: "Cannot access tab" };
      else connected = true;
      callback();
      delete runtime.lastError;
    }
  };
  window.eval(read("settings.js"));
  window.eval(read("popup.js"));
  return {
    window, document: window.document, values, writes, reloads, injections, update,
    get closed() { return closed; },
    failNextWrite() { failure = true; },
    input(key) { return window.document.querySelector(`[data-setting="${key}"]`); },
    element(id) { return window.document.getElementById(id); }
  };
}

test("popup preserves existing hide preferences and selects the current supported site", (t) => {
  const page = setup(t, { url: "https://www.crunchyroll.com/watch/episode", sync: { hideShortsEnabled: false }, local: { crunchyrollPlaybackSpeed: 1.3 } });
  assert.equal(page.document.title, "Playback Plus");
  assert.equal(page.input("hideShortsEnabled").checked, false);
  assert.equal(page.input("hideMusicEnabled").checked, true);
  assert.equal(page.element("youtube-panel").hidden, true);
  assert.equal(page.element("crunchyroll-panel").hidden, false);
  assert.equal(page.element("site-status").textContent, "Crunchyroll · Connected");
  assert.equal(page.element("speed-value").textContent, "1.3x");
  assert.equal(page.element("version").textContent, `v${version}`);
  assert.equal(page.writes.length, 0);
});

test("master and site switches disable dependent controls without losing preferences", (t) => {
  const page = setup(t);
  page.input("youtubeEnabled").click();
  assert.equal(page.values.sync.youtubeEnabled, false);
  assert.equal(page.input("hideShortsEnabled").matches(":disabled"), true);
  assert.equal(page.input("hideShortsEnabled").checked, true);
  assert.equal(page.input("crunchyrollEnabled").matches(":disabled"), false);
  page.input("extensionEnabled").click();
  assert.equal(page.element("paused-hint").hidden, false);
  assert.equal(page.input("crunchyrollEnabled").matches(":disabled"), true);
  assert.equal(page.input("extensionEnabled").disabled, false);
  page.input("extensionEnabled").click();
  assert.equal(page.input("youtubeEnabled").checked, false);
  page.input("youtubeEnabled").click();
  assert.equal(page.input("hideShortsEnabled").matches(":disabled"), false);
});

test("speed presets and slider save the same rate used by the in-player picker", (t) => {
  const page = setup(t);
  page.element("crunchyroll-tab").click();
  page.document.querySelector('[data-speed="1.5"]').click();
  assert.equal(page.values.local.crunchyrollPlaybackSpeed, 1.5);
  const slider = page.element("playback-speed");
  slider.value = "1.35";
  slider.dispatchEvent(new page.window.Event("input"));
  assert.equal(page.element("speed-value").textContent, "1.35x");
  assert.equal(page.values.local.crunchyrollPlaybackSpeed, 1.5);
  slider.dispatchEvent(new page.window.Event("change"));
  assert.equal(page.values.local.crunchyrollPlaybackSpeed, 1.35);
  page.input("crunchyrollSpeedEnabled").click();
  assert.equal(slider.matches(":disabled"), true);
  page.update("local", { crunchyrollPlaybackSpeed: 2 });
  assert.equal(slider.value, "2");
});

test("failed saves restore the visible preference and show an error", (t) => {
  const page = setup(t);
  page.failNextWrite();
  page.input("youtubeAutoJumpEnabled").click();
  assert.equal(page.input("youtubeAutoJumpEnabled").checked, true);
  assert.equal(page.element("save-status").dataset.error, "true");
  page.failNextWrite();
  page.document.querySelector('[data-speed="2"]').click();
  assert.equal(page.element("playback-speed").value, "1");
});

test("reset restores owned defaults and speed while preserving unrelated storage", (t) => {
  const page = setup(t, { sync: { extensionEnabled: false, hideShortsEnabled: false, unrelated: "keep" }, local: { crunchyrollPlaybackSpeed: 3, unrelated: "keep" } });
  page.element("reset-settings").click();
  assert.equal(page.input("extensionEnabled").checked, true);
  assert.equal(page.input("hideShortsEnabled").checked, true);
  assert.equal(page.values.local.crunchyrollPlaybackSpeed, 1);
  assert.equal(page.values.local.unrelated, "keep");
  assert.equal(page.values.sync.unrelated, "keep");
});

test("old content scripts show a refresh hint and the refresh action targets only the active tab", (t) => {
  const page = setup(t, { stale: true });
  assert.equal(page.element("refresh-hint").hidden, false);
  assert.equal(page.element("site-status").textContent, "YouTube · Refresh needed");
  page.element("refresh-tab").click();
  assert.deepEqual(page.reloads, [7]);
  assert.equal(page.closed, true);
});

test("unsupported and lookalike domains retain settings access without showing player actions", (t) => {
  const page = setup(t, { url: "https://youtube.com.example.org/watch" });
  assert.equal(page.element("refresh-tab").hidden, true);
  assert.equal(page.element("diagnostics").hidden, true);
  assert.equal(page.element("site-status").textContent, "YouTube + Crunchyroll");
  page.input("showSkipNotice").click();
  assert.equal(page.values.sync.showSkipNotice, false);
});

test("site tabs support arrow-key navigation and expose only the selected panel", (t) => {
  const page = setup(t);
  page.element("youtube-tab").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(page.element("crunchyroll-tab").getAttribute("aria-selected"), "true");
  assert.equal(page.document.activeElement, page.element("crunchyroll-tab"));
  assert.equal(page.element("youtube-panel").hidden, true);
});

test("Watch later sidebar switch saves independently, respects site pause, and resets to default", t => {
  const page = setup(t, { sync: { youtubeWatchLaterShortcutEnabled: false, hideShortsEnabled: false } });
  const toggle = page.input("youtubeWatchLaterShortcutEnabled");
  assert.equal(toggle.checked, false);
  toggle.click();
  assert.equal(page.values.sync.youtubeWatchLaterShortcutEnabled, true);
  assert.equal(page.input("hideShortsEnabled").checked, false);
  page.input("youtubeEnabled").click();
  assert.equal(toggle.matches(":disabled"), true);
  assert.equal(toggle.checked, true);
  page.input("youtubeEnabled").click();
  toggle.click();
  assert.equal(page.values.sync.youtubeWatchLaterShortcutEnabled, false);
  page.element("reset-settings").click();
  assert.equal(toggle.checked, true);
  assert.equal(page.values.sync.youtubeWatchLaterShortcutEnabled, true);
});

for (const site of ["youtube", "crunchyroll"]) {
  test(`${site} reconnects missing tools automatically without refreshing the tab`, t => {
    const page = setup(t, { url: `https://www.${site}.com/watch/example`, stale: true, recover: true });
    assert.match(page.element("site-status").textContent, /Connected/);
    assert.equal(page.element("refresh-hint").hidden, true);
    assert.equal(page.reloads.length, 0);
    assert.equal(page.injections.length, 2);
    const target = page.injections[1].js.target;
    assert.equal(target.tabId, 7);
    assert.equal(target.allFrames, site === "crunchyroll");
    assert.equal(page.injections[1].js.files[0], "settings.js");
  });
}

test("healthy tabs skip injection and failed recovery keeps a manual fallback", t => {
  const healthy = setup(t, { recover: true });
  assert.equal(healthy.injections.length, 0);
  const failed = setup(t, { stale: true, recover: true, injectionFails: true });
  assert.equal(failed.element("refresh-hint").hidden, false);
  assert.equal(failed.reloads.length, 0);
});

test("five-second seeking switch is opt-in, saved and reset independently", t => {
  const page = setup(t, { url: "https://www.crunchyroll.com/watch/episode" });
  const toggle = page.input("crunchyrollFiveSecondSeekEnabled");
  assert.equal(toggle.checked, false);
  const shortcuts = page.input("crunchyrollKeyboardShortcutsEnabled");
  assert.equal(shortcuts.checked, false);
  shortcuts.click();
  assert.equal(page.values.sync.crunchyrollKeyboardShortcutsEnabled, true);
  toggle.click();
  assert.equal(page.values.sync.crunchyrollFiveSecondSeekEnabled, true);
  shortcuts.click();
  assert.equal(page.values.sync.crunchyrollKeyboardShortcutsEnabled, false);
  assert.equal(toggle.checked, true);
  page.input("crunchyrollEnabled").click();
  assert.equal(toggle.matches(":disabled"), true);
  page.element("reset-settings").click();
  assert.equal(toggle.checked, false);
  assert.equal(shortcuts.checked, false);
});
