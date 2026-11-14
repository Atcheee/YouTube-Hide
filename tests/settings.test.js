const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const script = readFileSync(join(__dirname, "..", "settings.js"), "utf8");

test("settings wait for storage and preserve changes arriving during the initial load", () => {
  let finish;
  let change;
  const context = { chrome: { runtime: {}, storage: {
    sync: { get: (_defaults, callback) => { finish = callback; } },
    onChanged: { addListener: (listener) => { change = listener; } }
  } } };
  runInNewContext(script, context);
  const received = [];
  const unsubscribe = context.PlaybackPlusSettings.subscribe((value) => received.push(value));
  assert.equal(received.length, 0);
  change({ extensionEnabled: { newValue: false } }, "sync");
  finish({ extensionEnabled: true, hideShortsEnabled: false });
  assert.equal(received.length, 1);
  assert.equal(received[0].extensionEnabled, false);
  assert.equal(received[0].hideShortsEnabled, false);
  assert.equal(received[0].youtubeAutoJumpEnabled, true);
  change({ extensionEnabled: {} }, "sync");
  assert.equal(received[1].extensionEnabled, true);
  unsubscribe();
  change({ youtubeEnabled: { newValue: false } }, "sync");
  assert.equal(received.length, 2);
});
