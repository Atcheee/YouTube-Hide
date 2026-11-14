(() => {
  "use strict";

  // This feedback shape is shared by many controls. Always check the button label too.
  const FEEDBACK_SELECTOR = ".ytSpecTouchFeedbackShapeFill";
  const BUTTON_SELECTOR = 'button, [role="button"]';
  const JUMP_AHEAD_PATTERN = /\bjump\s+ahead\b/i;
  const CHECK_INTERVAL_MS = 1000;
  const skippedVideos = new Set();
  let scanQueued = false;
  let lastPlayerActivity = -Infinity;
  let navigating = false;
  let jumpNotice = null;
  let noticeTimer = null;

  function clearJumpNotice() {
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    noticeTimer = null;
    jumpNotice?.remove();
    jumpNotice = null;
  }

  function showJumpNotice(player) {
    clearJumpNotice();
    jumpNotice = document.createElement("div");
    jumpNotice.className = "youtube-hide-jump-notice";
    jumpNotice.setAttribute("role", "status");
    jumpNotice.setAttribute("aria-live", "polite");
    jumpNotice.textContent = "Jumped ahead";
    player.appendChild(jumpNotice);
    noticeTimer = window.setTimeout(clearJumpNotice, 2000);
  }

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname === "/watch") return url.searchParams.get("v");
    return url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1] || null;
  }

  function isJumpAheadButton(button) {
    return button &&
      button.closest("#movie_player") &&
      button.closest(".ytp-timely-actions-overlay") &&
      button.querySelector(FEEDBACK_SELECTOR) &&
      JUMP_AHEAD_PATTERN.test([
        button.textContent,
        button.getAttribute("aria-label"),
        button.getAttribute("title")
      ].filter(Boolean).join(" "));
  }

  function isAvailable(button) {
    if (!button.isConnected || button.matches(':disabled, [aria-disabled="true"]')) return false;
    if (button.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (!button.getClientRects().length) return false;

    for (let element = button; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse" || style.opacity === "0") return false;
    }
    return true;
  }

  function availableJumpButton(player) {
    for (const shape of player.querySelectorAll(FEEDBACK_SELECTOR)) {
      const button = shape.closest(BUTTON_SELECTOR);
      if (isJumpAheadButton(button) && isAvailable(button)) return button;
    }
    return null;
  }

  function hoverTimeline(player, video) {
    const timeline = player.querySelector(".ytp-progress-bar") ||
      player.querySelector(".ytp-progress-bar-container");
    if (!timeline || !Number.isFinite(video.duration) || video.duration <= 0 ||
        !Number.isFinite(video.currentTime)) return;

    const bounds = timeline.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const progress = Math.max(0, Math.min(1, video.currentTime / video.duration));
    const inset = Math.min(1, bounds.width / 2);
    const options = {
      view: window,
      clientX: bounds.left + Math.max(inset, Math.min(bounds.width - inset, bounds.width * progress)),
      clientY: bounds.top + bounds.height / 2,
      relatedTarget: video,
      buttons: 0
    };

    function dispatch(target, type, bubbles) {
      if (type.startsWith("pointer")) {
        if (typeof PointerEvent !== "function") return;
        target.dispatchEvent(new PointerEvent(type, {
          ...options, bubbles, pointerId: 1, pointerType: "mouse", isPrimary: true
        }));
      } else {
        target.dispatchEvent(new MouseEvent(type, { ...options, bubbles }));
      }
    }

    dispatch(timeline, "pointerover", true);
    dispatch(timeline, "mouseover", true);
    // mouseenter/pointerenter do not bubble. Notify the enclosing hover surface too.
    const container = timeline.closest(".ytp-progress-bar-container");
    for (const target of container && container !== timeline ? [container, timeline] : [timeline]) {
      dispatch(target, "pointerenter", false);
      dispatch(target, "mouseenter", false);
    }
    dispatch(timeline, "pointermove", true);
    dispatch(timeline, "mousemove", true);
    // Never send down/up/click events or change currentTime here: hover must not seek.
  }

  function revealPlayerActions(player) {
    const video = player.querySelector("video");
    if (!video || video.paused || video.ended || video.seeking || video.readyState < 2) return;

    const now = Date.now();
    if (now - lastPlayerActivity < CHECK_INTERVAL_MS) return;
    lastPlayerActivity = now;

    // Ask YouTube to reveal hover-driven actions without focusing the tab or moving
    // the real cursor. Do not bypass disabled/hidden controls if it ignores the event.
    const bounds = player.getBoundingClientRect();
    video.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      view: window,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2
    }));
    if (!navigating && !skippedVideos.has(currentVideoId()) && !availableJumpButton(player)) {
      hoverTimeline(player, video);
    }
  }

  function tryJumpAhead() {
    scanQueued = false;
    const videoId = currentVideoId();
    if (navigating || !videoId || skippedVideos.has(videoId)) return;

    const player = document.getElementById("movie_player");
    if (!player) return;

    let button = availableJumpButton(player);
    if (!button) {
      revealPlayerActions(player);
      button = availableJumpButton(player);
    }
    if (!button || navigating || currentVideoId() !== videoId || skippedVideos.has(videoId)) return;

    // Record before clicking: click handlers can synchronously change the DOM.
    // Keep video IDs across seeks, button replacements and SPA back navigation.
    skippedVideos.add(videoId);
    button.click();
    if (!navigating && currentVideoId() === videoId) showJumpNotice(player);
  }

  function scheduleScan() {
    const videoId = currentVideoId();
    if (navigating || !videoId || skippedVideos.has(videoId) || scanQueued) return;
    // Animation frames may stop in background tabs. Microtasks still run when
    // playback events, DOM mutations or our fallback timer wake the page.
    scanQueued = true;
    queueMicrotask(tryJumpAhead);
  }

  function init() {
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "inert", "disabled", "aria-disabled", "aria-hidden", "aria-label", "title"]
    });

    document.addEventListener("yt-navigate-start", () => {
      navigating = true;
      clearJumpNotice();
    });
    document.addEventListener("yt-navigate-finish", () => {
      navigating = false;
      scheduleScan();
    });
    window.addEventListener("popstate", scheduleScan);
    document.addEventListener("visibilitychange", scheduleScan);
    window.addEventListener("focus", scheduleScan);
    window.setInterval(scheduleScan, CHECK_INTERVAL_MS);
    // Also catch visibility changes caused by playback or CSS transitions.
    for (const event of ["timeupdate", "seeked", "playing", "transitionend", "animationend"]) {
      document.addEventListener(event, scheduleScan, true);
    }
    // A manual skip also means a later rewind should be left alone.
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest(BUTTON_SELECTOR) : null;
      const videoId = currentVideoId();
      if (!navigating && videoId && isJumpAheadButton(button)) skippedVideos.add(videoId);
    }, true);
    scheduleScan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
