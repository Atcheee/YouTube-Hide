(() => {
  "use strict";

  const HIDDEN_CLASS = "hide-streamed-days-video";
  const STREAMED_STORAGE_KEY = "hideStreamedEnabled";
  const SHORTS_STORAGE_KEY = "hideShortsEnabled";
  const MIX_STORAGE_KEY = "hideMixEnabled";
  // Matches metadata like "Streamed 1 hour ago", "Streamed 3 days ago", etc.
  const STREAMED_AGO_PATTERN =
    /\bStreamed\s+\d[\d,.]*\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i;
  const MIX_BADGE_PATTERN = /^mix$/i;
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
  let hideStreamedEnabled = true;
  let hideShortsEnabled = true;
  let hideMixEnabled = true;
  let lastPathname = location.pathname;

  function isStreamsPage() {
    const path = location.pathname.replace(/\/+$/, "");
    return path.endsWith("/streams");
  }

  function isShortsPage() {
    const path = location.pathname.replace(/\/+$/, "");
    return path === "/shorts" || path.startsWith("/shorts/");
  }

  function shouldHideStreamed() {
    return hideStreamedEnabled && !isStreamsPage();
  }

  function shouldHideShorts() {
    return hideShortsEnabled && !isShortsPage();
  }

  function shouldHideMix() {
    return hideMixEnabled;
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
      (shouldHideMix() && isMixCard(card));

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
    if (!shouldHideStreamed() && !shouldHideShorts() && !shouldHideMix()) {
      clearHiddenElements();
      pendingCards.clear();
      pendingSections.clear();
      return;
    }

    scanRoot(document);
  }

  function applySettings(nextStreamed, nextShorts, nextMix) {
    hideStreamedEnabled = Boolean(nextStreamed);
    hideShortsEnabled = Boolean(nextShorts);
    hideMixEnabled = Boolean(nextMix);
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
    chrome.storage.sync.get(
      {
        [STREAMED_STORAGE_KEY]: true,
        [SHORTS_STORAGE_KEY]: true,
        [MIX_STORAGE_KEY]: true
      },
      (result) => {
        applySettings(
          result[STREAMED_STORAGE_KEY],
          result[SHORTS_STORAGE_KEY],
          result[MIX_STORAGE_KEY]
        );
      }
    );

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;

      let nextStreamed = hideStreamedEnabled;
      let nextShorts = hideShortsEnabled;
      let nextMix = hideMixEnabled;
      let changed = false;

      if (Object.hasOwn(changes, STREAMED_STORAGE_KEY)) {
        nextStreamed = changes[STREAMED_STORAGE_KEY].newValue !== false;
        changed = true;
      }

      if (Object.hasOwn(changes, SHORTS_STORAGE_KEY)) {
        nextShorts = changes[SHORTS_STORAGE_KEY].newValue !== false;
        changed = true;
      }

      if (Object.hasOwn(changes, MIX_STORAGE_KEY)) {
        nextMix = changes[MIX_STORAGE_KEY].newValue !== false;
        changed = true;
      }

      if (changed) applySettings(nextStreamed, nextShorts, nextMix);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    document.addEventListener("yt-navigate-finish", handleNavigation);
    window.addEventListener("popstate", handleNavigation);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
