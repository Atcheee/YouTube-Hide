(() => {
  "use strict";

  // This feedback shape is shared by many controls. Always check the button label too.
  const FEEDBACK_SELECTOR = ".ytSpecTouchFeedbackShapeFill";
  const BUTTON_SELECTOR = 'button, [role="button"]';
  const JUMP_AHEAD_PATTERN = /\bjump\s+ahead\b/i;
  const CHECK_INTERVAL_MS = 1000;
  const USER_IDLE_MS = 3000;
  const PROBE_CLASS = "youtube-hide-timeline-probe";
  const QUIET_CLASS = "youtube-hide-auto-activity";
  const skippedVideos = new Set();
  let scanQueued = false;
  let lastPlayerActivity = -Infinity;
  let navigating = false;
  let jumpNotice = null;
  let noticeTimer = null;
  let timelineProbe = null;
  let previewPlayer = null;
  let quietPlayer = null;
  let automaticPlayer = null;
  let pointerPlayer = null;
  let pointerPressed = false;
  let pointerOverControls = false;
  let lastPointerActivity = -Infinity;
  let lastKeyboardActivity = -Infinity;
  let enabled = false;
  let showNotice = true;

  function userIsInteracting(player) {
    const now = Date.now();
    return now - lastKeyboardActivity < USER_IDLE_MS ||
      (pointerPlayer === player && (pointerPressed || pointerOverControls || now - lastPointerActivity < USER_IDLE_MS));
  }

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
    // A leave at the old timeline coordinates can still look like an active
    // timeline hover to the player's shared pointer handlers.
    const bounds = probe.video.getBoundingClientRect();
    const options = { ...probe.options, relatedTarget: probe.video,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
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

  function restoreUserControls() {
    quietPlayer?.classList.remove(QUIET_CLASS);
    quietPlayer = null;
    automaticPlayer = null;
  }

  function endPlayerActivity() {
    const player = automaticPlayer;
    automaticPlayer = null;
    if (!player || userIsInteracting(player)) return;
    const video = player.querySelector("video");
    if (!video) return;
    const bounds = player.getBoundingClientRect();
    const options = { view: window, buttons: 0, relatedTarget: null,
      clientX: bounds.left - 1, clientY: bounds.top - 1 };
    dispatchHover(video, "pointerout", options);
    dispatchHover(video, "mouseout", options);
    // Ending only timeline hover leaves the rest of the player awake. Notify
    // the video surface and its ancestors, including fullscreen quick actions.
    for (let target = video; target; target = target.parentElement) {
      dispatchHover(target, "pointerleave", options, false);
      dispatchHover(target, "mouseleave", options, false);
      if (target === player) break;
    }
  }

  function quietAutomaticActivity(player) {
    if (quietPlayer && quietPlayer !== player) restoreUserControls();
    if (previewPlayer && previewPlayer !== player) restoreUserPreviews();
    quietPlayer = player;
    automaticPlayer = player;
    previewPlayer = player;
    // Apply before mouse events so unattended probes cannot flash native chrome.
    player.classList.add(QUIET_CLASS, PROBE_CLASS);
  }

  function probeTimeline(player, video) {
    const timeline = player.querySelector(".ytp-progress-bar") ||
      player.querySelector(".ytp-progress-bar-container");
    if (!timeline || timelineProbe || !Number.isFinite(video.duration) || video.duration <= 0 ||
        !Number.isFinite(video.currentTime)) return;
    const container = timeline.closest(".ytp-progress-bar-container");
    if (userIsInteracting(player)) return;
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
    // Keep delayed automatic previews suppressed while unattended. Real input
    // ends this probe and releases all masks before YouTube handles that input.
    const probe = { timeline, targets, video, options, timer: null };
    timelineProbe = probe;
    probe.timer = window.setTimeout(() => {
      if (timelineProbe !== probe) return;
      try { tryJumpAhead(); } finally { endTimelineProbe(); endPlayerActivity(); }
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
    if (!showNotice) return;
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
    if (userIsInteracting(player)) return;

    const now = Date.now();
    if (now - lastPlayerActivity < CHECK_INTERVAL_MS) return;
    lastPlayerActivity = now;
    quietAutomaticActivity(player);

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
    if (!enabled || navigating || !videoId || skippedVideos.has(videoId)) return;

    const player = document.getElementById("movie_player");
    if (!player) return;

    let button = availableJumpButton(player);
    if (!button) {
      revealPlayerActions(player);
      button = availableJumpButton(player);
    }
    if (!enabled || !button || navigating || currentVideoId() !== videoId || skippedVideos.has(videoId)) {
      if (!timelineProbe) endPlayerActivity();
      return;
    }

    // Record before clicking: click handlers can synchronously change the DOM.
    // Keep video IDs across seeks, button replacements and SPA back navigation.
    skippedVideos.add(videoId);
    try { button.click(); } finally { endTimelineProbe(); endPlayerActivity(); }
    if (!navigating && currentVideoId() === videoId) showJumpNotice(player);
  }

  function scheduleScan() {
    const videoId = currentVideoId();
    if (!enabled || navigating || !videoId || skippedVideos.has(videoId) || scanQueued) return;
    // Animation frames may stop in background tabs. Microtasks still run when
    // playback events, DOM mutations or our fallback timer wake the page.
    scanQueued = true;
    queueMicrotask(tryJumpAhead);
  }

  function init() {
    PlaybackPlusSettings.subscribe((settings) => {
      enabled = settings.extensionEnabled && settings.youtubeEnabled && settings.youtubeAutoJumpEnabled;
      showNotice = settings.showSkipNotice;
      if (!showNotice) clearJumpNotice();
      if (!enabled) {
        endTimelineProbe();
        endPlayerActivity();
        restoreUserPreviews();
        restoreUserControls();
        clearJumpNotice();
      } else scheduleScan();
    });
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "inert", "disabled", "aria-disabled", "aria-hidden", "aria-label", "title"]
    });

    document.addEventListener("yt-navigate-start", () => {
      navigating = true;
      pointerPlayer = null;
      pointerPressed = false;
      pointerOverControls = false;
      lastKeyboardActivity = -Infinity;
      endTimelineProbe();
      endPlayerActivity();
      restoreUserPreviews();
      restoreUserControls();
      clearJumpNotice();
    });
    document.addEventListener("yt-navigate-finish", () => {
      navigating = false;
      scheduleScan();
    });
    window.addEventListener("popstate", scheduleScan);
    function endInactiveHover() {
      pointerPlayer = null;
      pointerPressed = false;
      pointerOverControls = false;
      lastKeyboardActivity = -Infinity;
      endTimelineProbe();
      endPlayerActivity();
      lastPlayerActivity = Date.now();
    }
    // Switching focus to another window/taskbar need not hide the current tab.
    window.addEventListener("blur", endInactiveHover);
    window.addEventListener("pagehide", endInactiveHover);
    document.addEventListener("visibilitychange", () => { endInactiveHover(); scheduleScan(); });
    window.addEventListener("focus", () => { endInactiveHover(); scheduleScan(); });
    window.setInterval(scheduleScan, CHECK_INTERVAL_MS);
    // Boundary events can be trusted even when caused only by layout changes.
    // They must never count as physical movement or unmask automatic controls.
    for (const event of ["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "wheel", "keydown"]) {
      document.addEventListener(event, (input) => {
        if (!input.isTrusted) return;
        const targetPlayer = input.target instanceof Element ? input.target.closest("#movie_player") : null;
        if (input.type === "keydown") lastKeyboardActivity = Date.now();
        else {
          pointerPlayer = targetPlayer;
          pointerPressed = Boolean(input.buttons & 1);
          pointerOverControls = Boolean(targetPlayer && input.target.closest(
            ".ytp-chrome-bottom, .ytp-chrome-top, .ytp-progress-bar-container, .ytp-progress-bar, .ytp-popup, .ytp-fullscreen-quick-actions, .ytp-fullscreen-grid"));
          lastPointerActivity = Date.now();
          if (!targetPlayer) { scheduleScan(); return; }
        }
        const overTimeline = input.type !== "keydown" && input.target instanceof Element &&
          input.target.closest(".ytp-progress-bar-container, .ytp-progress-bar");
        // A return to the video surface must close the artificial timeline hover.
        // Hand every native tooltip and control back to real user input.
        endTimelineProbe(!overTimeline);
        if (!overTimeline) endPlayerActivity();
        restoreUserControls();
        restoreUserPreviews();
        lastPlayerActivity = Date.now();
      }, true);
    }
    for (const event of ["pointerout", "mouseout", "pointerleave", "mouseleave", "pointercancel"]) {
      document.addEventListener(event, (input) => {
        if (!input.isTrusted) return;
        const player = input.target instanceof Element ? input.target.closest("#movie_player") : pointerPlayer;
        if (!player && input.target !== document && input.target !== document.documentElement) return;
        if (input.relatedTarget instanceof Node && player?.contains(input.relatedTarget)) return;
        pointerPlayer = null;
        pointerPressed = false;
        pointerOverControls = false;
        endTimelineProbe();
        endPlayerActivity();
        scheduleScan();
      }, true);
    }
    for (const event of ["pause", "ended"]) {
      document.addEventListener(event, (input) => {
        if (!(input.target instanceof HTMLVideoElement) || !input.target.closest("#movie_player")) return;
        endTimelineProbe();
        endPlayerActivity();
        restoreUserControls();
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
