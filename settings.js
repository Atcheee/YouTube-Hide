(() => {
  "use strict";

  if (globalThis.PlaybackPlusSettings?.isActive?.()) return;
  const runtimeId = chrome.runtime?.id;
  const version = chrome.runtime?.getManifest?.().version;
  const installed = new Set();
  function isActive() {
    try {
      return chrome.runtime?.id === runtimeId && chrome.runtime?.getManifest?.().version === version;
    } catch { return false; }
  }

  const defaults = Object.freeze({
    extensionEnabled: true,
    youtubeEnabled: true,
    crunchyrollEnabled: true,
    hbomaxEnabled: true,
    hbomaxSpeedEnabled: true,
    hbomaxFiveSecondSeekEnabled: true,
    hbomaxKeyboardShortcutsEnabled: true,
    hbomaxAutoSkipEnabled: true,
    hbomaxRemoveDimmingEnabled: true,
    disneyplusEnabled: true,
    disneyplusSpeedEnabled: true,
    disneyplusFiveSecondSeekEnabled: true,
    disneyplusKeyboardShortcutsEnabled: true,
    disneyplusAutoSkipEnabled: true,
    disneyplusRemoveDimmingEnabled: true,
    youtubeAutoJumpEnabled: true,
    youtubeWatchLaterShortcutEnabled: true,
    crunchyrollAutoSkipEnabled: true,
    crunchyrollSpeedEnabled: true,
    crunchyrollFiveSecondSeekEnabled: false,
    crunchyrollKeyboardShortcutsEnabled: false,
    showSkipNotice: true,
    hideStreamedEnabled: true,
    hideShortsEnabled: true,
    hideMixEnabled: true,
    hideMusicEnabled: true
  });
  const state = { ...defaults };
  const listeners = new Set();
  const changedDuringLoad = new Set();
  let ready = false;

  function notify() {
    for (const listener of listeners) listener({ ...state });
  }

  globalThis.PlaybackPlusSettings = Object.freeze({
    defaults,
    isActive,
    install(name) {
      if (installed.has(name)) return false;
      installed.add(name);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (ready) listener({ ...state });
      return () => listeners.delete(listener);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let changed = false;
    for (const key of Object.keys(defaults)) {
      if (!Object.hasOwn(changes, key)) continue;
      changedDuringLoad.add(key);
      state[key] = (changes[key].newValue ?? defaults[key]) !== false;
      changed = true;
    }
    if (ready && changed) notify();
  });
  chrome.storage.sync.get(defaults, (result) => {
    // A popup change can arrive before the initial storage read completes.
    const failed = Boolean(chrome.runtime?.lastError);
    for (const key of Object.keys(defaults)) {
      if (!changedDuringLoad.has(key)) state[key] = failed ? defaults[key] : (result?.[key] ?? defaults[key]) !== false;
    }
    ready = true;
    notify();
  });
})();
