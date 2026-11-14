(() => {
  "use strict";

  const HIDDEN_CLASS = "hide-streamed-days-video";
  // Matches metadata like "Streamed 1 hour ago", "Streamed 3 days ago", etc.
  const STREAMED_AGO_PATTERN =
    /\bStreamed\s+\d[\d,.]*\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i;
  const MIX_BADGE_PATTERN = /^mix$/i;
  const DURATION_BADGE_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  // Music-note glyph used on music-video thumbnail duration badges.
  const MUSIC_NOTE_PATH_PATTERN = /M5\.5 1\.383|a2\.25 2\.25 0 101 1\.871/;
  const CARD_SELECTOR = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-playlist-panel-video-renderer",
    "yt-lockup-view-model",
    "ytm-video-with-context-renderer",
    "ytm-compact-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model"
  ].join(",");
  const SECTION_SELECTOR = [
    "ytd-rich-section-renderer",
    "ytd-reel-shelf-renderer",
    "grid-shelf-view-model"
  ].join(",");

  const pendingCards = new Set();
  const pendingSections = new Set();
  let scanFrame = null;
  let hideStreamedEnabled = false;
  let hideShortsEnabled = false;
  let hideMixEnabled = false;
  let hideMusicEnabled = false;
  let lastPathname = location.pathname;

  function isStreamsPage() {
    const path = location.pathname.replace(/\/+$/, "");
    return path.endsWith("/streams");
  }

  function isLibraryPage() {
    const path = location.pathname.replace(/\/+$/, "");
    return path === "/playlist" || path === "/feed/downloads" || path === "/feed/history";
  }

  function isShortsPage() {
    const path = location.pathname.replace(/\/+$/, "");
    return path === "/shorts" || path.startsWith("/shorts/");
  }

  function shouldHideStreamed() {
    return hideStreamedEnabled && !isStreamsPage() && !isLibraryPage();
  }

  function shouldHideShorts() {
    return hideShortsEnabled && !isShortsPage();
  }

  function shouldHideMix() {
    return hideMixEnabled;
  }

  function shouldHideMusic() {
    return hideMusicEnabled;
  }

  function outermostVideoCard(element) {
    if (!(element instanceof Element)) return null;

    let card = element.closest(CARD_SELECTOR);
    if (!card) return null;

    let parentCard = card.parentElement?.closest(CARD_SELECTOR);
    while (parentCard) {
      card = parentCard;
      parentCard = card.parentElement?.closest(CARD_SELECTOR);
    }

    return card;
  }

  function outermostSection(element) {
    if (!(element instanceof Element)) return null;

    let section = element.closest(SECTION_SELECTOR);
    if (!section) return null;

    let parentSection = section.parentElement?.closest(SECTION_SELECTOR);
    while (parentSection) {
      section = parentSection;
      parentSection = section.parentElement?.closest(SECTION_SELECTOR);
    }

    return section;
  }

  function containsStreamedLabel(card) {
    if (STREAMED_AGO_PATTERN.test(card.textContent || "")) return true;

    const labelledElements = card.querySelectorAll("[aria-label], [title]");
    return Array.from(labelledElements).some((element) => {
      const accessibleText = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`;
      return STREAMED_AGO_PATTERN.test(accessibleText);
    });
  }

  function hasShortsHref(href) {
    return typeof href === "string" && /(?:^|\/)shorts(?:\/|$|\?)/i.test(href);
  }

  function isShortsCard(card) {
    if (
      card.matches(
        "ytd-reel-item-renderer, ytd-shorts-lockup-view-model, ytm-shorts-lockup-view-model"
      )
    ) {
      return true;
    }

    if (card.querySelector("ytd-shorts-lockup-view-model, ytm-shorts-lockup-view-model")) {
      return true;
    }

    const links = card.querySelectorAll("a[href]");
    return Array.from(links).some((link) => hasShortsHref(link.getAttribute("href")));
  }

  function hasMixHref(href) {
    return typeof href === "string" && /[?&]start_radio=1(?:&|$)/i.test(href);
  }

  function isMixCard(card) {
    const badges = card.querySelectorAll(".ytBadgeShapeText, badge-shape");
    if (
      Array.from(badges).some((badge) => MIX_BADGE_PATTERN.test((badge.textContent || "").trim()))
    ) {
      return true;
    }

    const hasCollectionStack = Boolean(
      card.querySelector(
        "yt-collections-stack, yt-collection-thumbnail-view-model, .ytLockupViewModelCollectionStack2"
      )
    );
    if (!hasCollectionStack) return false;

    const links = card.querySelectorAll("a[href]");
    return Array.from(links).some((link) => hasMixHref(link.getAttribute("href")));
  }

  function isMusicVideoCard(card) {
    // Classic cards: thumbnail time overlay marked as music.
    if (card.querySelector('ytd-thumbnail-overlay-time-status-renderer[overlay-style="MUSIC"]')) {
      return true;
    }

    // Lockup cards: music-note SVG on the thumbnail duration badge.
    const thumbnailRoots = card.querySelectorAll(
      "yt-thumbnail-view-model, yt-thumbnail-badge-view-model, .ytThumbnailBottomOverlayViewModelBadge, ytd-thumbnail, ytd-thumbnail-overlay-time-status-renderer, a.ytLockupViewModelContentImage"
    );
    for (const root of thumbnailRoots) {
      const paths = root.querySelectorAll("path");
      if (
        Array.from(paths).some((path) =>
          MUSIC_NOTE_PATH_PATTERN.test(path.getAttribute("d") || "")
        )
      ) {
        return true;
      }
    }

    // Fallback: music icon next to a duration timestamp on the thumbnail badge.
    const badges = card.querySelectorAll(
      "yt-thumbnail-badge-view-model badge-shape, .ytThumbnailBottomOverlayViewModelBadge badge-shape"
    );
    return Array.from(badges).some((badge) => {
      if (!badge.querySelector(".ytBadgeShapeIcon")) return false;
      const text = (badge.querySelector(".ytBadgeShapeText")?.textContent || "").trim();
      return DURATION_BADGE_PATTERN.test(text);
    });
  }

  function sectionTitleText(section) {
    const title = section.querySelector("#title, #title-text #title, #title-container #title");
    return (title?.textContent || "").trim();
  }

  function isShortsSection(section) {
    if (section.matches("ytd-reel-shelf-renderer")) return true;
    if (section.querySelector("ytd-rich-shelf-renderer[is-shorts], [is-shorts]")) return true;
    if (section.querySelector("ytd-reel-shelf-renderer, ytd-shorts-lockup-view-model, ytm-shorts-lockup-view-model")) {
      return true;
    }
    if (/^shorts$/i.test(sectionTitleText(section))) return true;

    const links = section.querySelectorAll("a[href]");
    return Array.from(links).some((link) => hasShortsHref(link.getAttribute("href")));
  }

  function updateCard(card) {
    if (!card.isConnected) return;

    const hide =
      (shouldHideStreamed() && containsStreamedLabel(card)) ||
      (shouldHideShorts() && isShortsCard(card)) ||
      (shouldHideMix() && isMixCard(card)) ||
      (shouldHideMusic() && isMusicVideoCard(card));

    card.classList.toggle(HIDDEN_CLASS, hide);
  }

  function updateSection(section) {
    if (!section.isConnected) return;
    section.classList.toggle(HIDDEN_CLASS, shouldHideShorts() && isShortsSection(section));
  }

  function clearHiddenElements() {
    document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((element) => {
      element.classList.remove(HIDDEN_CLASS);
    });
  }

  function flushPending() {
    scanFrame = null;

    const cards = Array.from(pendingCards);
    pendingCards.clear();
    cards.forEach(updateCard);

    const sections = Array.from(pendingSections);
    pendingSections.clear();
    sections.forEach(updateSection);
  }

  function scheduleCard(card) {
    if (!card) return;
    pendingCards.add(card);

    if (scanFrame === null) {
      scanFrame = window.requestAnimationFrame(flushPending);
    }
  }

  function scheduleSection(section) {
    if (!section) return;
    pendingSections.add(section);

    if (scanFrame === null) {
      scanFrame = window.requestAnimationFrame(flushPending);
    }
  }

  function scanRoot(root) {
    if (root instanceof Element) {
      scheduleCard(outermostVideoCard(root));
      scheduleSection(outermostSection(root));
    }

    if (!(root instanceof Document || root instanceof Element)) return;

    root.querySelectorAll(CARD_SELECTOR).forEach((element) => {
      scheduleCard(outermostVideoCard(element));
    });

    root.querySelectorAll(SECTION_SELECTOR).forEach((element) => {
      scheduleSection(outermostSection(element));
    });
  }

  function handleMutations(mutations) {
    mutations.forEach((mutation) => {
      const targetElement =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      scheduleCard(outermostVideoCard(targetElement));
      scheduleSection(outermostSection(targetElement));

      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) scanRoot(node);
      });
    });
  }

  const observer = new MutationObserver(handleMutations);

  function scanPage() {
    if (
      !shouldHideStreamed() &&
      !shouldHideShorts() &&
      !shouldHideMix() &&
      !shouldHideMusic()
    ) {
      clearHiddenElements();
      pendingCards.clear();
      pendingSections.clear();
      return;
    }

    scanRoot(document);
  }

  function applySettings(nextStreamed, nextShorts, nextMix, nextMusic) {
    hideStreamedEnabled = Boolean(nextStreamed);
    hideShortsEnabled = Boolean(nextShorts);
    hideMixEnabled = Boolean(nextMix);
    hideMusicEnabled = Boolean(nextMusic);
    scanPage();
  }

  function handleNavigation() {
    if (location.pathname === lastPathname) {
      scanPage();
      return;
    }

    lastPathname = location.pathname;
    scanPage();
  }

  function init() {
    PlaybackPlusSettings.subscribe((settings) => {
      const enabled = settings.extensionEnabled && settings.youtubeEnabled;
      applySettings(enabled && settings.hideStreamedEnabled, enabled && settings.hideShortsEnabled,
        enabled && settings.hideMixEnabled, enabled && settings.hideMusicEnabled);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    document.addEventListener("yt-navigate-finish", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "playback-plus-ping") {
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        return false;
      }
      if (message?.type === "youtube-hide-ping") {
        sendResponse({ ok: true, features: ["streamed", "shorts", "mix", "music", "jump-ahead"] });
        return true;
      }
      return false;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
