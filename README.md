# Playback Plus

Player tools for **YouTube and Crunchyroll**, in one Manifest V3 extension for Brave
and Chrome. Previously called YouTube Hide; updating keeps your existing settings.

## Popup settings

- Master switch pauses all tools without discarding preferences. Each site also has
  its own enable switch. Changes apply to already-open supported tabs and player frames.
- **YouTube:** toggle Jump ahead auto-skipping and the four feed filters separately.
- **Crunchyroll:** toggle intro auto-skipping and the in-player speed picker separately.
  Change saved speed directly in the popup with a 0.25x–4x slider and common presets;
  it shares the same local preference as the in-player picker. Turning the picker off
  releases speed enforcement and restores native button behavior, keeping the current rate.
- **Both sites:** turn the centered skip notice on or off. Pausing and resuming tools
  keeps the current page's one-time skip memory intact.
- Current-tab connection status, a refresh button, expandable Crunchyroll player status,
  and reset-to-defaults are included. Reset changes only this extension's preferences.
  Opening the popup automatically reconnects missing player tools without reloading
  the video. A page refresh is offered only if automatic reconnection fails.

The popup selects the current site's tab when opened from a supported page. Site tabs
also support arrow keys. Settings remain available from other pages.

## YouTube

Automatically hides the following when their filters are enabled:

- YouTube video cards whose metadata contains labels like `Streamed 1 hour ago`, `Streamed 3 days ago`, `Streamed 2 weeks ago` (any relative time unit)
- Shorts shelves and individual Shorts cards (home feed carousels, search, recommendations, etc.)
- Playlist Mix cards (e.g. "My Mix" with the Mix badge / radio playlist links)
- Music videos (thumbnail duration badge with the music-note icon, including lockup cards)

The **Hide Shorts** setting also hides the sidebar's Shorts entry. In compact and
expanded sidebars, **Watch later** appears directly above **Subscriptions**, followed
by **You**, and its original entry in the You menu is hidden. Pausing the extension or
YouTube tools restores the original sidebar.
Toggle **Watch later in sidebar** in the popup to restore Watch later to the You
menu independently of Shorts filtering. Both preferences apply to open tabs.

Also automatically clicks the player's visible **Jump ahead** button once per video.
The `ytSpecTouchFeedbackShapeFill` class alone is not enough: the enclosing button
must say "Jump ahead" and be inside the video player's timely-actions overlay.
Playback events and a one-second fallback check work without animation frames or tab
focus. During playback, the extension sends simulated movement to the video surface
and brief timeline hover checks to reveal Jump ahead, without moving your cursor or
switching tabs. Timeline checks target the current playback position, suppress thumbnail
previews, and send matching leave events after a skip or a 250 ms check window. Preview
suppression remains while unattended. Genuine player input ends artificial timeline hover
and releases every mask so manual tooltips and controls remain available. Unattended checks also suppress native control bars
and gradients, including the fullscreen Like/Dislike/Comments/Share row, so they do not blink.
Checks close both timeline and full player hover when unattended. They never call native
`hideControls()`/`showControls()`: toggling those APIs changes the fullscreen overlay layout.
Quiet CSS includes the separate modern fullscreen title, collapses hidden quick-action
rows, and keeps a parked cursor hidden across automatic hover checks. Real mouse
movement restores the cursor immediately. It also holds the overlay stack at YouTube's
native idle offset of 24px. This keeps the
channel watermark from moving during checks. Real movement, button presses, keyboard,
clicks, and wheel input remove suppression. Layout-generated over/enter events do not. Video-surface pointer
interaction expires after three idle seconds; intentional control-bar hover and held
mouse buttons remain protected, so stale CSS `:hover` from
another monitor cannot keep controls awake. Artificial hover also closes on window blur,
focus changes, and tab visibility changes. Simulated movement stops
once that video has been skipped. The extension never clicks/drags the timeline or changes
playback time itself.
YouTube must accept the simulated event and expose the button; browser-frozen or
discarded tabs cannot run the content script, and background timers may be delayed.

## Crunchyroll

- Optional **5-second rewind/forward** switch sets the player's rewind/forward buttons
  and left/right arrows to five seconds. Button labels and icons show the new interval.
  A separate **Enable J/K/L shortcuts** switch enables J/L for ten seconds back/forward
  and K for pause/play. Both switches start off and work independently; turning either
  off restores the corresponding native behavior. Typing,
  sliders, menus and modified shortcuts keep their normal behavior. Works in player
  frames, fullscreen and replacement players; seeks stay within the playable range.
  Seeking uses Crunchyroll's native media-session handlers or its timeline's seek
  callback, keeping the playback engine and displayed time in sync. It never writes
  directly to the media element's currentTime or retries play() to repair a stalled
  seek. If native seeking is unavailable, the original controls remain in charge.
  Keyboard interception starts before the site's native shortcuts, so the first
  arrow press uses five seconds even when Play or the timeline has focus. Volume,
  playback-speed sliders, menus, text entry and modified shortcuts stay native.

- Replaces the in-player **1x** playback-speed menu with a YouTube-style slider,
  0.05x minus/plus controls, and 1x, 1.25x, 1.5x, 1.75x, 2x, and 3x presets.
  Speeds range from 0.25x to 4x. Controls change the actual media playback rate;
  selection is saved locally and restored for subsequent episodes and player reloads.
  The picker supports keyboard controls, fullscreen, and dynamic player replacement.
  Disable separate speed controllers such as **Crunchyroll Speeder** when using it:
  those extensions can continuously restore their own saved rate. The picker detects
  repeated resets, stops fighting the other controller, and displays an actionable message.
- Automatically clicks **Skip Intro** on `crunchyroll.com`, including inside player
  frames. Matches the button's exact label, text, and `skip-intro-icon` marker.
- Works with the supplied unhovered state (`aria-hidden="true"`, opacity zero,
  pointer events disabled), so no mouse hover is needed. Truly disabled controls,
  elements removed from layout, and known unloaded videos are ignored. Controls can
  live separately from the video element, including outside its iframe or shadow root.
- Skips only once per episode in the current watch-page session. Rewinding or
  recreating the player iframe does not reset it. Each new episode gets its own skip;
  refreshing the watch page resets memory. Manual intro skips are remembered too.
- Shows a centered **Jumped ahead** notice over the video for two seconds after
  automatic skips, including in player fullscreen. Does not skip recaps or credits.
- The extension popup shows the detected intro-button count and skip status for each
  Crunchyroll frame. Open it during the intro if auto-skip does not run.

## Behavior

- Runs on every `youtube.com` page.
- Handles YouTube's single-page navigation and dynamically loaded video lists.
- Auto-clicks **Jump ahead** once per video during the current page session. Rewinding,
  replaying, or returning to the same video through YouTube navigation does not trigger
  another click. A different video gets its own click; refreshing the tab resets this memory.
- A manual **Jump ahead** click also prevents a later automatic click on that video.
- After an automatic skip, a centered **Jumped ahead** notice appears over the video
  for two seconds. It does not block player controls or appear for manual skips.
- Covers home feeds, search results, channel grids, playlists, and watch-page recommendations.
- Skips streamed-video hiding on channel **Streams** tabs (`…/streams`).
- Skips streamed-video hiding in playlists (including Watch Later and Liked videos), Downloads (`/feed/downloads`), and History (`/feed/history`).
- Skips Shorts hiding on the **Shorts** feed (`/shorts`).
- Toggle each option from the extension popup; on/off preferences are saved in sync
  storage. Crunchyroll's selected playback speed remains local to this browser.
- Hides only matching cards/sections; it does not remove or alter videos in your account.
- Needs the `storage` permission so the toggles can persist across sessions.
- Uses `scripting` and access to YouTube/Crunchyroll pages to reconnect tools in
  already-open tabs. Healthy tabs keep their existing tools and skip memory.

## Install in Brave

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Open the extension popup in already-open YouTube or Crunchyroll tabs to connect automatically.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Open the extension popup in already-open YouTube or Crunchyroll tabs to connect automatically.

## Files

- `manifest.json`: Manifest V3 registration for both sites, popup, and storage.
- `popup.html` / `popup.js` / `popup.css`: Site settings, speed controls, and connection status.
- `settings.js`: Shared settings defaults, initial loading, and live storage updates.
- `icons/`: Amber fast-forward icon for the toolbar, extension manager, and popup.
  Run `npm run build:icons` to regenerate PNG sizes from the SVG source.
- `content.js`: Video-card and Shorts-section detection, SPA navigation handling, and dynamic-content observer.
- `jump-ahead.js`: One-time-per-video auto-clicking for the player's Jump ahead button.
- `youtube-sidebar.js`: Sidebar Shorts filtering and the Watch later shortcut.
- `styles.css`: Hides matched cards and sections.
- `crunchyroll-skip-intro.js` / `crunchyroll.css`: Crunchyroll intro skipping and notice.
- `crunchyroll-playback-speed.js`: In-player playback-speed picker and saved media rate.
- `crunchyroll-seek.js`: Optional five-second seek buttons and keyboard shortcuts.
- `crunchyroll-player-bridge.js`: MAIN-world adapter for native player commands.
- `background.js`: Relays player-frame skip claims to the watch page's episode memory.

## Tests

Run `npm ci`, then `npm test`. Tests exercise the content script against a DOM fixture
matching YouTube's Jump ahead overlay, including rewinds and single-page navigation.
`npm run test:browser` loads the actual extension in an isolated headless Brave/Chromium
profile, checks the speed picker's real media playback timing, and verifies settings survive
a page reload. It uses a local player fixture, not a signed-in Crunchyroll session. Set
`CRUNCHYROLL_TEST_BROWSER` if your browser executable is not found automatically.
`npm run test:youtube-hover` samples repeated unattended checks frame by frame for title/control
flicker and channel-watermark movement, and verifies layout-generated events, stale CSS hover, manual previews,
and one-time auto-skipping in an isolated Brave/Chromium
profile with the real extension and a local player fixture. Set `YOUTUBE_TEST_BROWSER`
if the browser executable is not found automatically.
`npm run test:popup` verifies the real popup's saved preferences, layout bounds, live
speed changes, master pause, and native-menu restoration against a local player fixture
in isolated Brave/Chromium. Set `PLAYBACK_TEST_BROWSER` to override browser discovery.
`npm run test:connection` verifies recovery in tabs with no tools loaded, repeated
popup opens, live settings, one-time skip memory, and cross-origin Crunchyroll frames
without reloading the page. It uses a temporary extension copy with automatic script
loading disabled to model tabs that were open before installation.
`npm run test:keys` checks the first arrow press and held-key repeats against an
early native ten-second shortcut, including focus on Play and the timeline.
