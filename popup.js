(() => {
  "use strict";

  const STREAMED_STORAGE_KEY = "hideStreamedEnabled";
  const SHORTS_STORAGE_KEY = "hideShortsEnabled";
  const MIX_STORAGE_KEY = "hideMixEnabled";
  const MUSIC_STORAGE_KEY = "hideMusicEnabled";
  const streamedToggle = document.getElementById("streamed-toggle");
  const shortsToggle = document.getElementById("shorts-toggle");
  const mixToggle = document.getElementById("mix-toggle");
  const musicToggle = document.getElementById("music-toggle");

  chrome.storage.sync.get(
    {
      [STREAMED_STORAGE_KEY]: true,
      [SHORTS_STORAGE_KEY]: true,
      [MIX_STORAGE_KEY]: true,
      [MUSIC_STORAGE_KEY]: true
    },
    (result) => {
      streamedToggle.checked = Boolean(result[STREAMED_STORAGE_KEY]);
      shortsToggle.checked = Boolean(result[SHORTS_STORAGE_KEY]);
      mixToggle.checked = Boolean(result[MIX_STORAGE_KEY]);
      musicToggle.checked = Boolean(result[MUSIC_STORAGE_KEY]);
    }
  );

  streamedToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ [STREAMED_STORAGE_KEY]: streamedToggle.checked });
  });

  shortsToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ [SHORTS_STORAGE_KEY]: shortsToggle.checked });
  });

  mixToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ [MIX_STORAGE_KEY]: mixToggle.checked });
  });

  musicToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ [MUSIC_STORAGE_KEY]: musicToggle.checked });
  });

  const refreshHint = document.getElementById("refresh-hint");

  function showRefreshHint() {
    if (refreshHint) refreshHint.hidden = false;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;

    chrome.tabs.sendMessage(tab.id, { type: "youtube-hide-ping" }, (response) => {
      if (chrome.runtime.lastError) {
        if (/youtube\.com/i.test(tab.url || tab.pendingUrl || "")) showRefreshHint();
        return;
      }

      if (!response?.features?.includes("music")) showRefreshHint();
    });
  });
})();
