# YouTube Hide

Lightweight Manifest V3 extension for Brave and Chrome. It automatically hides:

- YouTube video cards whose metadata contains labels like `Streamed 1 hour ago`, `Streamed 3 days ago`, `Streamed 2 weeks ago` (any relative time unit)
- Shorts shelves and individual Shorts cards (home feed carousels, search, recommendations, etc.)
- Playlist Mix cards (e.g. "My Mix" with the Mix badge / radio playlist links)
- Music videos (thumbnail duration badge with the music-note icon, including lockup cards)

More hide options may be added over time.

Also automatically clicks the player's visible **Jump ahead** button once per video.
The `ytSpecTouchFeedbackShapeFill` class alone is not enough: the enclosing button
must say "Jump ahead" and be inside the video player's timely-actions overlay.
Playback events and a one-second fallback check work without animation frames or tab
focus. During playback, the extension sends simulated movement to the video surface
and brief timeline hover checks to reveal Jump ahead, without moving your cursor or
switching tabs. Timeline checks target the current playback position, suppress thumbnail
previews, and send matching leave events after a skip or a 250 ms check window. Preview
suppression remains until intentional timeline hover so returning to the video from another
monitor cannot expose a stale thumbnail. Unattended checks also suppress native control bars
and gradients, including the fullscreen Like/Dislike/Comments/Share row, so they do not blink.
Checks close both timeline and full player hover when unattended. Real player input restores controls, and a real timeline
hover restores previews. Checks leave an already hovered player alone and close artificial
hover on window blur, focus changes, and tab visibility changes. Simulated movement stops
once that video has been skipped. The extension never clicks/drags the timeline or changes
playback time itself.
YouTube must accept the simulated event and expose the button; browser-frozen or
discarded tabs cannot run the content script, and background timers may be delayed.

## Crunchyroll

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
- Toggle each option from the extension popup; preferences are saved in sync storage.
- Hides only matching cards/sections; it does not remove or alter videos in your account.
- Needs the `storage` permission so the toggles can persist across sessions.

## Install in Brave

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Reload any already-open YouTube tabs once.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Reload any already-open YouTube tabs once.

## Files

- `manifest.json`: Manifest V3 registration for YouTube pages, popup, and storage.
- `popup.html` / `popup.js` / `popup.css`: Extension popup with hide toggles.
- `content.js`: Video-card and Shorts-section detection, SPA navigation handling, and dynamic-content observer.
- `jump-ahead.js`: One-time-per-video auto-clicking for the player's Jump ahead button.
- `styles.css`: Hides matched cards and sections.
- `crunchyroll-skip-intro.js` / `crunchyroll.css`: Crunchyroll intro skipping and notice.
- `crunchyroll-playback-speed.js`: In-player playback-speed picker and saved media rate.
- `background.js`: Relays player-frame skip claims to the watch page's episode memory.

## Tests

Run `npm ci`, then `npm test`. Tests exercise the content script against a DOM fixture
matching YouTube's Jump ahead overlay, including rewinds and single-page navigation.
`npm run test:browser` loads the actual extension in an isolated headless Brave/Chromium
profile, checks the speed picker's real media playback timing, and verifies settings survive
a page reload. It uses a local player fixture, not a signed-in Crunchyroll session. Set
`CRUNCHYROLL_TEST_BROWSER` if your browser executable is not found automatically.
`npm run test:youtube-hover` checks unattended control-bar visibility, return-to-video
hover cleanup, manual previews, and one-time auto-skipping in an isolated Brave/Chromium
profile with the real extension and a local player fixture. Set `YOUTUBE_TEST_BROWSER`
if the browser executable is not found automatically.
