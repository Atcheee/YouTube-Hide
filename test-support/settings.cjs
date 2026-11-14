const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const script = readFileSync(join(__dirname, "..", "settings.js"), "utf8");
const version = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8")).version;

module.exports = function installSettings(window, initial = {}) {
  const listeners = [];
  window.chrome ||= {};
  window.chrome.runtime ||= {};
  window.chrome.runtime.getManifest ||= () => ({ version });
  window.chrome.storage ||= {};
  window.chrome.storage.sync ||= { get: (defaults, callback) => callback({ ...defaults, ...initial }) };
  const originalAdd = window.chrome.storage.onChanged?.addListener;
  window.chrome.storage.onChanged = { addListener(listener) {
    listeners.push(listener);
    originalAdd?.(listener);
  } };
  window.eval(script);
  return (values) => {
    const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
    listeners.forEach((listener) => listener(changes, "sync"));
  };
};
