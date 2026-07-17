# Hide Streamed YouTube Videos

Lightweight Manifest V3 extension for Brave and Chrome. It automatically hides YouTube video cards whose metadata contains:

`Streamed X days ago`

Both `Streamed 1 day ago` and plural day counts are supported.

## Behavior

- Runs on every `youtube.com` page.
- Handles YouTube's single-page navigation and dynamically loaded video lists.
- Covers home feeds, search results, channel grids, playlists, and watch-page recommendations.
- Hides only matching video cards; it does not remove or alter videos in your account.
- Requires no extension permissions beyond access to YouTube pages.

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

- `manifest.json`: Manifest V3 registration for YouTube pages.
- `content.js`: Video-card detection, SPA navigation handling, and dynamic-content observer.
- `styles.css`: Hides matched cards.
