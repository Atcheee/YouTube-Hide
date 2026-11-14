(() => {
  "use strict";

  // MAIN world: Crunchyroll's media-session handlers and React timeline callback
  // belong to the page. Expose only fixed playback commands, never extension APIs.
  if (window.__playbackPlusPlayerBridge) return;
  window.__playbackPlusPlayerBridge = true;
  const handlers = new Map();
  const session = navigator.mediaSession;
  if (session?.setActionHandler) {
    const original = session.setActionHandler;
    try {
      session.setActionHandler = function(action, handler) {
        const result = original.call(this, action, handler);
        if (this === session && ["seekbackward", "seekforward", "play", "pause"].includes(action)) {
          if (typeof handler === "function") handlers.set(action, handler);
          else handlers.delete(action);
        }
        return result;
      };
    } catch { /* Late connections can still use the native timeline callback. */ }
  }

  function timeline(video) {
    const root = video.closest('#player-container, #player, #vilos, .video-player-wrapper, [data-testid="player"]') || document;
    // Scoped to the timeline; do not inspect unrelated application state.
    for (const slider of root.querySelectorAll('input.timeline-slider, [data-testid="timeline-controls-container"] input[type="range"]')) {
      const current = Number(slider.value);
      const duration = Number(slider.max);
      if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0 || slider.disabled) continue;
      const key = Object.keys(slider).find(key => key.startsWith("__reactFiber$"));
      let fiber = key && slider[key];
      for (let depth = 0; fiber && depth < 25; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (typeof props?.seekTo === "function" && Number.isFinite(props.duration) && Math.abs(props.duration - duration) < 1) {
          return { seek: props.seekTo, current, duration };
        }
      }
    }
    return null;
  }

  document.addEventListener("playback-plus-native-command", event => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
    let command;
    try { command = JSON.parse(event.detail); } catch { return; }
    if (!["probe", "seekbackward", "seekforward", "toggle"].includes(command?.action)) return;
    if (command.action.startsWith("seek") && ![5, 10].includes(command.seconds)) return;
    const visible = [...document.querySelectorAll("video")].filter(element => element.getClientRects().length);
    // A media session is document-wide. Never route a preview to another player.
    const ownSession = visible.length === 1 && visible[0] === video;
    const nativeSeek = ownSession && handlers.has("seekbackward") && handlers.has("seekforward");
    try {
      if (command.action === "probe") {
        if (nativeSeek || timeline(video)) event.preventDefault();
      } else if (command.action === "toggle") {
        const action = video.paused || video.ended ? "play" : "pause";
        const handler = ownSession && handlers.get(action);
        if (handler) { handler({ action }); event.preventDefault(); return; }
        const root = video.closest('#player-container, #player, #vilos, .video-player-wrapper, [data-testid="player"]') || document;
        const button = [...root.querySelectorAll("button")].find(button =>
          new RegExp(`^${action}(?: video)?$`, "i").test(button.getAttribute("aria-label") || "") &&
          !button.disabled && button.getAttribute("aria-disabled") !== "true");
        if (button) { button.click(); event.preventDefault(); }
      } else if (nativeSeek) {
        handlers.get(command.action)({ action: command.action, seekOffset: command.seconds });
        event.preventDefault();
      } else {
        // A popup may attach after media-session registration. Use the timeline's
        // own seek callback and displayed time, not HTMLMediaElement.currentTime.
        const control = timeline(video);
        if (!control) return;
        const sign = command.action === "seekbackward" ? -1 : 1;
        control.seek(Math.max(0, Math.min(control.duration, control.current + sign * command.seconds)));
        event.preventDefault();
      }
    } catch { /* Unsupported/replaced controls fall back to native behavior. */ }
  }, true);
})();
