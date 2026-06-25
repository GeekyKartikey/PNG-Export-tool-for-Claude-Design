# PNG Export for Claude Design

A Chrome extension that exports [Claude Design](https://claude.ai) artifacts as **PNG** or **PDF** at their original (or scaled) resolution.

## Why

Claude Design has no built-in PNG export, and its PDF export is unreliable on Mac. This extension adds a one-click export directly in the browser.

## Install

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select this folder (`PNG-Export-tool-for-Claude-Design`)

The extension icon appears in your toolbar.

## Usage

1. Go to [claude.ai](https://claude.ai) and open a design (`claude.ai/design/…`)
2. Make sure the design has finished rendering and is visible on screen
3. Click the extension icon
4. Choose a scale — 1× (original size), 2× (double resolution), or 3× (print quality)
5. Click **Export PNG** or **Export PDF** — the file downloads automatically

> **Heads-up:** during capture Chrome shows a yellow "… is debugging this browser" banner. That's expected — the extension uses the Chrome Debugger API to take the screenshot (see below) and removes itself the moment the capture finishes. Close DevTools on the tab before exporting, since only one debugger can attach at a time.

## How it works

A Claude design renders inside a **sandboxed, cross-origin iframe** (`claudeusercontent.com`). The sandbox blocks DOM and script access from the page, so approaches like `html2canvas` or SVG serialization can't reach the content — they come back blank.

Instead, the extension captures it the same way DevTools and Puppeteer do:

1. **popup.js** validates the active tab is claude.ai, reads the chosen scale, and asks the service worker to export.
2. **service-worker.js** attaches the Chrome Debugger to the current tab, locates the design iframe's rectangle, and calls `Page.captureScreenshot` clipped to that rect. The browser's compositor includes out-of-process iframes, so the rendered design is captured even though its DOM is unreachable. Resolution is driven by `clip.scale`; `captureBeyondViewport` handles content larger than the viewport. A blank-detection guard reports a clear error instead of silently saving an empty image.
3. For **PDF**, the captured JPEG is embedded in a minimal hand-built PDF whose page size matches the design's CSS dimensions (1 CSS px = 1 pt).
4. **offscreen.js** turns the resulting data URL into a blob URL (a service worker can't call `URL.createObjectURL`, and large `data:` URLs exceed Chrome's download size limit), which `chrome.downloads` then saves.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Capture the design via `Page.captureScreenshot` (the only way to reach the sandboxed iframe's pixels) |
| `downloads` | Save the exported PNG/PDF |
| `tabs` | Read the active tab's URL to confirm you're on claude.ai |
| `offscreen` | Create a blob URL for large downloads |
| `storage` | Remember the last export status if the popup is reopened mid-export |
| `host_permissions` | `claude.ai` and `claudeusercontent.com` (the design iframe origin) |
