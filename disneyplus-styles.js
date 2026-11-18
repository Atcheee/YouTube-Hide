(() => {
  "use strict";

  const controls = new CSSStyleSheet();
  controls.replaceSync(`
    #playback-plus-disney-speed.playback-plus-hbo-toolbar-speed {
      position: relative;
      z-index: 1;
      appearance: none;
      pointer-events: auto;
      color: white;
      font: 700 18px/1 system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      user-select: none;
      cursor: pointer;
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      align-self: center;
      box-sizing: border-box;
      min-width: 44px;
      height: 44px;
      margin: 0;
      padding: 0 6px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      translate: 0 var(--playback-plus-speed-offset, 0px);
    }
    #playback-plus-disney-speed:is(:hover, :focus-visible, [aria-expanded="true"]) {
      background: rgb(255 255 255 / 15%);
    }
    #playback-plus-disney-speed:focus-visible { outline: 2px solid white; }

    .playback-plus-hbo-seek { pointer-events: none; }
    svg:has(> .playback-plus-hbo-seek) > :not(.playback-plus-hbo-seek) { visibility: hidden; }
    .playback-plus-hbo-notice {
      position: fixed;
      inset: 50% auto auto 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483646;
      border-radius: 8px;
      background: #14131ce8;
      color: white;
      padding: 12px 20px;
      font: 600 18px/1.4 system-ui, sans-serif;
      pointer-events: none;
    }
  `);

  const dimming = new CSSStyleSheet();
  dimming.replaceSync(`
    :is(.controls__header, .controls__footer)::before,
    :is(.controls__header, .controls__footer)::after,
    :is(.controls__header, .controls__footer),
    .btm-media-overlays-container,
    .btm-media-overlays-container::before,
    .btm-media-overlays-container::after,
    .btm-media-overlays-container :is([class*="scrim" i], [class*="gradient" i], [class*="dimming" i], [class*="vignette" i]),
    :is(#hudson-wrapper, disney-web-player) :is([class*="player-scrim" i], [class*="player-gradient" i], [class*="player-dimming" i]),
    [data-playback-plus-dim-layer~="background"],
    [data-playback-plus-dim-layer~="before"]::before,
    [data-playback-plus-dim-layer~="after"]::after,
    :is(.controls__scrim, .controls__gradient, [data-testid="player-scrim"], [data-testid="controls-gradient"]) {
      background: transparent !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
    }
  `);

  globalThis.PlaybackPlusDisneyStyles = { controls, dimming };
})();
