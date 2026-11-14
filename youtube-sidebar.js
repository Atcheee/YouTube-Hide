(() => {
  "use strict";

  const settingsContext = PlaybackPlusSettings;
  if (settingsContext.install && !settingsContext.install("youtube-sidebar")) return;

  const ROOTS = "ytd-mini-guide-renderer, ytd-guide-renderer";
  const ENTRIES = "ytd-mini-guide-entry-renderer, ytd-guide-entry-renderer, yt-guide-entry-view-model";
  const HIDDEN = "playback-plus-sidebar-hidden";
  const SHORTCUT = "playback-plus-watch-later";
  let enabled = false;
  let hideShorts = false;
  let moveWatchLater = false;
  let queued = false;

  function destination(link) {
    try {
      const url = new URL(link.getAttribute("href"), location.href);
      return url.origin === location.origin ? url : null;
    } catch { return null; }
  }

  function setHidden(entry, hidden) {
    if (entry.classList.contains(HIDDEN) !== hidden) entry.classList.toggle(HIDDEN, hidden);
  }

  function createShortcut(compact, label) {
    // A plain link avoids cloning Polymer elements and their private renderer data.
    const link = document.createElement("a");
    link.className = SHORTCUT;
    link.classList.toggle("playback-plus-watch-later-compact", compact);
    link.href = "/playlist?list=WL";
    link.title = label;
    link.setAttribute("aria-label", label);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-1 2v7h6v-2h-4V6Z");
    svg.appendChild(path);
    const text = document.createElement("span");
    text.textContent = label;
    link.append(svg, text);
    return link;
  }

  function updateSidebar() {
    if (settingsContext.isActive?.() === false) return;
    queued = false;
    const entries = [...document.querySelectorAll(ENTRIES)];
    const watchLater = entries.filter(entry => [...entry.querySelectorAll("a[href]")].some(link =>
      destination(link)?.pathname === "/playlist" && destination(link)?.searchParams.get("list") === "WL"));
    const sourceLink = watchLater[0]?.querySelector("a[href]");
    const label = sourceLink?.getAttribute("title") || sourceLink?.getAttribute("aria-label") ||
      watchLater[0]?.querySelector(".title, yt-formatted-string")?.textContent.trim() || "Watch later";
    let hasShortcut = false;

    for (const root of document.querySelectorAll(ROOTS)) {
      const subscription = [...root.querySelectorAll("a[href]")].find(link => destination(link)?.pathname === "/feed/subscriptions");
      const entry = subscription?.closest(ENTRIES);
      let shortcut = root.querySelector(`.${SHORTCUT}`);
      if (!enabled || !moveWatchLater || !entry) {
        shortcut?.remove();
        continue;
      }
      if (!shortcut) shortcut = createShortcut(root.matches("ytd-mini-guide-renderer"), label);
      if (entry.nextElementSibling !== shortcut) entry.after(shortcut);
      if (shortcut.title !== label) {
        shortcut.title = label;
        shortcut.setAttribute("aria-label", label);
        shortcut.querySelector("span").textContent = label;
      }
      if (location.pathname === "/playlist" && new URL(location.href).searchParams.get("list") === "WL") {
        if (shortcut.getAttribute("aria-current") !== "page") shortcut.setAttribute("aria-current", "page");
      } else shortcut.removeAttribute("aria-current");
      hasShortcut = true;
    }

    for (const entry of entries) {
      const shorts = entry.closest(ROOTS) && [...entry.querySelectorAll("a[href]")].some(link =>
        /^\/shorts(?:\/|$)/.test(destination(link)?.pathname || ""));
      setHidden(entry, Boolean(enabled && ((hideShorts && shorts) || (hasShortcut && watchLater.includes(entry)))));
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(updateSidebar);
  }

  function init() {
    PlaybackPlusSettings.subscribe(settings => {
      enabled = settings.extensionEnabled && settings.youtubeEnabled;
      hideShorts = settings.hideShortsEnabled;
      moveWatchLater = settings.youtubeWatchLaterShortcutEnabled;
      schedule();
    });
    new MutationObserver(mutations => {
      if (mutations.some(mutation => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return target?.closest(`${ROOTS}, ${ENTRIES}`) || [...mutation.addedNodes].some(node =>
          node instanceof Element && (node.matches(`${ROOTS}, ${ENTRIES}`) || node.querySelector(`${ROOTS}, ${ENTRIES}`)));
      })) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["href", "title", "aria-label"] });
    document.addEventListener("yt-navigate-finish", schedule);
    window.addEventListener("popstate", schedule);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
