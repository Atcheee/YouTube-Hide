(() => {
  "use strict";

  const settingsContext = PlaybackPlusSettings;
  if (settingsContext.install && !settingsContext.install("crunchyroll-skip-intro")) return;

  const BUTTON_SELECTOR = 'button[aria-label="Skip Intro"]';
  const skippedEpisodes = new Set();
  const pendingClaims = new Map();
  let claimSequence = 0;
  let manualSkips = 0;
  let diagnosticState = "Starting";
  let lastButtonProblem = "Waiting for Skip Intro";
  let observer;
  const observedRoots = new WeakSet();
  const observerOptions = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["class", "style", "hidden", "inert", "disabled", "aria-disabled", "aria-hidden", "aria-label"]
  };
  const isTopFrame = window.top === window;
  let queued = false;
  let claiming = false;
  let nextClaimAt = 0;
  let autoClicking = false;
  let notice = null;
  let noticeVideo = null;
  let noticeTimer = null;
  let lastPath = location.pathname;
  let enabled = false;
  let showSkipNotice = true;

  function currentEpisodeId() {
    return location.pathname.match(/\/(?:watch)\/([^/]+)/)?.[1] || null;
  }

  function claimEpisode(manual) {
    const episodeId = currentEpisodeId();
    if (!episodeId) return { allowed: false, reason: "Watch-page episode ID unavailable" };
    if (manual) {
      skippedEpisodes.add(episodeId);
      pendingClaims.delete(episodeId);
      return { allowed: false, episodeId, reason: "Manually skipped" };
    }
    if (!enabled) return { allowed: false, episodeId, reason: "Auto-skip paused in settings" };
    if (skippedEpisodes.has(episodeId)) return { allowed: false, episodeId, reason: "Already skipped this episode" };
    const pending = pendingClaims.get(episodeId);
    if (pending && Date.now() - pending.time < 5000) return { allowed: false, episodeId, reason: "Skip request pending" };
    const token = String(++claimSequence);
    pendingClaims.set(episodeId, { token, time: Date.now() });
    return { allowed: true, episodeId, token };
  }

  function finishClaim(message) {
    if (pendingClaims.get(message.episodeId)?.token !== message.token) return;
    pendingClaims.delete(message.episodeId);
    if (message.action === "commit") skippedEpisodes.add(message.episodeId);
  }

  function completeClaim(response, action) {
    const message = { action, episodeId: response.episodeId, token: response.token };
    if (isTopFrame) { finishClaim(message); return; }
    chrome.runtime.sendMessage({ type: "crunchyroll-skip-intro", ...message }, () => { void chrome.runtime.lastError; });
  }

  function requestClaim(manual, callback) {
    if (isTopFrame) {
      callback(claimEpisode(manual));
      return;
    }
    // Relay through our extension to the watch page. The player iframe's URL
    // may contain no episode ID, and its DOM can be recreated on a rewind.
    chrome.runtime.sendMessage({ type: "crunchyroll-skip-intro", manual }, (response) => {
      if (chrome.runtime.lastError) { callback({ allowed: false, reason: chrome.runtime.lastError.message }); return; }
      callback(response || { allowed: false, reason: "No watch-page response" });
    });
  }

  function isIntroButton(button) {
    return button?.matches(BUTTON_SELECTOR) &&
      button.querySelector('[data-testid="skip-intro-icon"]') &&
      /^skip\s+intro$/i.test(button.textContent.trim());
  }

  function searchRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        if (observer && !observedRoots.has(element.shadowRoot)) {
          observer.observe(element.shadowRoot, observerOptions);
          observedRoots.add(element.shadowRoot);
        }
      }
    }
    return roots;
  }

  function findAll(selector) {
    return searchRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  function composedParent(element) {
    return element.parentElement || element.getRootNode().host || null;
  }

  function playerTarget(button) {
    if (!isIntroButton(button)) { lastButtonProblem = "Intro label/icon does not match"; return null; }
    if (!button.isConnected || button.matches(':disabled, [aria-disabled="true"]')) {
      lastButtonProblem = "Skip Intro is disabled or detached"; return null;
    }
    if (button.closest("[hidden], [inert]") || !button.getClientRects().length) {
      lastButtonProblem = "Skip Intro is outside layout"; return null;
    }

    // Crunchyroll uses aria-hidden, opacity:0 and pointer-events:none for the
    // unhovered but active button. Those do not disable programmatic clicks.
    for (let element = button; element; element = composedParent(element)) {
      if (element.matches("[hidden], [inert]")) { lastButtonProblem = "Player is hidden or inert"; return null; }
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse") { lastButtonProblem = "Skip Intro is hidden by layout"; return null; }
    }
    for (let root = composedParent(button); root; root = composedParent(root)) {
      const video = root.querySelector("video");
      if (video) {
        if (video.readyState >= 2 && !video.ended && !video.seeking) return video;
        lastButtonProblem = "Video is loading, ended, or seeking";
        return null;
      }
    }
    // Controls can be outside the media iframe or its shadow root. The exact
    // labelled/icon-marked button still has its own working click handler.
    for (let root = composedParent(button); root; root = composedParent(root)) {
      const iframe = root.querySelector("iframe");
      if (iframe) return iframe;
    }
    return button.closest('[data-testid="player-controls-root"], [data-testid="player"], #player-container, #player, #vilos') || document.documentElement;
  }

  function clearNotice() {
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    noticeTimer = null;
    notice?.remove();
    notice = null;
    noticeVideo = null;
  }

  function positionNotice() {
    if (!notice) return;
    if (!noticeVideo?.isConnected) { clearNotice(); return; }
    const host = document.fullscreenElement || document.body;
    if (notice.parentElement !== host) host.appendChild(notice);
    const bounds = noticeVideo.getBoundingClientRect();
    notice.style.left = `${bounds.left + bounds.width / 2}px`;
    notice.style.top = `${bounds.top + bounds.height / 2}px`;
  }

  function showNotice(video) {
    clearNotice();
    if (!showSkipNotice) return;
    noticeVideo = video;
    notice = document.createElement("div");
    notice.className = "youtube-hide-crunchyroll-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.textContent = "Jumped ahead";
    positionNotice();
    noticeTimer = window.setTimeout(clearNotice, 2000);
  }

  function scan() {
    if (settingsContext.isActive?.() === false) return;
    queued = false;
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      clearNotice();
    }
    if (!enabled) { diagnosticState = "Auto-skip paused in settings"; return; }
    if (claiming || Date.now() < nextClaimAt) return;
    if (isTopFrame && !currentEpisodeId()) { diagnosticState = "Watch-page episode ID unavailable"; return; }
    if (isTopFrame && skippedEpisodes.has(currentEpisodeId())) { diagnosticState = "Already skipped this episode"; return; }

    diagnosticState = "Waiting for Skip Intro";
    for (const button of findAll(BUTTON_SELECTOR)) {
      const video = playerTarget(button);
      if (!video) { diagnosticState = lastButtonProblem; continue; }
      const source = video.currentSrc;
      const path = location.pathname;
      const manualCount = manualSkips;
      claiming = true;
      diagnosticState = "Requesting episode skip";
      nextClaimAt = Date.now() + 1000;
      requestClaim(false, (response) => {
        claiming = false;
        if (!response.allowed) { diagnosticState = response.reason || "Watch page rejected skip request"; return; }
        const target = playerTarget(button);
        if (!enabled || !target || location.pathname !== path || manualSkips !== manualCount ||
            video.currentSrc !== source) {
          completeClaim(response, "release");
          diagnosticState = "Player changed; waiting to retry";
          return;
        }
        autoClicking = true;
        try { button.click(); } finally { autoClicking = false; }
        completeClaim(response, "commit");
        diagnosticState = "Clicked Skip Intro";
        showNotice(target);
      });
      return;
    }
  }

  function scheduleScan() {
    if (settingsContext.isActive?.() === false) return;
    if (queued) return;
    queued = true;
    queueMicrotask(scan);
  }

  function init() {
    PlaybackPlusSettings.subscribe((settings) => {
      enabled = settings.extensionEnabled && settings.crunchyrollEnabled && settings.crunchyrollAutoSkipEnabled;
      showSkipNotice = settings.showSkipNotice;
      if (!enabled || !showSkipNotice) clearNotice();
      scheduleScan();
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (settingsContext.isActive?.() === false) return false;
        if (sender.id !== chrome.runtime.id) return false;
        if (message?.type === "crunchyroll-report-status") {
          chrome.runtime.sendMessage({ type: "crunchyroll-status", status: {
            frame: isTopFrame ? "Watch page" : "Player frame",
            state: diagnosticState,
            buttons: findAll(BUTTON_SELECTOR).length,
            videos: findAll("video").length,
            version: chrome.runtime.getManifest().version
          } }, () => { void chrome.runtime.lastError; });
          sendResponse({ ok: true });
        } else if (isTopFrame && message?.type === "crunchyroll-claim-intro") {
          if (message.action === "commit" || message.action === "release") {
            finishClaim(message);
            sendResponse({ ok: true });
          } else {
            sendResponse(claimEpisode(message.manual === true));
          }
        } else if (message?.type === "playback-plus-ping") {
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        } else if (message?.type === "youtube-hide-ping") {
          sendResponse({ ok: true, features: ["crunchyroll-intro"] });
        }
        return false;
      });
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, observerOptions);
    for (const event of ["timeupdate", "seeked", "playing", "loadeddata", "visibilitychange"]) {
      document.addEventListener(event, scheduleScan, true);
    }
    document.addEventListener("click", (event) => {
      const button = event.composedPath().find((node) => node instanceof Element && node.matches("button"));
      if (!autoClicking && isIntroButton(button)) {
        manualSkips += 1;
        requestClaim(true, () => {});
      }
    }, true);
    document.addEventListener("fullscreenchange", positionNotice);
    window.addEventListener("resize", positionNotice);
    window.addEventListener("scroll", positionNotice, true);
    window.addEventListener("popstate", scheduleScan);
    window.setInterval(scheduleScan, 1000);
    scheduleScan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
