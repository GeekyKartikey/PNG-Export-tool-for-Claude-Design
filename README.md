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

1. Go to [claude.ai](https://claude.ai) and open a design (`https://claude.ai/design/…`)
2. Make sure the design has finished rendering and is visible on screen
3. Click the extension icon
4. Choose a scale — 1× (original size), 2× (double resolution), or 3× (print quality)
5. Click **Export PNG** or **Export PDF** — the file downloads automatically

> **Heads-up:** during capture Chrome shows a yellow "… is debugging this browser" banner. That's expected — the extension uses the Chrome Debugger API to take the screenshot (see below) and removes itself the moment the capture finishes. Close DevTools on the tab before exporting, since only one debugger can attach at a time.

The extension only runs on Claude Design pages at `https://claude.ai/design/...`.
Exports target the designed asset/artboard itself, not Claude's surrounding
preview pane, page background, or browser UI.

## How it works

A Claude design renders inside a **sandboxed, cross-origin iframe** (`claudeusercontent.com`). The sandbox blocks DOM and script access from the page, so approaches like `html2canvas` or SVG serialization can't reach the content — they come back blank.

Instead, the extension captures it the same way DevTools and Puppeteer do:

1. **popup.js** validates the active tab is `https://claude.ai/design/...`, reads the chosen scale, and asks the service worker to export.
2. **service-worker.js** validates the request again, verifies the tab URL, attaches the Chrome Debugger to the current tab, and locates the visible `claudeusercontent.com` design iframe. It never falls back to unrelated iframes.
3. The worker tries to detect the artboard bounds inside the design frame and clips `Page.captureScreenshot` to those exact bounds. If direct bounds are unavailable, it captures the design iframe and applies conservative pixel trimming with padding and sanity checks.
4. Resolution is driven by `clip.scale`; a max-pixel guard prevents oversized screenshots from consuming too much memory. A blank-detection guard reports a clear error instead of silently saving an empty image.
5. For **PDF**, the bounded asset is JPEG-encoded and embedded in a minimal hand-built PDF whose page size matches the exported asset dimensions (1 CSS px = 1 pt).
6. **offscreen.js** turns the resulting data URL into a blob URL (a service worker can't call `URL.createObjectURL`, and large `data:` URLs exceed Chrome's download size limit), which `chrome.downloads` then saves.

If direct artboard bounds cannot be detected, the fallback trim is intentionally
conservative. It may keep extra margin rather than risk cutting off real design
edges, borders, shadows, corner marks, or background fills.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Capture the design via `Page.captureScreenshot` (the only way to reach the sandboxed iframe's pixels) |
| `downloads` | Save the exported PNG/PDF |
| `tabs` | Read the active tab's URL to confirm you're on claude.ai |
| `offscreen` | Create a blob URL for large downloads |
| `storage` | Remember the last export status if the popup is reopened mid-export |
| `host_permissions` | `claude.ai` and `claudeusercontent.com` (the design iframe origin) |
