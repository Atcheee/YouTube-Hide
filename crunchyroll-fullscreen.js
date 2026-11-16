(() => {
  "use strict";

  const settingsContext = PlaybackPlusSettings;
  if (settingsContext.install && !settingsContext.install("crunchyroll-fullscreen")) return;
  const PLAYER = '#player-container, #player, #vilos, #vilosRoot, [data-testid="vilos-player"], .video-player-wrapper, [data-testid="player"]';
  const CONTROLS = 'button, a, input, textarea, select, [role="button"], [role="slider"], [role="menu"], [role="menuitem"], [role="dialog"], [contenteditable]:not([contenteditable="false"])';
  let enabled = false;
  settingsContext.subscribe(settings => { enabled = settings.extensionEnabled && settings.crunchyrollEnabled; });

  function available(button) {
    if (button.matches(':disabled, [aria-disabled="true"]') || !button.getClientRects().length) return false;
    for (let element = button; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (element.matches('[hidden], [inert]') || style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  window.addEventListener("dblclick", event => {
    if (!enabled || settingsContext.isActive?.() === false || event.defaultPrevented || event.button !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.composedPath().find(node => node instanceof Element);
    if (!target || target.closest(CONTROLS)) return;
    const player = target.closest(PLAYER);
    if (!player || player.closest('[hidden], [inert], [aria-hidden="true"]')) return;
    const video = [...player.querySelectorAll("video")].find(video => {
      const rect = video.getBoundingClientRect();
      return video.getClientRects().length && event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    if (!video) return;
    const fullscreen = document.fullscreenElement;
    if (fullscreen && !fullscreen.contains(video)) return;
    const button = [...player.querySelectorAll('[data-testid="fullscreen-button"], [data-testid="vilos-fullscreen_button"], button[aria-label*="fullscreen" i], button[aria-label*="full screen" i]')].find(available);
    try {
      if (button) button.click();
      else {
        const operation = fullscreen ? document.exitFullscreen?.() : player.requestFullscreen?.();
        if (!operation) return;
        operation.catch?.(() => {});
      }
      // Prevent a native bubbling double-click handler from toggling a second time.
      event.preventDefault();
      event.stopImmediatePropagation();
    } catch { /* Leave native behavior available if this player rejects fullscreen. */ }
  }, true);
})();
