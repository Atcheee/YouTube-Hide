(() => {
  "use strict";

  const settingsContext = PlaybackPlusSettings;
  if (settingsContext.install && !settingsContext.install("crunchyroll-seek")) return;
  const BUTTONS = 'button, [role="button"]';
  const PLAYER = '#player-container, #player, #vilos, .video-player-wrapper, [data-testid="player"]';
  const CLASS = "playback-plus-five-second-seek";
  const BADGE = "playback-plus-seek-icon";
  const originals = new Map();
  let enabled = false;
  let fiveSecondSeek = false;
  let keyboardShortcuts = false;
  let queued = false;

  function active() { return enabled && settingsContext.isActive?.() !== false; }

  function direction(button) {
    const labels = [button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean);
    for (const label of labels) {
      if (/^(?:(?:jump|seek|skip)\s+)?(?:back(?:ward|wards)?|rewind)(?:\s+(?:5|10)\s*(?:s|sec(?:onds?)?))?$/i.test(label.trim())) return -1;
      if (/^(?:(?:jump|seek|skip)\s+)?(?:forward(?:s)?|fast[ -]?forward)(?:\s+(?:5|10)\s*(?:s|sec(?:onds?)?))?$/i.test(label.trim())) return 1;
    }
    const testId = button.getAttribute("data-testid") || "";
    if (/^(?:skip-backward|seek-backward|rewind|backward)-button$/.test(testId)) return -1;
    if (/^(?:skip-forward|seek-forward|fast-forward|forward)-button$/.test(testId)) return 1;
    return 0;
  }

  function restore(button, record) {
    for (const name of ["aria-label", "title"]) {
      if (button.getAttribute(name) !== record.applied[name]) continue;
      if (record.original[name] === null) button.removeAttribute(name);
      else button.setAttribute(name, record.original[name]);
    }
    button.classList.remove(CLASS);
    button.querySelector(`.${BADGE}`)?.remove();
    originals.delete(button);
  }

  function updateButtons() {
    queued = false;
    if (settingsContext.isActive?.() === false) return;
    for (const [button, record] of originals) {
      if (!active() || !fiveSecondSeek || !button.isConnected || !direction(button)) restore(button, record);
    }
    if (!active() || !fiveSecondSeek) return;
    for (const button of document.querySelectorAll(BUTTONS)) {
      const sign = direction(button);
      if (!sign || !findVideo(button)) continue;
      let record = originals.get(button);
      if (!record) {
        record = { original: {}, applied: {} };
        originals.set(button, record);
      }
      const label = sign < 0 ? "Rewind 5 seconds" : "Forward 5 seconds";
      for (const name of ["aria-label", "title"]) {
        const current = button.getAttribute(name);
        if (current !== record.applied[name]) record.original[name] = current;
        record.applied[name] = label;
        if (current !== label) button.setAttribute(name, label);
      }
      if (!button.classList.contains(CLASS)) button.classList.add(CLASS);
      if (!button.querySelector(`.${BADGE}`)) {
        const icon = document.createElement("span");
        icon.className = BADGE;
        icon.setAttribute("aria-hidden", "true");
        // Preserve the native icon nodes so React can continue to manage them.
        icon.innerHTML = `<svg viewBox="0 0 24 24"><g ${sign > 0 ? 'transform="translate(24 0) scale(-1 1)"' : ""}><path d="M5 7a8 8 0 1 1-1 9M5 3v5h5"/></g><text x="12" y="16">5</text></svg>`;
        button.appendChild(icon);
      }
    }
  }

  function schedule() {
    if (queued || settingsContext.isActive?.() === false) return;
    queued = true;
    queueMicrotask(updateButtons);
  }

  function findVideo(target) {
    const player = target instanceof Element ? target.closest(PLAYER) : null;
    const candidates = [...(player || document).querySelectorAll("video")];
    // Avoid changing an unrelated preview when several videos share a document.
    const visible = candidates.filter(video => video.getClientRects().length > 0);
    return visible.find(video => !video.paused && !video.ended) || (visible.length === 1 ? visible[0] : null);
  }

  function seek(video, sign, seconds = 5) {
    if (!video || video.readyState < 1 || !Number.isFinite(video.currentTime)) return false;
    const requested = video.currentTime + sign * seconds;
    const ranges = [];
    for (let i = 0; i < video.seekable.length; i++) ranges.push([video.seekable.start(i), video.seekable.end(i)]);
    if (!ranges.length && Number.isFinite(video.duration) && video.duration > 0) ranges.push([0, video.duration]);
    if (!ranges.length) return false;
    const positions = ranges.map(([start, end]) => Math.max(start, Math.min(end, requested)));
    const position = positions.reduce((best, next) => Math.abs(next - requested) < Math.abs(best - requested) ? next : best);
    try { video.currentTime = position; return true; } catch { return false; }
  }

  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function init() {
    settingsContext.subscribe(settings => {
      enabled = settings.extensionEnabled && settings.crunchyrollEnabled;
      fiveSecondSeek = settings.crunchyrollFiveSecondSeekEnabled;
      keyboardShortcuts = settings.crunchyrollKeyboardShortcutsEnabled;
      schedule();
    });
    new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true,
      attributes: true, attributeFilter: ["aria-label", "title", "data-testid"] });
    window.addEventListener("click", event => {
      if (!active() || !fiveSecondSeek || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const button = event.composedPath().find(node => node instanceof Element && node.matches(BUTTONS));
      if (!button || button.matches(':disabled, [aria-disabled="true"]') || button.closest("[inert], [hidden]")) return;
      const sign = direction(button);
      if (sign && seek(findVideo(button), sign)) consume(event);
    }, true);
    window.addEventListener("keydown", event => {
      if (!active() || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
      if (arrow ? !fiveSecondSeek : !keyboardShortcuts || !/^[jkl]$/i.test(event.key)) return;
      const target = event.composedPath().find(node => node instanceof Element);
      if (!target || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="menu"], [role="dialog"]')) return;
      const control = target.closest('a, button, [role="button"]');
      if (control && !direction(control) && event.key.startsWith("Arrow")) return;
      if (target !== document.body && target !== document.documentElement && !target.closest(PLAYER)) return;
      const video = findVideo(target);
      if ((event.key === "k" || event.key === "K") && video?.readyState >= 1) {
        try {
          if (video.paused || video.ended) video.play()?.catch(() => {});
          else video.pause();
          consume(event);
        } catch { /* Leave the native shortcut available if the player rejects it. */ }
        return;
      }
      const sign = { ArrowLeft: -1, ArrowRight: 1, j: -1, J: -1, l: 1, L: 1 }[event.key];
      const seconds = event.key.startsWith("Arrow") ? 5 : 10;
      if (sign && seek(video, sign, seconds)) consume(event);
    }, true);
    for (const event of ["loadedmetadata", "playing"]) document.addEventListener(event, schedule, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
