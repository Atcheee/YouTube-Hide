(() => {
  "use strict";

  const defaults = Object.freeze({
    extensionEnabled: true,
    youtubeEnabled: true,
    crunchyrollEnabled: true,
    youtubeAutoJumpEnabled: true,
    crunchyrollAutoSkipEnabled: true,
    crunchyrollSpeedEnabled: true,
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
      state[key] = changes[key].newValue !== false;
      changed = true;
    }
    if (ready && changed) notify();
  });
  chrome.storage.sync.get(defaults, (result) => {
    // A popup change can arrive before the initial storage read completes.
    const failed = Boolean(chrome.runtime?.lastError);
    for (const key of Object.keys(defaults)) {
      if (!changedDuringLoad.has(key)) state[key] = failed ? defaults[key] : result?.[key] !== false;
    }
    ready = true;
    notify();
  });
})();
