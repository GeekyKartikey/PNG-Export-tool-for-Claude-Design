// Runs inside claudeusercontent.com design frames. The service worker asks this
// script to hide generated tweak controls just before the compositor screenshot
// and restore them immediately after.

(() => {
  const STYLE_ID = 'claude-png-export-capture-style';
  const HIDE_ATTR = 'data-claude-png-export-hidden-visibility';
  const PREPARE_ACTION = 'claudePngPrepareFrameCapture';
  const RESTORE_ACTION = 'claudePngRestoreFrameCapture';
  const READY_TIMEOUT_MS = 5000;

  function isClaudeusercontentFrame() {
    return location.protocol === 'https:' &&
      (location.hostname === 'claudeusercontent.com' ||
        location.hostname.endsWith('.claudeusercontent.com'));
  }

  if (!isClaudeusercontentFrame()) return;

  function hide(el) {
    if (!el || el.hasAttribute(HIDE_ATTR)) return;
    el.setAttribute(HIDE_ATTR, el.style.visibility || '');
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  function restore() {
    document.getElementById(STYLE_ID)?.remove();
    for (const el of Array.from(document.querySelectorAll('[' + HIDE_ATTR + ']'))) {
      const old = el.getAttribute(HIDE_ATTR);
      el.removeAttribute(HIDE_ATTR);
      if (old) el.style.visibility = old;
      else el.style.removeProperty('visibility');
    }
  }

  function ensureStyle() {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '[data-testid*="tweak" i] { visibility: hidden !important; }',
      '[aria-label*="tweak" i] { visibility: hidden !important; }',
      '[class*="tweak" i] { visibility: hidden !important; }',
      '[role="dialog"] { visibility: hidden !important; }',
      '[data-radix-popper-content-wrapper] { visibility: hidden !important; }'
    ].join('\n');
    document.documentElement.appendChild(style);
  }

  function likelyPanelFor(el) {
    let panel = el;
    while (panel.parentElement) {
      const r = panel.getBoundingClientRect();
      if (r.width >= 180 && r.height >= 80 && r.width <= 1000 && r.height <= 800) break;
      panel = panel.parentElement;
    }
    return panel;
  }

  function hideTweakControls() {
    const selectorMatches = [
      '[data-testid*="tweak" i]',
      '[aria-label*="tweak" i]',
      '[class*="tweak" i]',
      '[role="dialog"]',
      '[data-radix-popper-content-wrapper]'
    ];
    for (const el of Array.from(document.querySelectorAll(selectorMatches.join(',')))) {
      hide(likelyPanelFor(el));
    }

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/\bTweaks\b/i.test(text)) continue;
      hide(likelyPanelFor(el));
    }
  }

  async function waitForReady() {
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, READY_TIMEOUT_MS))
      ]);
    }

    await Promise.race([
      Promise.all(Array.from(document.images)
        .filter(img => !img.complete)
        .map(img => new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        }))),
      new Promise(resolve => setTimeout(resolve, READY_TIMEOUT_MS))
    ]);

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function prepare() {
    if (!document.documentElement) return false;
    ensureStyle();
    hideTweakControls();
    await waitForReady();
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === PREPARE_ACTION) {
      prepare()
        .then((ok) => sendResponse({ ok }))
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true;
    }

    if (msg?.action === RESTORE_ACTION) {
      restore();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
