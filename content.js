(() => {
  "use strict";

  const HIDDEN_CLASS = "hide-streamed-days-video";
  const STREAMED_DAYS_PATTERN = /\bStreamed\s+\d[\d,.]*\s+days?\s+ago\b/i;
  const CARD_SELECTOR = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-playlist-panel-video-renderer",
    "yt-lockup-view-model",
    "ytm-video-with-context-renderer",
    "ytm-compact-video-renderer"
  ].join(",");

  const pendingCards = new Set();
  let scanFrame = null;

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

  function containsStreamedDaysLabel(card) {
    if (STREAMED_DAYS_PATTERN.test(card.textContent || "")) return true;

    const labelledElements = card.querySelectorAll("[aria-label], [title]");
    return Array.from(labelledElements).some((element) => {
      const accessibleText = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`;
      return STREAMED_DAYS_PATTERN.test(accessibleText);
    });
  }

  function updateCard(card) {
    if (!card.isConnected) return;
    card.classList.toggle(HIDDEN_CLASS, containsStreamedDaysLabel(card));
  }

  function flushPendingCards() {
    scanFrame = null;
    const cards = Array.from(pendingCards);
    pendingCards.clear();
    cards.forEach(updateCard);
  }

  function scheduleCard(card) {
    if (!card) return;
    pendingCards.add(card);

    if (scanFrame === null) {
      scanFrame = window.requestAnimationFrame(flushPendingCards);
    }
  }

  function scanRoot(root) {
    if (root instanceof Element) {
      scheduleCard(outermostVideoCard(root));
    }

    if (!(root instanceof Document || root instanceof Element)) return;

    root.querySelectorAll(CARD_SELECTOR).forEach((element) => {
      scheduleCard(outermostVideoCard(element));
    });
  }

  function handleMutations(mutations) {
    mutations.forEach((mutation) => {
      const targetElement =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      scheduleCard(outermostVideoCard(targetElement));

      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) scanRoot(node);
      });
    });
  }

  const observer = new MutationObserver(handleMutations);

  function scanPage() {
    scanRoot(document);
  }

  function init() {
    scanPage();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    document.addEventListener("yt-navigate-finish", scanPage);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
