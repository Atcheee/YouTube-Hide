(() => {
  "use strict";

  // This script runs in the page's MAIN world solely to access the native player
  // method. It exposes no player methods or extension capabilities to callers.
  const hiddenPlayers = new Set();
  function restoreControls(player) {
    if (!hiddenPlayers.has(player)) return;
    if (!player.isConnected) { hiddenPlayers.delete(player); return; }
    try {
      player.showControls();
      hiddenPlayers.delete(player);
    } catch {
      // Keep ownership so the next user input can retry native restoration.
    }
  }
  document.addEventListener("youtube-hide-restore-user-controls", () => {
    for (const player of hiddenPlayers) restoreControls(player);
  });
  document.addEventListener("youtube-hide-begin-automatic-activity", () => {
    const player = document.getElementById("movie_player");
    // A previous cleanup also removed the timeline's layout box. Reenable it
    // underneath our quiet CSS before probing again, without exposing native UI.
    if (player?.classList.contains("youtube-hide-auto-activity")) restoreControls(player);
  });
  document.addEventListener("youtube-hide-end-automatic-activity", () => {
    const player = document.getElementById("movie_player");
    const video = player?.querySelector("video");
    if (!player?.classList.contains("youtube-hide-auto-activity") ||
        !video || video.paused || video.ended) return;
    // hideControls() disables native controls; hover alone does not undo it.
    // Use it only when we can pair it with showControls() on manual input.
    if (typeof player.hideControls !== "function" || typeof player.showControls !== "function") return;
    try {
      hiddenPlayers.add(player);
      player.hideControls();
    } catch {
      // Keep the scoped CSS fallback if YouTube changes or replaces the API.
    }
  });
})();
