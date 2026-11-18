(() => {
  "use strict";

  // The Hive player's clock and seek method live in Disney's page context.
  if (window.__playbackPlusDisneySeek) return;
  window.__playbackPlusDisneySeek = true;

  document.addEventListener("playback-plus-disney-seek", event => {
    const offset = event.detail;
    if (![-10000, -5000, 5000, 10000].includes(offset)) return;
    const hosts = event.composedPath().filter(node => node instanceof Element &&
      node.matches("disney-web-player, hive-video"));
    for (const host of hosts) {
      try {
        const player = host.mediaPlayer;
        const timeline = player?.timeline?.info;
        const position = timeline?.playheadPositionMs;
        if (!Number.isFinite(position) || position < 0 || typeof player.seek !== "function") continue;
        const end = Number.isFinite(timeline.durationMs) && timeline.durationMs > 0 ? timeline.durationMs : Infinity;
        const result = player.seek(Math.round(Math.max(0, Math.min(end, position + offset))));
        if (result === false) continue;
        result?.catch?.(() => {});
        event.preventDefault();
        return;
      } catch {
        // The isolated script can still try the standard media controls.
      }
    }
  }, true);
})();
