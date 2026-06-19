# PNG Export for Claude Design

A Chrome extension that adds PNG export to Claude Design at the original (or scaled) resolution.

## Why

Claude Design has no PNG export, and its PDF export is unreliable on Mac. This extension adds a one-click PNG export directly in the browser.

## Install

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select this folder (`PNG-Export-tool-for-Claude-Design`)

The extension icon appears in your toolbar.

## Usage

1. Go to [claude.ai](https://claude.ai) and open or create a design
2. Make sure the design is visible on screen
3. Click the extension icon
4. Choose a scale (1× = original size, 2× = double resolution, 3× = print quality)
5. Click **Export as PNG** — the file downloads automatically

## How it works

The extension scans the page for the largest SVG or Canvas element (Claude Design renders as SVG). It serializes the SVG with its styles, draws it to an off-screen Canvas at the requested scale, and downloads the result as a PNG.
