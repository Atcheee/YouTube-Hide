(() => {
  "use strict";

  // MAIN world: Crunchyroll's media-session handlers and React timeline callback
  // belong to the page. Expose only fixed playback commands, never extension APIs.
  if (window.__playbackPlusPlayerBridgeV4) return;
  window.__playbackPlusPlayerBridgeV4 = true;
  const handlers = new Map();
  let positionState = null;
  let pendingPositions = new WeakMap();
  const seekRequests = new WeakMap();
  const introSkips = new WeakMap();
  const SEEK_TIMEOUT = 2000;
  const handledKeys = new Set();
  // Register at document_start, before the site's window-capture shortcuts.
  // The isolated script decides settings/focus and calls the native engine.
  // Its synchronous acknowledgement also stops interception after invalidation.
  window.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape", "j", "J", "k", "K", "l", "L"].includes(event.key)) {
      pendingPositions = new WeakMap();
      return;
    }
    const target = event.composedPath().find(node => node instanceof Element);
    if (!target) return;
    const request = new CustomEvent("playback-plus-keyboard-request-v4", {
      bubbles: true, composed: true, cancelable: true,
      detail: JSON.stringify({ key: event.key, code: event.code })
    });
    if (!target.dispatchEvent(request)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      handledKeys.add(event.code || event.key);
    } else pendingPositions = new WeakMap();
  }, true);
  window.addEventListener("keyup", event => {
    if (!handledKeys.delete(event.code || event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener("blur", () => handledKeys.clear());
  const session = navigator.mediaSession;
  if (session?.setActionHandler) {
    const original = session.setActionHandler;
    try {
      session.setActionHandler = function(action, handler) {
        const result = original.call(this, action, handler);
        if (this === session && ["seekbackward", "seekforward", "seekto", "play", "pause"].includes(action)) {
          pendingPositions = new WeakMap();
          if (typeof handler === "function") handlers.set(action, handler);
          else handlers.delete(action);
        }
        return result;
      };
    } catch { /* Late connections can still use the native timeline callback. */ }
    if (session.setPositionState) {
      const originalPosition = session.setPositionState;
      try {
        session.setPositionState = function(state) {
          const result = originalPosition.call(this, state);
          if (this === session) positionState = Number.isFinite(state?.position) && Number.isFinite(state?.duration)
            ? { current: state.position, duration: state.duration } : null;
          return result;
        };
      } catch { /* Native timeline callbacks remain available. */ }
    }
  }

  function trackTransition(transitions, video, position) {
    transitions.set(video, { position, time: Date.now(), source: video.currentSrc, page: location.href });
  }

  function currentTransition(transitions, video) {
    const transition = transitions.get(video);
    if (transition && transition.source === video.currentSrc && transition.page === location.href) return transition;
    transitions.delete(video);
    return null;
  }

  document.addEventListener("seeked", ({ target: video }) => {
    const request = currentTransition(seekRequests, video);
    if (request && (request.position === undefined || Math.abs(video.currentTime - request.position) <= 1)) {
      seekRequests.delete(video);
    }
    const intro = currentTransition(introSkips, video);
    if (intro && !intro.landed) {
      intro.landed = true;
      intro.time = Date.now();
    }
  }, true);

  document.addEventListener("playback-plus-before-intro-skip", event => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
    const request = currentTransition(seekRequests, video);
    // The engine may have queued a seek before the media sets seeking=true.
    if (request && Date.now() - request.time < SEEK_TIMEOUT) {
      event.preventDefault();
      return;
    }
    pendingPositions.delete(video);
    trackTransition(introSkips, video);
  }, true);

  function absoluteSeek(video, control, sign, seconds, route, intro) {
    const now = Date.now();
    const pending = pendingPositions.get(video);
    const sameSource = pending && pending.source === video.currentSrc && pending.page === location.href && pending.duration === control.duration && pending.route === route;
    // Buffering can leave the UI clock behind the requested position. Accumulate
    // rapid presses until acknowledgement. After an intro skip, the native
    // control may still report the pre-skip position even after media has landed.
    const current = intro?.landed && Math.abs(control.current - video.currentTime) > 1
      ? video.currentTime : control.current;
    const base = sameSource && now - pending.time < SEEK_TIMEOUT && Math.abs(current - pending.position) > 1
      ? pending.position : current;
    const position = Math.max(0, Math.min(control.duration, base + sign * seconds));
    trackTransition(seekRequests, video, position);
    control.seek(position);
    pendingPositions.set(video, { position, route, time: now, source: video.currentSrc,
      page: location.href, duration: control.duration });
  }

  for (const event of ["pointerdown", "loadedmetadata", "emptied"]) {
    document.addEventListener(event, ({ target }) => {
      pendingPositions = new WeakMap();
      if (event !== "pointerdown") {
        positionState = null;
        seekRequests.delete(target);
        introSkips.delete(target);
      }
    }, true);
  }
  window.addEventListener("popstate", () => { pendingPositions = new WeakMap(); positionState = null; });

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
          return { seek: props.seekTo, current, duration, route: slider };
        }
      }
    }
    return null;
  }

  document.addEventListener("playback-plus-native-command-v4", event => {
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
    const nativeAbsolute = ownSession && handlers.has("seekto") && positionState;
    try {
      if (command.action === "probe") {
        if (nativeSeek || nativeAbsolute || timeline(video)) event.preventDefault();
      } else if (command.action === "toggle") {
        const action = video.paused || video.ended ? "play" : "pause";
        const handler = ownSession && handlers.get(action);
        if (handler) { handler({ action }); event.preventDefault(); return; }
        const root = video.closest('#player-container, #player, #vilos, .video-player-wrapper, [data-testid="player"]') || document;
        const button = [...root.querySelectorAll("button")].find(button =>
          new RegExp(`^${action}(?: video)?$`, "i").test(button.getAttribute("aria-label") || "") &&
          !button.disabled && button.getAttribute("aria-disabled") !== "true");
        if (button) { button.click(); event.preventDefault(); }
      } else {
        let intro = currentTransition(introSkips, video);
        const recentIntro = intro && Date.now() - intro.time < SEEK_TIMEOUT;
        if (intro && !intro.landed && (video.seeking || recentIntro)) {
          event.preventDefault();
          return;
        }
        if (intro && !recentIntro) {
          introSkips.delete(video);
          intro = null;
        }
        // A popup may attach after media-session registration. Use the timeline's
        // own seek callback and displayed time.
        const sign = command.action === "seekbackward" ? -1 : 1;
        const control = timeline(video);
        if (nativeAbsolute) {
          const handler = handlers.get("seekto");
          absoluteSeek(video, { ...positionState, seek: position => handler({ action: "seekto", seekTime: position }) }, sign, command.seconds, handler, intro);
        } else if (control) absoluteSeek(video, control, sign, command.seconds, control.route, intro);
        else if (nativeSeek) {
          trackTransition(seekRequests, video);
          handlers.get(command.action)({ action: command.action, seekOffset: command.seconds });
        } else return;
        event.preventDefault();
      }
    } catch {
      if (command.action.startsWith("seek")) seekRequests.delete(video);
      // Unsupported/replaced controls fall back to native behavior.
    }
  }, true);
})();
