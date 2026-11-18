(() => {
  "use strict";

  const preferences = PlaybackPlusSettings;
  if (!preferences.install("streaming-player")) return;
  const disney = globalThis.PlaybackPlusDisneyStyles;
  const site = disney ? "disneyplus" : "hbomax";
  const speedId = disney ? "playback-plus-disney-speed" : "playback-plus-hbo-speed";
  const rootOptions = { subtree: true, childList: true, attributes: true,
    attributeFilter: ["aria-label", "aria-hidden", "hidden", "class", "style"] };

  // Reconnecting after an extension reload can leave controls from the old context in the page.
  document.getElementById(speedId)?.remove();
  document.getElementById("youtube-hide-crunchyroll-speed")?.remove();

  const buttons = 'button, [role="button"]';
  const inputControls = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="menu"], [role="dialog"]';
  const svgNamespace = "http://www.w3.org/2000/svg";
  const introLabel = /^(?:skip (?:intro|introduction)|hoppa över (?:intro(?:t)?|inledning(?:en)?))$/i;
  const disneyIntro = '[data-testid="skip-intro-button"], [data-testid="skip-intro"]';
  const disneyToolbar = '.controls__right, .controls__footer [role="toolbar"], [data-testid="player-controls-right"], [data-testid="right-controls"]';
  const disneyPlayer = '#hudson-wrapper, #web-player, disney-web-player, .btm-media-player, [data-testid="video-player"], [data-testid="disney-web-player-wrapper"]';
  const timelineControls = '.progress-bar, .seek-bar, .timeline, .controls__progress, [data-testid*="seek" i], [data-testid*="progress" i], [data-testid*="timeline" i], [data-testid*="scrub" i]';
  const sliderControls = 'input[type="range"], [role="slider"]';
  const seekControls = new Map();
  const skipped = new Set();
  const ownedKeys = new Set();
  const dimmedLayers = new Map();
  let settings;
  let speedButton;
  let speedButtonHandler;
  let nativeSeekButton;
  let speedOffset = 0;
  let notice;
  let noticeTimer;
  let queued = false;
  let shadowRoots = [];
  let shadowTreeChanged = true;
  let lastDisneyPath;
  let lastDimmingCheck = -Infinity;
  const observedRoots = new WeakSet();
  const observer = new MutationObserver(records => {
    if (disney && records.some(record => record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element))) {
      shadowTreeChanged = true;
    }
    schedule();
  });

  function option(name) {
    return settings?.[site + name];
  }

  function episode() {
    return location.pathname.match(disney ? /\/(?:play|watch|video)\/([^/]+)/i : /\/video\/watch\/([^/]+)/i)?.[1];
  }

  function enabled() {
    return preferences.isActive() && settings?.extensionEnabled && option("Enabled") && Boolean(episode());
  }

  function composedContains(root, node) {
    for (let current = node; current; current = current.getRootNode().host) {
      if (root.contains(current)) return true;
    }
    return false;
  }

  function shadowFor(element) {
    return element.shadowRoot || (disney && element instanceof HTMLElement && !(element instanceof HTMLMediaElement)
      ? chrome.dom?.openOrClosedShadowRoot(element) : null);
  }

  function eventPath(event) {
    const path = event.composedPath();
    if (!disney || (event instanceof MouseEvent && !event.isTrusted)) return path;
    const outer = path.find(node => node instanceof Element);
    let target = outer;
    for (let root = target && shadowFor(target); root; root = shadowFor(target)) {
      const inner = event instanceof MouseEvent && (event.detail > 0 || event.type.startsWith("pointer"))
        ? root.elementFromPoint(event.clientX, event.clientY) : root.activeElement;
      if (!inner || inner === target || !composedContains(root, inner)) break;
      target = inner;
    }
    const inside = [];
    for (let node = target; node && node !== outer; node = node.parentElement || node.getRootNode().host) inside.push(node);
    return [...inside, ...path];
  }

  function findAll(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    for (const shadow of shadowRoots) {
      if (shadow.host.isConnected && composedContains(root, shadow.host)) found.push(...shadow.querySelectorAll(selector));
    }
    return found;
  }

  function setSheet(root, sheet, applied) {
    const sheets = root.adoptedStyleSheets;
    if (sheets.includes(sheet) !== applied) {
      root.adoptedStyleSheets = applied ? [...sheets, sheet] : sheets.filter(item => item !== sheet);
    }
  }

  function discoverShadows() {
    if (!disney || (!shadowTreeChanged && lastDisneyPath === location.pathname)) return;
    shadowTreeChanged = false;
    lastDisneyPath = location.pathname;
    const roots = [document];
    const active = enabled();
    if (active) {
      for (const root of roots) {
        for (const element of root.querySelectorAll("*")) {
          const shadow = shadowFor(element);
          if (!shadow) continue;
          roots.push(shadow);
          if (observedRoots.has(shadow)) continue;
          shadow.querySelector(`#${speedId}`)?.remove();
          observer.observe(shadow, rootOptions);
          for (const event of ["loadedmetadata", "playing", "emptied"]) shadow.addEventListener(event, schedule, true);
          observedRoots.add(shadow);
        }
      }
    }
    const current = new Set(roots);
    for (const root of [document, ...new Set([...shadowRoots, ...roots.slice(1)])]) {
      setSheet(root, disney.controls, current.has(root));
      setSheet(root, disney.dimming, current.has(root) && active && option("RemoveDimmingEnabled"));
    }
    shadowRoots = roots.slice(1);
  }

  function fullscreenElement() {
    let element = document.fullscreenElement;
    for (let inner = element && shadowFor(element)?.fullscreenElement; inner && inner !== element;
      inner = shadowFor(element)?.fullscreenElement) element = inner;
    return element;
  }

  function video() {
    if (!enabled()) return null;
    const root = fullscreenElement() || document;
    const candidates = root instanceof HTMLVideoElement ? [root] : findAll(root, "video");
    const visible = candidates.filter(media =>
      media.getClientRects().length && getComputedStyle(media).visibility === "visible");
    return visible.filter(media => !disney || (media.clientWidth >= 100 && media.clientHeight >= 56))
      .sort((first, second) => (disney ? Number(second.readyState > 0) - Number(first.readyState > 0) : 0) ||
        second.clientWidth * second.clientHeight - first.clientWidth * first.clientHeight ||
        Number(first.paused || first.ended) - Number(second.paused || second.ended) || second.readyState - first.readyState)[0] || null;
  }

  globalThis.PlaybackPlusStreamingPlayer = {
    video, site, speedId, eventPath, speedButton: () => speedButton,
    setSpeedButtonHandler(handler) { speedButtonHandler = handler; }
  };

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

  function seekDisneyPlayer(media, seconds) {
    const hosts = findAll(document, "disney-web-player, hive-video");
    const host = hosts.find(candidate => media && composedContains(candidate, media)) ||
      hosts.find(candidate => candidate.localName === "disney-web-player" && candidate.getClientRects().length) ||
      (hosts.length === 1 ? hosts[0] : null);
    const target = media && host && composedContains(host, media) ? media : host;
    return Boolean(target && !target.dispatchEvent(new CustomEvent("playback-plus-disney-seek", {
      detail: seconds * 1000, bubbles: true, composed: true, cancelable: true
    })));
  }

  function label(button) {
    return (button.getAttribute("aria-label") || button.title || button.getAttribute("data-tooltip") || button.textContent).trim();
  }

  function direction(button) {
    const name = label(button);
    const id = button.getAttribute("data-testid") || button.getAttribute("data-test-id") || "";
    if (disney) {
      const icon = button.querySelector("use");
      const iconId = (icon?.getAttribute("href") || icon?.getAttribute("xlink:href"))?.split("#").pop();
      const keys = [id, button.id, button.getAttribute("data-automation-id"), iconId, ...button.classList]
        .filter(Boolean).map(value => value.replace(/([a-z])([A-Z])/g, "$1-$2"));
      if (keys.some(key => /^(?:(?:player|control-icon-btn)[-_]+)?(?:rewind|(?:seek|skip)[-_]?(?:back|backwards?))(?:[-_]?10)?(?:[-_]?(?:button|icon))?$/i.test(key)) ||
          /(?:bakåt|tillbaka)/i.test(name) && /\b10\b/.test(name)) return -1;
      if (keys.some(key => /^(?:(?:player|control-icon-btn)[-_]+)?(?:fast[-_]?forward|(?:seek|skip)[-_]?forward)(?:[-_]?10)?(?:[-_]?(?:button|icon))?$/i.test(key)) ||
          /\bfram(?:åt)?\b/i.test(name) && /\b10\b/.test(name)) return 1;
    }
    if (/^(?:(?:seek|skip|jump)\s+)?(?:back(?:wards?)?|rewind)\s+(?:by\s+)?10\s*(?:s|seconds?)$|^10\s*(?:s|seconds?)\s*(?:back(?:wards?)?|rewind)$|^rewind$|^(?:spola|hoppa)\s+(?:10\s+sekunder\s+)?bakåt(?:\s+10\s+sekunder)?$/i.test(name) ||
        /^(?:player[-_]?)?(?:rewind|(?:seek|skip|jump)[-_]?(?:backward|back))(?:[-_]?10)?(?:[-_]?button)?$/i.test(id)) return -1;
    if (/^(?:(?:seek|skip|jump)\s+)?(?:forwards?|fast[ -]?forward)\s+(?:by\s+)?10\s*(?:s|seconds?)$|^10\s*(?:s|seconds?)\s*(?:forwards?|fast[ -]?forward)$|^fast[ -]?forward$|^(?:spola|hoppa)\s+(?:10\s+sekunder\s+)?framåt(?:\s+10\s+sekunder)?$/i.test(name) ||
        /^(?:player[-_]?)?(?:fast[-_]?forward|(?:seek|skip|jump)[-_]?forward)(?:[-_]?10)?(?:[-_]?button)?$/i.test(id)) return 1;
    return 0;
  }

  function useNativeSeek(sign) {
    const root = fullscreenElement() || document;
    const button = findAll(root, buttons).find(control => usable(control) && control.getClientRects().length &&
      (seekControls.get(control)?.sign || direction(control)) === sign);
    if (!button) return false;
    nativeSeekButton = button;
    try {
      button.click();
      return true;
    } finally {
      nativeSeekButton = null;
    }
  }

  function usable(button) {
    if (button.matches(':disabled, [aria-disabled="true"]')) return false;
    for (let current = button; current; current = current.getRootNode().host) {
      if (current.closest('[hidden], [inert]')) return false;
    }
    return true;
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
    const root = fullscreenElement() || document;
    const useFiveSeconds = media?.readyState >= 1 && media.seekable.length && option("FiveSecondSeekEnabled");
    for (const [button, record] of seekControls) {
      const graphic = button.querySelector("svg");
      if (useFiveSeconds && button.isConnected && composedContains(root, button) && graphic === record.graphic &&
          (!graphic || record.icon?.parentElement === graphic) && button.getAttribute("aria-label") === record.applied) continue;
      if (button.getAttribute("aria-label") === record.applied) {
        if (record.original === null) button.removeAttribute("aria-label");
        else button.setAttribute("aria-label", record.original);
      }
      record.icon?.remove();
      seekControls.delete(button);
    }
    if (!useFiveSeconds) return;
    for (const button of findAll(root, buttons)) {
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

  function toolbarByPosition(host, media) {
    const videoBounds = media.getBoundingClientRect();
    const controls = findAll(host, buttons).filter(button => button !== speedButton && usable(button)).map(button => ({
      button, rect: button.getBoundingClientRect()
    })).filter(({ rect }) => rect.width >= 14 && rect.width <= 96 && rect.height >= 14 && rect.height <= 84 &&
      rect.left >= videoBounds.left + videoBounds.width * 0.66 && rect.right <= innerWidth + 2 &&
      rect.top >= videoBounds.bottom - Math.min(videoBounds.height * 0.25, 145) &&
      rect.top <= Math.min(innerHeight, videoBounds.bottom + 110));
    controls.sort((first, second) => second.rect.right - first.rect.right);
    for (const { button, rect } of controls) {
      const center = rect.top + rect.height / 2;
      const peers = controls.filter(candidate => Math.abs(candidate.rect.top + candidate.rect.height / 2 - center) <= 14);
      for (let item = button; item; item = item.parentElement || item.getRootNode().host) {
        const row = item.parentElement;
        if (!row || row === host || row.getBoundingClientRect().height > 100) continue;
        if (peers.some(peer => composedContains(row, peer.button) && !composedContains(item, peer.button))) {
          return { row, item, button };
        }
      }
    }
    return null;
  }

  function toolbarPlacement(host, media) {
    if (disney) {
      const row = findAll(host, disneyToolbar).find(element => usable(element) && element.clientWidth && element.clientHeight);
      if (row) {
        const button = fullscreenButtons(host).find(control => composedContains(row, control));
        const item = button && [...row.children].find(child => composedContains(child, button));
        return { row, item: item || null, button };
      }
      // Disney+ also puts fullscreen in a standalone web component whose
      // actual button and toolbar are in different shadow roots.
      const fullscreenControl = findAll(host, "toggle-fullscreen").find(element =>
        usable(element) && (element.getClientRects().length || findAll(element, buttons).some(button => button.getClientRects().length)));
      if (fullscreenControl?.parentNode) return { row: fullscreenControl.parentNode, item: fullscreenControl };
    }
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
    return disney && media ? toolbarByPosition(host, media) : null;
  }

  function updateDisneyDimming(media, host) {
    const layers = new Map();
    if (media && host && option("RemoveDimmingEnabled")) {
      const now = performance.now();
      if (now - lastDimmingCheck < 350) return;
      lastDimmingCheck = now;
      let player = null;
      for (let node = media; node; node = node.getRootNode().host) player = node.closest(disneyPlayer) || player;
      const bounds = media.getBoundingClientRect();
      const scope = player || host;
      const darkColor = /rgba\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)/g;
      function hasDarkPaint(style) {
        const colors = (style.backgroundImage + " " + style.backgroundColor).matchAll(darkColor);
        return [...colors].some(([, r, g, b, alpha]) => Math.max(r, g, b) <= 32 && alpha > 0.08 && alpha < 1) ||
          /gradient\(/.test(style.backgroundImage) && /rgb\(0, 0, 0\)/.test(style.backgroundImage) &&
          /rgba\(0, 0, 0, 0\)/.test(style.backgroundImage);
      }
      for (const node of [scope, ...findAll(scope, 'div, section, header, footer, [class*="overlay" i]')]) {
        if (node === document.body || node.closest('button, [role="dialog"], [role="menu"], [class*="caption" i], [class*="subtitle" i]')) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < bounds.width * 0.65 || rect.right <= bounds.left || rect.left >= bounds.right ||
            rect.bottom < bounds.top || rect.top > bounds.bottom || rect.height < 1) continue;
        const old = dimmedLayers.get(node) || "";
        const types = ["background", "before", "after"].filter(type => {
          if (old.split(" ").includes(type)) return true;
          const pseudo = type === "background" ? null : "::" + type;
          const style = getComputedStyle(node, pseudo);
          const decorative = pseudo ? style.content !== "none" && style.content !== "normal" : style.pointerEvents === "none";
          return decorative && hasDarkPaint(style);
        });
        if (types.length) layers.set(node, types.join(" "));
      }
    }
    for (const node of dimmedLayers.keys()) {
      if (!layers.has(node)) node.removeAttribute("data-playback-plus-dim-layer");
    }
    dimmedLayers.clear();
    for (const [node, types] of layers) {
      if (node.getAttribute("data-playback-plus-dim-layer") !== types) node.setAttribute("data-playback-plus-dim-layer", types);
      dimmedLayers.set(node, types);
    }
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
    return findAll(host, buttons).filter(button => {
      const id = button.getAttribute("data-testid") || button.getAttribute("data-test-id") || "";
      return /full[-_ ]?screen/i.test(id) || /full[- ]?screen|helskärm/i.test(label(button)) ||
        Boolean(disney && button.matches(".fullscreen-icon, .fullscreen-button, .control-icon-btn--fullscreen, .view-mode-fullscreen-icon, .view-mode-windowed-icon"));
    });
  }

  function toggleFullscreen(media) {
    if (!media) return false;
    const fullscreen = fullscreenElement();
    const nativeButton = fullscreenButtons(fullscreen || document).find(button =>
      usable(button) && button.getClientRects().length > 0);
    try {
      if (nativeButton) {
        nativeButton.click();
        return true;
      }
      let player = media.parentElement;
      for (let current = media; current; current = current.getRootNode().host) {
        const container = current.closest('#player-container, #web-player, [data-testid="player"], [data-testid="video-player"], .btm-media-player');
        if (container) player = container;
        else if (disney && current !== media) player = current;
      }
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
    if (!media || !option("AutoSkipEnabled") || skipped.has(id)) return;
    const button = findAll(host, buttons).find(button =>
      isIntroButton(button) && usable(button) &&
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

  function isIntroButton(button) {
    return introLabel.test(label(button)) || Boolean(disney && button.matches(disneyIntro));
  }

  function update() {
    queued = false;
    if (!preferences.isActive()) return;
    discoverShadows();
    const media = video();
    if (!disney) document.documentElement?.classList.toggle("playback-plus-hbo-no-dimming", Boolean(media && option("RemoveDimmingEnabled")));
    const host = fullscreenElement() || document.body;
    if (disney) updateDisneyDimming(media, host);
    const speedEnabled = host && enabled() && option("SpeedEnabled");
    const placement = speedEnabled && (media || disney) ? toolbarPlacement(host, media) : null;
    if (speedEnabled && (disney ? placement : media)) {
      if (!speedButton) {
        speedButton = document.createElement("button");
        speedButton.id = speedId;
        speedButton.type = "button";
        speedButton.textContent = disney ? "1×" : "1x";
        speedButton.setAttribute("aria-label", "Playback speed");
        if (disney) speedButton.addEventListener("click", input => speedButtonHandler?.(input, speedButton), true);
      }
      const placement = toolbarPlacement(host, media);
      speedButton.classList.toggle("playback-plus-hbo-toolbar-speed", Boolean(placement));
      if (placement) {
        const { row, item } = placement;
        if (disney && speedButton.slot !== (item?.slot || "")) speedButton.slot = item?.slot || "";
        if (speedButton.parentNode !== row || speedButton.nextElementSibling !== item) row.insertBefore(speedButton, item);
      } else if (speedButton.parentElement !== host) host.appendChild(speedButton);
      if (!disney) alignSpeedButton(placement?.button);
    } else speedButton?.remove();
    syncSeekControls(media);
    if (notice && (!media || !settings.showSkipNotice || !option("AutoSkipEnabled"))) clearNotice();
    else if (notice && notice.parentElement !== host) host.appendChild(notice);
    if (host) skipIntro(media, host);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    if (disney && enabled()) setTimeout(update, 32);
    else queueMicrotask(update);
  }

  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function isTimeline(path) {
    return path.some(node => node.matches(timelineControls) || (node.matches(sliderControls) &&
      (/seek|timeline|progress|scrub|tidslinje|förlopp/i.test(label(node)) ||
        /\d{1,2}:\d{2}/.test(node.getAttribute("aria-valuetext") || ""))));
  }

  function handlePlayerClick(event) {
    if (!enabled() || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const button = eventPath(event).find(node => node instanceof Element && node.matches(buttons));
    if (!button || button === nativeSeekButton || !usable(button)) return;
    if (event.type === "click" && isIntroButton(button)) skipped.add(episode());
    if (!option("FiveSecondSeekEnabled")) return;
    const sign = seekControls.get(button)?.sign || direction(button);
    if (!sign) return;
    const media = video();
    if (event.type === "pointerup") {
      // Some controls seek on pointer release. Leave the generated click for our own handler.
      if (media?.readyState >= 1 && media.seekable.length) event.stopImmediatePropagation();
    } else if (seek(media, sign * 5)) consume(event);
  }
  window.addEventListener("click", handlePlayerClick, true);
  if (disney) window.addEventListener("pointerup", handlePlayerClick, true);

  window.addEventListener("dblclick", event => {
    if (!enabled() || event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (eventPath(event).some(node => node instanceof Element &&
      node.matches(`${buttons}, a, [role="toolbar"], ${inputControls}`))) return;
    const media = video();
    if (!media) return;
    const bounds = media.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) return;
    if (toggleFullscreen(media)) consume(event);
  }, true);

  window.addEventListener("keydown", event => {
    if (!enabled() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    const key = event.key.toLowerCase();
    const arrow = key === "arrowleft" || key === "arrowright";
    const jumpShortcut = key === "j" || key === "l";
    const letterShortcut = jumpShortcut || key === "k";
    if (key !== "f" && !(arrow ? option("FiveSecondSeekEnabled") : letterShortcut && option("KeyboardShortcutsEnabled"))) return;
    const media = video();
    const path = eventPath(event).filter(node => node instanceof Element);
    const timelineShortcut = (arrow || (disney && letterShortcut)) && isTimeline(path);
    if (path.some(node => {
      if (!node.matches(inputControls)) return false;
      if (node.matches(sliderControls) && (timelineShortcut || jumpShortcut)) return false;
      return !(media && node.matches('[role="dialog"]') && composedContains(node, media));
    })) return;
    if (key === "f") {
      if (!event.repeat && toggleFullscreen(media)) consume(event);
      return;
    }
    if (key === "k") {
      if (!media || media.readyState < 1) return;
      if (!event.repeat) {
        if (media.paused || media.ended) media.play().catch(() => {});
        else media.pause();
      }
      consume(event);
    } else {
      const sign = key === "j" || key === "arrowleft" ? -1 : 1;
      const seconds = sign * (arrow ? 5 : 10);
      if ((disney && seekDisneyPlayer(media, seconds)) || seek(media, seconds) || (media && jumpShortcut && useNativeSeek(sign))) {
        ownedKeys.add(key);
        consume(event);
      }
    }
  }, true);
  window.addEventListener("keyup", event => {
    if (ownedKeys.delete(event.key.toLowerCase())) consume(event);
  }, true);
  window.addEventListener("blur", () => ownedKeys.clear());

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (preferences.isActive() && sender.id === chrome.runtime.id && message?.type === "playback-plus-ping") {
      respond({ version: chrome.runtime.getManifest().version });
    }
  });
  preferences.subscribe(value => {
    settings = value;
    shadowTreeChanged = true;
    lastDimmingCheck = -Infinity;
    schedule();
  });
  observer.observe(document, rootOptions);
  function scheduleLayout() {
    lastDimmingCheck = -Infinity;
    schedule();
  }
  for (const event of ["loadedmetadata", "progress", "playing", "emptied"]) {
    document.addEventListener(event, schedule, true);
  }
  document.addEventListener("fullscreenchange", scheduleLayout, true);
  window.addEventListener("popstate", scheduleLayout);
  window.addEventListener("resize", scheduleLayout);
  if (disney) window.setInterval(() => {
    if (!enabled() && lastDisneyPath === location.pathname) return;
    // attachShadow() itself doesn't produce a mutation in its parent.
    shadowTreeChanged = true;
    schedule();
  }, 1000);
})();
