(() => {
  "use strict";

  const settingsContext = PlaybackPlusSettings;
  if (settingsContext.install && !settingsContext.install("crunchyroll-playback-speed")) return;

  const hbo = globalThis.PlaybackPlusHboPlayer;
  const STORAGE_KEY = hbo ? "hbomaxPlaybackSpeed" : "crunchyrollPlaybackSpeed";
  const BUTTON_SELECTOR = hbo ? "#playback-plus-hbo-speed" : '[data-testid="playback-speed-button"], button[aria-label="Playback Speed Menu"]';
  const MIN_RATE = 0.25;
  const MAX_RATE = 4;
  const STEP = 0.05;
  const PRESETS = [1, 1.25, 1.5, 1.75, 2, 3];
  const LOW_BUFFER_SECONDS = 2;
  const RECOVERED_BUFFER_SECONDS = 8;
  const videoStates = new WeakMap();
  const buttonAttributes = new Map();
  const observedRoots = new WeakSet();
  let videos = [];
  let buttons = [];
  let selectedRate = 1;
  let hasPreference = false;
  let selectionRevision = 0;
  let queued = false;
  let observer;
  let panel;
  let slider;
  let output;
  let minus;
  let plus;
  let error;
  let activeButton = null;
  let lastPath = location.pathname;
  let enabled = false;
  const panelResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(positionPanel) : null;

  function normalizeRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) ? Math.round(Math.max(MIN_RATE, Math.min(MAX_RATE, rate)) / STEP) / 20 : 1;
  }

  function formatRate(rate) {
    return `${Number(rate.toFixed(2))}x`;
  }

  function allElements(selector) {
    const roots = [document];
    const found = [];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      found.push(...root.querySelectorAll(selector));
      for (const element of root.querySelectorAll("*")) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        if (!observedRoots.has(element.shadowRoot)) {
          observer.observe(element.shadowRoot, { childList: true, subtree: true, characterData: true });
          observedRoots.add(element.shadowRoot);
        }
      }
    }
    return found;
  }

  function setAttribute(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function primaryVideo() {
    const player = activeButton?.closest("#player-container, #player, .video-player-wrapper");
    return player?.querySelector("video") || videos.find((video) => !video.paused) || videos[0];
  }

  function displayedRate(video = primaryVideo()) {
    if (hbo && videoStates.get(video)?.bufferLimited) return selectedRate;
    return video?.playbackRate || selectedRate;
  }

  function hboTargetRate(video, state) {
    if (selectedRate <= 1) state.bufferLimited = false;
    if (selectedRate > 1 && !video.paused && !video.seeking && !video.ended && video.readyState >= 2) {
      const position = video.currentTime;
      const ranges = video.buffered;
      let bufferedEnd = position;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= position && position <= ranges.end(i)) {
          bufferedEnd = ranges.end(i);
          break;
        }
      }
      const bufferedToEnd = Number.isFinite(video.duration) && bufferedEnd >= video.duration - 0.1;
      const threshold = state.bufferLimited ? RECOVERED_BUFFER_SECONDS : LOW_BUFFER_SECONDS;
      state.bufferLimited = !bufferedToEnd && bufferedEnd - position < threshold * selectedRate;
    }
    return state.bufferLimited ? 1 : selectedRate;
  }

  function showError(message = "") {
    if (!error) return;
    if (error.textContent !== message) error.textContent = message;
    if (error.hidden !== !message) error.hidden = !message;
  }

  function applyRate(video) {
    if (settingsContext.isActive?.() === false) return;
    if (!enabled || !hasPreference) return;
    if (hbo && (!video.isConnected || !videos.includes(video) || location.pathname !== lastPath)) return;
    const state = videoStates.get(video);
    const wasBufferLimited = state.bufferLimited;
    const targetRate = hbo ? hboTargetRate(video, state) : selectedRate;
    if (Math.abs(video.playbackRate - targetRate) < 0.001 && (hbo ||
        Math.abs(video.defaultPlaybackRate - selectedRate) < 0.001)) return;
    if (state.blocked) return;
    const now = Date.now();
    if (wasBufferLimited !== state.bufferLimited || now - state.lastAttempt > 2000) state.attempts = 0;
    if (state.attempts >= 5) {
      state.blocked = true;
      showError(`Another speed controller keeps restoring ${formatRate(video.playbackRate)}. Disable ${hbo ? "other speed extensions" : "Crunchyroll Speeder or other speed extensions"}, then refresh this tab.`);
      return;
    }
    state.attempts += 1;
    state.lastAttempt = now;
    try {
      // Change the media itself, including rates missing from Crunchyroll's menu.
      if (!hbo) video.defaultPlaybackRate = selectedRate;
      if (Math.abs(video.playbackRate - targetRate) >= 0.001) video.playbackRate = targetRate;
    } catch {
      showError("This player could not apply that playback speed.");
    }
  }

  function render() {
    if (settingsContext.isActive?.() === false) return;
    if (!enabled) return;
    const media = primaryVideo();
    const rate = displayedRate(media);
    const easingSpeed = hbo && videoStates.get(media)?.bufferLimited && media.playbackRate === 1;
    const buttonRate = formatRate(easingSpeed ? media.playbackRate : rate);
    for (const button of buttons) {
      if (!buttonAttributes.has(button)) {
        buttonAttributes.set(button, Object.fromEntries(["aria-haspopup", "aria-expanded", "aria-controls"]
          .map((name) => [name, button.getAttribute(name)])));
      }
      if (button.textContent !== buttonRate) button.textContent = buttonRate;
      if (hbo) setAttribute(button, "title", easingSpeed
        ? `Playing at 1x while buffering. Will resume at ${formatRate(rate)}.` : "Playback speed");
      setAttribute(button, "aria-haspopup", "dialog");
      setAttribute(button, "aria-expanded", String(activeButton === button && panel && !panel.hidden));
      setAttribute(button, "aria-controls", "youtube-hide-crunchyroll-speed");
    }
    if (!panel) return;
    slider.value = String(normalizeRate(rate));
    setAttribute(slider, "aria-valuetext", `${Number(rate.toFixed(2))} times normal speed`);
    const speedText = easingSpeed ? `${formatRate(rate)} selected · 1x while buffering` : formatRate(rate);
    if (output.textContent !== speedText) output.textContent = speedText;
    minus.disabled = rate <= MIN_RATE;
    plus.disabled = rate >= MAX_RATE;
    for (const preset of panel.querySelectorAll("[data-speed]")) {
      setAttribute(preset, "aria-pressed", String(Math.abs(Number(preset.dataset.speed) - rate) < 0.001));
    }
  }

  function chooseRate(value, persist = true) {
    if (settingsContext.isActive?.() === false) return;
    if (!enabled) return;
    selectedRate = normalizeRate(value);
    hasPreference = true;
    selectionRevision += 1;
    showError();
    for (const video of videos) {
      videoStates.get(video).attempts = 0;
      videoStates.get(video).blocked = false;
      applyRate(video);
    }
    if (!videos.length) showError("Waiting for the video player…");
    render();
    if (persist) chrome.storage.local.set({ [STORAGE_KEY]: selectedRate });
  }

  function closePanel(returnFocus = false) {
    panelResizeObserver?.disconnect();
    if (!panel || panel.hidden) return;
    const opener = activeButton;
    if (hbo && panel.hidePopover && panel.matches(":popover-open")) panel.hidePopover();
    panel.hidden = true;
    activeButton = null;
    render();
    if (returnFocus && opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function positionPanel() {
    if (settingsContext.isActive?.() === false) return;
    if (!activeButton || !panel || panel.hidden) return;
    if (!activeButton.isConnected) { closePanel(); return; }
    const host = document.fullscreenElement || document.body;
    if (panel.parentElement !== host) host.appendChild(panel);
    if (hbo && panel.showPopover && !panel.matches(":popover-open")) panel.showPopover();
    const anchor = activeButton.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const width = bounds.width || Math.min(390, window.innerWidth - 24);
    const height = bounds.height || 240;
    const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(anchor.top - height - 12, window.innerHeight - height - 12));
    if (panel.style.left !== `${left}px`) panel.style.left = `${left}px`;
    if (panel.style.top !== `${top}px`) panel.style.top = `${top}px`;
  }

  function handlePanelKey(key, target) {
    if (key === "Escape") { closePanel(true); return true; }
    if (target !== slider) return false;
    const rates = { ArrowLeft: displayedRate() - STEP, ArrowDown: displayedRate() - STEP,
      ArrowRight: displayedRate() + STEP, ArrowUp: displayedRate() + STEP,
      Home: MIN_RATE, End: MAX_RATE };
    if (!Object.hasOwn(rates, key)) return false;
    chooseRate(rates[key]);
    return true;
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "youtube-hide-crunchyroll-speed";
    panel.className = "youtube-hide-speed-panel";
    panel.hidden = true;
    if (hbo && panel.showPopover) panel.setAttribute("popover", "manual");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Playback speed");
    panel.innerHTML = `
      <div class="youtube-hide-speed-header">
        <button type="button" class="youtube-hide-speed-back" aria-label="Close playback speed">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <path d="m14.5 5.5-6.5 6.5 6.5 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <h2 class="youtube-hide-speed-title">Playback speed</h2>
      </div>
      <div class="youtube-hide-speed-body">
        <output class="youtube-hide-speed-value" aria-live="polite">1x</output>
        <div class="youtube-hide-speed-slider-row">
          <button type="button" class="youtube-hide-speed-adjust" data-adjust="-1" aria-label="Decrease speed by 0.05">−</button>
          <input type="range" min="0.25" max="4" step="0.05" value="1" aria-label="Playback speed" />
          <button type="button" class="youtube-hide-speed-adjust" data-adjust="1" aria-label="Increase speed by 0.05">+</button>
        </div>
        <div class="youtube-hide-speed-presets"></div>
        <p class="youtube-hide-speed-error" role="status" hidden></p>
      </div>`;
    slider = panel.querySelector("input");
    output = panel.querySelector("output");
    minus = panel.querySelector('[data-adjust="-1"]');
    plus = panel.querySelector('[data-adjust="1"]');
    error = panel.querySelector("[role=status]");
    const presets = panel.querySelector(".youtube-hide-speed-presets");
    for (const rate of PRESETS) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.speed = String(rate);
      option.setAttribute("aria-label", rate === 1 ? "Normal speed" : `${rate} times normal speed`);
      option.textContent = Number.isInteger(rate) ? rate.toFixed(1) : String(rate);
      option.addEventListener("click", () => chooseRate(rate));
      presets.appendChild(option);
    }
    panel.querySelector(".youtube-hide-speed-back").addEventListener("click", () => closePanel(true));
    minus.addEventListener("click", () => chooseRate(displayedRate() - STEP));
    plus.addEventListener("click", () => chooseRate(displayedRate() + STEP));
    slider.addEventListener("input", () => chooseRate(slider.value, false));
    slider.addEventListener("change", () => chooseRate(slider.value));
    for (const event of ["click", "pointerdown", "mousedown", "wheel"]) {
      panel.addEventListener(event, (input) => input.stopPropagation());
    }
  }

  function onClick(event) {
    if (settingsContext.isActive?.() === false) return;
    if (!enabled) return;
    const button = event.composedPath().find((node) => node instanceof Element && node.matches(BUTTON_SELECTOR));
    if (!button || button.matches(':disabled, [aria-disabled="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!panel) buildPanel();
    if (activeButton === button && !panel.hidden) { closePanel(); return; }
    activeButton = button;
    panel.hidden = false;
    render();
    positionPanel();
    panelResizeObserver?.disconnect();
    panelResizeObserver?.observe(panel);
    panelResizeObserver?.observe(button);
    const player = button.closest("#player-container, #player, #vilos, .video-player-wrapper");
    if (player) panelResizeObserver?.observe(player);
    slider.focus({ preventScroll: true });
  }

  function scan() {
    if (settingsContext.isActive?.() === false) return;
    queued = false;
    if (!enabled) return;
    for (const button of buttonAttributes.keys()) {
      if (!button.isConnected) buttonAttributes.delete(button);
    }
    if (location.pathname !== lastPath) { lastPath = location.pathname; closePanel(); }
    videos = hbo ? [hbo.video()].filter(Boolean) : allElements("video");
    buttons = hbo ? [...document.querySelectorAll(BUTTON_SELECTOR)] : allElements(BUTTON_SELECTOR);
    for (const video of videos) {
      if (!videoStates.has(video)) {
        const state = { attempts: 0, lastAttempt: 0, blocked: false, bufferLimited: false };
        videoStates.set(video, state);
        const events = ["loadedmetadata", "play", "playing", "ratechange"];
        if (hbo) events.push("timeupdate", "progress", "waiting", "seeked");
        for (const event of events) {
          video.addEventListener(event, () => {
            const previousLimit = state.bufferLimited;
            if (event === "loadedmetadata" || (!hbo && event !== "ratechange")) {
              state.attempts = 0;
              state.blocked = false;
              state.bufferLimited = false;
            }
            applyRate(video);
            if ((event !== "timeupdate" && event !== "progress") || previousLimit !== state.bufferLimited) render();
          });
        }
      }
      applyRate(video);
    }
    render();
    positionPanel();
  }

  function scheduleScan() {
    if (settingsContext.isActive?.() === false) return;
    if (queued) return;
    queued = true;
    queueMicrotask(scan);
  }

  function init() {
    observer = new MutationObserver(scheduleScan);
    PlaybackPlusSettings.subscribe((settings) => {
      const next = settings.extensionEnabled && (hbo ? settings.hbomaxEnabled && settings.hbomaxSpeedEnabled : settings.crunchyrollEnabled && settings.crunchyrollSpeedEnabled);
      if (next === enabled) return;
      enabled = next;
      if (!enabled) {
        closePanel();
        for (const [button, attributes] of buttonAttributes) {
          for (const [name, value] of Object.entries(attributes)) {
            if (value === null) button.removeAttribute(name);
            else button.setAttribute(name, value);
          }
        }
        buttonAttributes.clear();
      } else {
        for (const video of videos) {
          videoStates.get(video).attempts = 0;
          videoStates.get(video).blocked = false;
        }
        scheduleScan();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    if (!hbo) document.addEventListener("click", onClick, true);
    document.addEventListener("pointerdown", (event) => {
      if (panel && !panel.hidden && !event.composedPath().includes(panel) && !event.composedPath().includes(activeButton)) closePanel();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (!panel || panel.hidden || !event.composedPath().includes(panel)) return;
      // Keep player shortcuts from seeking/pausing while the picker has focus.
      event.stopImmediatePropagation();
      if (handlePanelKey(event.key, event.target)) event.preventDefault();
    }, true);
    document.addEventListener("playback-plus-keyboard-request-v4", request => {
      if (settingsContext.isActive?.() === false || !enabled || !panel || panel.hidden || !request.composedPath().includes(panel)) return;
      let key;
      try { ({ key } = JSON.parse(request.detail)); } catch { return; }
      if (typeof key !== "string") return;
      // Acknowledge in the early MAIN-world listener, before native window
      // shortcuts. J/K/L are swallowed here while the speed dialog has focus.
      request.preventDefault();
      handlePanelKey(key, request.composedPath().find(node => node instanceof Element));
    }, true);
    document.addEventListener("fullscreenchange", positionPanel);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    window.addEventListener("popstate", scheduleScan);
    window.setInterval(scheduleScan, 1000);
    const revision = selectionRevision;
    chrome.storage.local.get({ [STORAGE_KEY]: null }, (result) => {
      if (selectionRevision === revision && result[STORAGE_KEY] !== null) {
        selectedRate = normalizeRate(result[STORAGE_KEY]);
        hasPreference = true;
      }
      scheduleScan();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !Object.hasOwn(changes, STORAGE_KEY)) return;
      selectedRate = normalizeRate(changes[STORAGE_KEY].newValue);
      hasPreference = true;
      for (const video of videos) { videoStates.get(video).attempts = 0; videoStates.get(video).blocked = false; }
      scheduleScan();
    });
    scheduleScan();
  }

  // Let the HBO Max speed button handle clicks before the player can consume them.
  if (hbo) window.addEventListener("click", onClick, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
