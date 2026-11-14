(() => {
  "use strict";

  // This feedback shape is shared by many controls. Always check the button label too.
  const FEEDBACK_SELECTOR = ".ytSpecTouchFeedbackShapeFill";
  const BUTTON_SELECTOR = 'button, [role="button"]';
  const JUMP_AHEAD_PATTERN = /\bjump\s+ahead\b/i;
  const CHECK_INTERVAL_MS = 1000;
  const PROBE_CLASS = "youtube-hide-timeline-probe";
  const skippedVideos = new Set();
  let scanQueued = false;
  let lastPlayerActivity = -Infinity;
  let navigating = false;
  let jumpNotice = null;
  let noticeTimer = null;
  let timelineProbe = null;
  let previewPlayer = null;

  function dispatchHover(target, type, options, bubbles = true) {
    if (type.startsWith("pointer")) {
      if (typeof PointerEvent !== "function") return;
      target.dispatchEvent(new PointerEvent(type, {
        ...options, bubbles, pointerId: 1, pointerType: "mouse", isPrimary: true
      }));
    } else {
      target.dispatchEvent(new MouseEvent(type, { ...options, bubbles }));
    }
  }

  function endTimelineProbe(sendLeave = true) {
    const probe = timelineProbe;
    if (!probe) return;
    timelineProbe = null;
    window.clearTimeout(probe.timer);
    if (!sendLeave) return;
    const options = { ...probe.options, relatedTarget: probe.video };
    dispatchHover(probe.timeline, "pointerout", options);
    dispatchHover(probe.timeline, "mouseout", options);
    for (const target of probe.targets.slice().reverse()) {
      dispatchHover(target, "pointerleave", options, false);
      dispatchHover(target, "mouseleave", options, false);
    }
  }

  function restoreUserPreviews() {
    previewPlayer?.classList.remove(PROBE_CLASS);
    previewPlayer = null;
  }

  function probeTimeline(player, video) {
    const timeline = player.querySelector(".ytp-progress-bar") ||
      player.querySelector(".ytp-progress-bar-container");
    if (!timeline || timelineProbe || !Number.isFinite(video.duration) || video.duration <= 0 ||
        !Number.isFinite(video.currentTime)) return;
    const container = timeline.closest(".ytp-progress-bar-container");
    // Let a real hover retain YouTube's normal thumbnail preview and controls.
    if (timeline.matches(":hover") || container?.matches(":hover")) return;
    const bounds = timeline.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const inset = Math.min(1, bounds.width / 2);
    const progress = Math.max(0, Math.min(1, video.currentTime / video.duration));
    const options = {
      view: window, buttons: 0, relatedTarget: video,
      clientX: bounds.left + Math.max(inset, Math.min(bounds.width - inset, bounds.width * progress)),
      clientY: bounds.top + bounds.height / 2
    };
    const targets = container && container !== timeline ? [container, timeline] : [timeline];
    restoreUserPreviews();
    previewPlayer = player;
    // Keep suppression until genuine user input, including delayed tooltip updates.
    player.classList.add(PROBE_CLASS);
    const probe = { timeline, targets, video, options, timer: null };
    timelineProbe = probe;
    probe.timer = window.setTimeout(() => {
      if (timelineProbe !== probe) return;
      try { tryJumpAhead(); } finally { endTimelineProbe(); }
    }, 250);
    dispatchHover(timeline, "pointerover", options);
    dispatchHover(timeline, "mouseover", options);
    for (const target of targets) {
      dispatchHover(target, "pointerenter", options, false);
      dispatchHover(target, "mouseenter", options, false);
    }
    dispatchHover(timeline, "pointermove", options);
    dispatchHover(timeline, "mousemove", options);
    // Only hover events: no down/up/click events or direct changes to currentTime.
  }

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

  function revealPlayerActions(player) {
    const video = player.querySelector("video");
    if (!video || video.paused || video.ended || video.seeking || video.readyState < 2) return;
    const timeline = player.querySelector(".ytp-progress-bar-container") || player.querySelector(".ytp-progress-bar");
    if (timeline?.matches(":hover")) return;

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
      probeTimeline(player, video);
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
    try { button.click(); } finally { endTimelineProbe(); }
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
      endTimelineProbe();
      restoreUserPreviews();
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
    for (const event of ["pointermove", "mousemove", "pointerover", "mouseover", "pointerdown", "mousedown", "keydown"]) {
      document.addEventListener(event, (input) => {
        if (!input.isTrusted) return;
        if (input.type !== "keydown" &&
            !(input.target instanceof Element && input.target.closest("#movie_player"))) return;
        // A real pointer now owns hover state. Do not send fake leave events over it.
        endTimelineProbe(input.type === "keydown");
        restoreUserPreviews();
        lastPlayerActivity = Date.now();
      }, true);
    }
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
