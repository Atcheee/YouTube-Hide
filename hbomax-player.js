(() => {
  "use strict";

  const preferences = PlaybackPlusSettings;
  if (!preferences.install("hbomax-player")) return;

  // Reconnecting after an extension reload can leave controls from the old context in the page.
  document.getElementById("playback-plus-hbo-speed")?.remove();
  document.getElementById("youtube-hide-crunchyroll-speed")?.remove();

  const buttons = 'button, [role="button"]';
  const inputControls = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="menu"], [role="dialog"]';
  const svgNamespace = "http://www.w3.org/2000/svg";
  const introLabel = /^(?:skip intro|hoppa över (?:intro|inledning))$/i;
  const seekControls = new Map();
  const skipped = new Set();
  let settings;
  let speedButton;
  let speedOffset = 0;
  let notice;
  let noticeTimer;
  let queued = false;

  function episode() {
    return location.pathname.match(/\/video\/watch\/([^/]+)/i)?.[1];
  }

  function enabled() {
    return preferences.isActive() && settings?.extensionEnabled && settings.hbomaxEnabled && Boolean(episode());
  }

  function video() {
    if (!enabled()) return null;
    const root = document.fullscreenElement || document;
    const candidates = root instanceof HTMLVideoElement ? [root] : [...root.querySelectorAll("video")];
    const visible = candidates.filter(media =>
      media.getClientRects().length && getComputedStyle(media).visibility === "visible");
    return visible.find(media => !media.paused && !media.ended) || (visible.length === 1 ? visible[0] : null);
  }

  globalThis.PlaybackPlusHboPlayer = { video };

  function seek(media, seconds) {
    if (!media || media.readyState < 1 || !Number.isFinite(media.duration)) return false;
    const position = Math.max(0, Math.min(media.duration, media.currentTime + seconds));
    const ranges = media.seekable;
    for (let i = 0; i < ranges.length; i += 1) {
      if (position < ranges.start(i) || position > ranges.end(i)) continue;
      try { media.currentTime = position; return true; } catch { return false; }
    }
    return false;
  }

  function label(button) {
    return (button.getAttribute("aria-label") || button.title || button.textContent).trim();
  }

  function direction(button) {
    const name = label(button);
    const id = button.getAttribute("data-testid") || button.getAttribute("data-test-id") || "";
    if (/^(?:(?:seek|skip|jump)\s+)?(?:back(?:wards?)?|rewind)\s+(?:by\s+)?10\s*(?:s|seconds?)$|^10\s*(?:s|seconds?)\s*(?:back(?:wards?)?|rewind)$|^rewind$|^(?:spola|hoppa)\s+(?:10\s+sekunder\s+)?bakåt(?:\s+10\s+sekunder)?$/i.test(name) ||
        /^(?:player[-_]?)?(?:rewind|(?:seek|skip|jump)[-_]?(?:backward|back))(?:[-_]?10)?(?:[-_]?button)?$/i.test(id)) return -1;
    if (/^(?:(?:seek|skip|jump)\s+)?(?:forwards?|fast[ -]?forward)\s+(?:by\s+)?10\s*(?:s|seconds?)$|^10\s*(?:s|seconds?)\s*(?:forwards?|fast[ -]?forward)$|^fast[ -]?forward$|^(?:spola|hoppa)\s+(?:10\s+sekunder\s+)?framåt(?:\s+10\s+sekunder)?$/i.test(name) ||
        /^(?:player[-_]?)?(?:fast[-_]?forward|(?:seek|skip|jump)[-_]?forward)(?:[-_]?10)?(?:[-_]?button)?$/i.test(id)) return 1;
    return 0;
  }

  function usable(button) {
    return !button.matches(':disabled, [aria-disabled="true"]') && !button.closest('[hidden], [inert]');
  }

  function replaceSeekGraphic(graphic, sign) {
    if (!graphic) return null;
    const icon = document.createElementNS(svgNamespace, "svg");
    icon.classList.add("playback-plus-hbo-seek");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "100%");
    icon.setAttribute("height", "100%");
    if (graphic.viewBox.baseVal.width > 0) {
      icon.setAttribute("x", graphic.viewBox.baseVal.x);
      icon.setAttribute("y", graphic.viewBox.baseVal.y);
    }
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<path ${sign > 0 ? 'transform="translate(24 0) scale(-1 1)"' : ""}
      d="M5 8a8 8 0 1 1-1 8M5 4v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="12" y="16" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="9" font-weight="600">5</text>`;
    graphic.appendChild(icon);
    return icon;
  }

  function syncSeekControls(media) {
    const root = document.fullscreenElement || document;
    const useFiveSeconds = media?.readyState >= 1 && media.seekable.length && settings?.hbomaxFiveSecondSeekEnabled;
    for (const [button, record] of seekControls) {
      const graphic = button.querySelector("svg");
      if (useFiveSeconds && root.contains(button) && graphic === record.graphic &&
          (!graphic || record.icon.parentElement === graphic) && button.getAttribute("aria-label") === record.applied) continue;
      if (button.getAttribute("aria-label") === record.applied) {
        if (record.original === null) button.removeAttribute("aria-label");
        else button.setAttribute("aria-label", record.original);
      }
      record.icon?.remove();
      seekControls.delete(button);
    }
    if (!useFiveSeconds) return;
    for (const button of root.querySelectorAll(buttons)) {
      if (seekControls.has(button) || !usable(button)) continue;
      const sign = direction(button);
      if (!sign) continue;
      const graphic = button.querySelector("svg");
      const original = button.getAttribute("aria-label");
      const applied = sign < 0 ? "Rewind 5 seconds" : "Forward 5 seconds";
      seekControls.set(button, { sign, original, applied, graphic, icon: replaceSeekGraphic(graphic, sign) });
      button.setAttribute("aria-label", applied);
    }
  }

  function toolbarPlacement(host) {
    for (const button of fullscreenButtons(host)) {
      let item = button;
      for (let depth = 0; depth < 4 && item.parentElement && item.parentElement !== host; depth += 1) {
        const row = item.parentElement;
        const controls = [...row.querySelectorAll(buttons)].filter(control => control !== speedButton);
        const style = getComputedStyle(row);
        const horizontal = style.display.includes("flex") && style.flexDirection.startsWith("row");
        if (controls.length >= 2 && controls.length <= 12 &&
            (row.matches('[role="toolbar"]') || horizontal)) {
          return { row, item, button };
        }
        item = row;
      }
    }
    return null;
  }

  function alignSpeedButton(nativeButton) {
    let offset = 0;
    if (nativeButton) {
      // A toolbar item can include extra space below its icon for a tooltip.
      // Align with the visible icon rather than the wrapper's center.
      const icon = nativeButton.querySelector("svg, img") || nativeButton;
      const anchor = icon.getBoundingClientRect();
      const speed = speedButton.getBoundingClientRect();
      if (anchor.height && speed.height) {
        offset = Math.round(anchor.top + anchor.height / 2 - (speed.top + speed.height / 2 - speedOffset));
      }
    }
    if (offset === speedOffset) return;
    speedOffset = offset;
    speedButton.style.setProperty("--playback-plus-speed-offset", `${offset}px`);
  }

  function fullscreenButtons(host) {
    return [...host.querySelectorAll(buttons)].filter(button => {
      const id = button.getAttribute("data-testid") || button.getAttribute("data-test-id") || "";
      return /full[-_ ]?screen/i.test(id) || /full[- ]?screen|helskärm/i.test(label(button));
    });
  }

  function toggleFullscreen(media) {
    if (!media) return false;
    const fullscreen = document.fullscreenElement;
    const nativeButton = fullscreenButtons(fullscreen || document).find(button =>
      usable(button) && button.getClientRects().length > 0);
    try {
      if (nativeButton) {
        nativeButton.click();
        return true;
      }
      const player = media.closest('#player-container, [data-testid="player"], [data-testid="video-player"]') || media.parentElement;
      const operation = fullscreen ? document.exitFullscreen?.() : player?.requestFullscreen?.();
      if (!operation) return false;
      operation.catch(() => {});
      return true;
    } catch { return false; }
  }

  function clearNotice() {
    clearTimeout(noticeTimer);
    notice?.remove();
    notice = null;
  }

  function skipIntro(media, host) {
    const id = episode();
    if (!media || !settings.hbomaxAutoSkipEnabled || skipped.has(id)) return;
    const button = [...host.querySelectorAll(buttons)].find(button =>
      introLabel.test(label(button)) && usable(button) &&
      !button.closest('[aria-hidden="true"]') && button.getClientRects().length &&
      getComputedStyle(button).visibility === "visible" && Number(getComputedStyle(button).opacity) > 0);
    if (!button) return;
    skipped.add(id);
    button.click();
    if (!settings.showSkipNotice) return;
    clearNotice();
    notice = document.createElement("div");
    notice.className = "playback-plus-hbo-notice";
    notice.setAttribute("role", "status");
    notice.textContent = "Jumped ahead";
    host.appendChild(notice);
    noticeTimer = setTimeout(clearNotice, 2000);
  }

  function update() {
    queued = false;
    if (!preferences.isActive()) return;
    const media = video();
    document.documentElement?.classList.toggle("playback-plus-hbo-no-dimming", Boolean(media && settings.hbomaxRemoveDimmingEnabled));
    const host = document.fullscreenElement || document.body;
    if (media && host && settings.hbomaxSpeedEnabled) {
      if (!speedButton) {
        speedButton = document.createElement("button");
        speedButton.id = "playback-plus-hbo-speed";
        speedButton.type = "button";
        speedButton.textContent = "1x";
        speedButton.setAttribute("aria-label", "Playback speed");
      }
      const placement = toolbarPlacement(host);
      speedButton.classList.toggle("playback-plus-hbo-toolbar-speed", Boolean(placement));
      if (placement) {
        const { row, item } = placement;
        if (speedButton.parentElement !== row || speedButton.nextElementSibling !== item) row.insertBefore(speedButton, item);
      } else if (speedButton.parentElement !== host) host.appendChild(speedButton);
      alignSpeedButton(placement?.button);
    } else speedButton?.remove();
    syncSeekControls(media);
    if (notice && (!media || !settings.showSkipNotice || !settings.hbomaxAutoSkipEnabled)) clearNotice();
    else if (notice && notice.parentElement !== host) host.appendChild(notice);
    if (host) skipIntro(media, host);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(update);
  }

  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  window.addEventListener("click", event => {
    if (!enabled() || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const button = event.composedPath().find(node => node instanceof Element && node.matches(buttons));
    if (!button || !usable(button)) return;
    if (introLabel.test(label(button))) skipped.add(episode());
    if (!settings.hbomaxFiveSecondSeekEnabled) return;
    const sign = seekControls.get(button)?.sign || direction(button);
    if (sign && seek(video(), sign * 5)) consume(event);
  }, true);

  window.addEventListener("dblclick", event => {
    if (!enabled() || event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.composedPath().find(node => node instanceof Element);
    if (!target || target.closest(`${buttons}, a, [role="toolbar"], ${inputControls}`)) return;
    const media = video();
    if (!media) return;
    const bounds = media.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) return;
    if (toggleFullscreen(media)) consume(event);
  }, true);

  window.addEventListener("keydown", event => {
    if (!enabled() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    const target = event.composedPath().find(node => node instanceof Element);
    if (target?.closest(inputControls)) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      if (!event.repeat && toggleFullscreen(video())) consume(event);
      return;
    }
    const arrow = key === "arrowleft" || key === "arrowright";
    if (arrow ? !settings.hbomaxFiveSecondSeekEnabled : !settings.hbomaxKeyboardShortcutsEnabled || !/^[jkl]$/.test(key)) return;
    const media = video();
    if (!media || media.readyState < 1) return;
    if (key === "k") {
      if (!event.repeat) {
        if (media.paused || media.ended) media.play().catch(() => {});
        else media.pause();
      }
      consume(event);
    } else if (seek(media, (key === "j" || key === "arrowleft" ? -1 : 1) * (arrow ? 5 : 10))) consume(event);
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (preferences.isActive() && sender.id === chrome.runtime.id && message?.type === "playback-plus-ping") {
      respond({ version: chrome.runtime.getManifest().version });
    }
  });
  preferences.subscribe(value => { settings = value; schedule(); });
  new MutationObserver(schedule).observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["aria-label", "aria-hidden", "hidden", "class", "style"] });
  for (const event of ["fullscreenchange", "loadedmetadata", "progress", "playing", "emptied"]) {
    document.addEventListener(event, schedule, true);
  }
  window.addEventListener("popstate", schedule);
  window.addEventListener("resize", schedule);
})();
