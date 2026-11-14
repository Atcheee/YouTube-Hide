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

## Tests

Run `npm ci`, then `npm test`. Tests exercise the content script against a DOM fixture
matching YouTube's Jump ahead overlay, including rewinds and single-page navigation.
