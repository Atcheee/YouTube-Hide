(() => {
  "use strict";

  const STREAMED_STORAGE_KEY = "hideStreamedEnabled";
  const SHORTS_STORAGE_KEY = "hideShortsEnabled";
  const MIX_STORAGE_KEY = "hideMixEnabled";
  const streamedToggle = document.getElementById("streamed-toggle");
  const shortsToggle = document.getElementById("shorts-toggle");
  const mixToggle = document.getElementById("mix-toggle");

  chrome.storage.sync.get(
    {
      [STREAMED_STORAGE_KEY]: true,
      [SHORTS_STORAGE_KEY]: true,
      [MIX_STORAGE_KEY]: true
    },
    (result) => {
      streamedToggle.checked = Boolean(result[STREAMED_STORAGE_KEY]);
      shortsToggle.checked = Boolean(result[SHORTS_STORAGE_KEY]);
      mixToggle.checked = Boolean(result[MIX_STORAGE_KEY]);
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
})();
