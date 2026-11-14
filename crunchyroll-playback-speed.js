(() => {
  "use strict";

  const STORAGE_KEY = "crunchyrollPlaybackSpeed";
  const BUTTON_SELECTOR = '[data-testid="playback-speed-button"], button[aria-label="Playback Speed Menu"]';
  const MIN_RATE = 0.25;
  const MAX_RATE = 4;
  const STEP = 0.05;
  const PRESETS = [1, 1.25, 1.5, 1.75, 2, 3];
  const videoStates = new WeakMap();
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

  function displayedRate() {
    return primaryVideo()?.playbackRate || selectedRate;
  }

  function showError(message = "") {
    if (!error) return;
    if (error.textContent !== message) error.textContent = message;
    error.hidden = !message;
  }

  function applyRate(video) {
    if (!hasPreference) return;
    const state = videoStates.get(video);
    if (Math.abs(video.playbackRate - selectedRate) < 0.001 &&
        Math.abs(video.defaultPlaybackRate - selectedRate) < 0.001) return;
    const now = Date.now();
    if (now - state.lastAttempt > 2000) state.attempts = 0;
    if (state.attempts >= 5) {
      showError("The player is overriding playback speed. Choose a speed to try again.");
      return;
    }
    state.attempts += 1;
    state.lastAttempt = now;
    try {
      // Change the media itself, including rates missing from Crunchyroll's menu.
      video.defaultPlaybackRate = selectedRate;
      video.playbackRate = selectedRate;
    } catch {
      showError("This player could not apply that playback speed.");
    }
  }

  function render() {
    const rate = displayedRate();
    for (const button of buttons) {
      if (button.textContent !== formatRate(rate)) button.textContent = formatRate(rate);
      setAttribute(button, "aria-haspopup", "dialog");
      setAttribute(button, "aria-expanded", String(activeButton === button && panel && !panel.hidden));
      setAttribute(button, "aria-controls", "youtube-hide-crunchyroll-speed");
    }
    if (!panel) return;
    slider.value = String(normalizeRate(rate));
    slider.setAttribute("aria-valuetext", `${Number(rate.toFixed(2))} times normal speed`);
    if (output.textContent !== formatRate(rate)) output.textContent = formatRate(rate);
    minus.disabled = rate <= MIN_RATE;
    plus.disabled = rate >= MAX_RATE;
    for (const preset of panel.querySelectorAll("[data-speed]")) {
      preset.setAttribute("aria-pressed", String(Math.abs(Number(preset.dataset.speed) - rate) < 0.001));
    }
  }

  function chooseRate(value, persist = true) {
    selectedRate = normalizeRate(value);
    hasPreference = true;
    selectionRevision += 1;
    showError();
    for (const video of videos) {
      videoStates.get(video).attempts = 0;
      applyRate(video);
    }
    if (!videos.length) showError("Waiting for the video player…");
    render();
    if (persist) chrome.storage.local.set({ [STORAGE_KEY]: selectedRate });
  }

  function closePanel(returnFocus = false) {
    if (!panel || panel.hidden) return;
    const opener = activeButton;
    panel.hidden = true;
    activeButton = null;
    render();
    if (returnFocus && opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function positionPanel() {
    if (!activeButton || !panel || panel.hidden) return;
    if (!activeButton.isConnected) { closePanel(); return; }
    const host = document.fullscreenElement || document.body;
    if (panel.parentElement !== host) host.appendChild(panel);
    const anchor = activeButton.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const width = bounds.width || Math.min(390, window.innerWidth - 24);
    const height = bounds.height || 240;
    const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(anchor.top - height - 12, window.innerHeight - height - 12));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "youtube-hide-crunchyroll-speed";
    panel.className = "youtube-hide-speed-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Playback speed");
    panel.innerHTML = `
      <div class="youtube-hide-speed-header">
        <button type="button" class="youtube-hide-speed-back" aria-label="Close playback speed">‹</button>
        <span>Playback speed</span>
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
    slider.focus({ preventScroll: true });
  }

  function scan() {
    queued = false;
    if (location.pathname !== lastPath) { lastPath = location.pathname; closePanel(); }
    videos = allElements("video");
    buttons = allElements(BUTTON_SELECTOR);
    for (const video of videos) {
      if (!videoStates.has(video)) {
        const state = { attempts: 0, lastAttempt: 0 };
        videoStates.set(video, state);
        for (const event of ["loadedmetadata", "play", "playing", "ratechange"]) {
          video.addEventListener(event, () => {
            if (event !== "ratechange") state.attempts = 0;
            applyRate(video);
            render();
          });
        }
      }
      applyRate(video);
    }
    render();
    positionPanel();
  }

  function scheduleScan() {
    if (queued) return;
    queued = true;
    queueMicrotask(scan);
  }

  function init() {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerdown", (event) => {
      if (panel && !panel.hidden && !event.composedPath().includes(panel) && !event.composedPath().includes(activeButton)) closePanel();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (!panel || panel.hidden || !event.composedPath().includes(panel)) return;
      // Keep player shortcuts from seeking/pausing while the picker has focus.
      event.stopImmediatePropagation();
      if (event.key === "Escape") { event.preventDefault(); closePanel(true); }
      if (event.target === slider) {
        const rates = { ArrowLeft: displayedRate() - STEP, ArrowDown: displayedRate() - STEP,
          ArrowRight: displayedRate() + STEP, ArrowUp: displayedRate() + STEP,
          Home: MIN_RATE, End: MAX_RATE };
        if (Object.hasOwn(rates, event.key)) { event.preventDefault(); chooseRate(rates[event.key]); }
      }
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
      for (const video of videos) videoStates.get(video).attempts = 0;
      scheduleScan();
    });
    scheduleScan();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
