// Injects a PNG option into Claude Design's Export panel. The actual capture
// still happens in the service worker via Chrome Debugger; this script only
// provides the in-page control and forwards the user's export request.

(() => {
  const CARD_ID = 'claude-png-export-card';
  const STYLE_ID = 'claude-png-export-style';
  const SCALE = 1;

  let selected = false;
  let busy = false;
  let statusText = '';
  let scheduled = false;

  function isClaudeDesignPage() {
    return location.protocol === 'https:' &&
      location.hostname === 'claude.ai' &&
      location.pathname.startsWith('/design/');
  }

  function normalize(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function ownText(el) {
    return normalize(Array.from(el.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent)
      .join(' '));
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0;
  }

  function area(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function findExportPanel() {
    if (!isClaudeDesignPage()) return null;
    const candidates = Array.from(document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper], div'))
      .filter(isVisible)
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 420 || rect.height < 360) return false;
        const text = normalize(el.textContent);
        return text.includes('Export') &&
          text.includes('Format') &&
          text.includes('PDF') &&
          text.includes('Download');
      })
      .sort((a, b) => area(a) - area(b));
    return candidates[0] || null;
  }

  function findLabel(root, label) {
    return Array.from(root.querySelectorAll('*'))
      .filter(isVisible)
      .find(el => ownText(el) === label || normalize(el.textContent) === label);
  }

  function findCardFromLabel(root, label) {
    const labelEl = findLabel(root, label);
    let current = labelEl;
    while (current && current !== root) {
      const rect = current.getBoundingClientRect();
      if (rect.width >= 180 && rect.height >= 100 && normalize(current.textContent).includes(label)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function findFormatGrid(panel) {
    const pdfCard = findCardFromLabel(panel, 'PDF');
    const pptCard = findCardFromLabel(panel, 'PowerPoint');
    if (pdfCard?.parentElement?.contains(pptCard)) return pdfCard.parentElement;
    return pdfCard?.parentElement || null;
  }

  function findDownloadButton(panel) {
    return Array.from(panel.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .find(el => /\bDownload\b/i.test(normalize(el.textContent)));
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CARD_ID} {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 128px;
        padding: 28px 30px;
        border: 2px solid #e3e3e3;
        border-radius: 24px;
        background: #fff;
        color: #262624;
        font: inherit;
        text-align: left;
        cursor: pointer;
        appearance: none;
        transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
      }
      #${CARD_ID}:hover {
        border-color: #2f7de1;
        background: #f8fbff;
      }
      #${CARD_ID}[data-selected="true"] {
        border-color: #2f7de1;
        background: #eef5ff;
        box-shadow: 0 0 0 1px rgba(47, 125, 225, 0.1);
      }
      #${CARD_ID}[data-busy="true"] {
        cursor: wait;
        opacity: 0.82;
      }
      #${CARD_ID} .cpe-icon {
        width: 72px;
        height: 72px;
        border-radius: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
        background: #f0eee6;
        color: #33302a;
        font-size: 18px;
        font-weight: 750;
        letter-spacing: 0;
      }
      #${CARD_ID} .cpe-check {
        position: absolute;
        top: 28px;
        right: 28px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 4px solid #c9c9c9;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        font-weight: 700;
      }
      #${CARD_ID}[data-selected="true"] .cpe-check {
        border-color: #2f7de1;
        background: #2f7de1;
      }
      #${CARD_ID} .cpe-title {
        font-size: 27px;
        line-height: 1.2;
        font-weight: 750;
        letter-spacing: 0;
      }
      #${CARD_ID} .cpe-ext {
        margin-left: 8px;
        color: #777;
        font-weight: 650;
      }
      #${CARD_ID} .cpe-desc {
        margin-top: 8px;
        color: #717171;
        font-size: 24px;
        line-height: 1.35;
        letter-spacing: 0;
      }
      #${CARD_ID} .cpe-status {
        min-height: 20px;
        margin-top: 10px;
        color: #2f7de1;
        font-size: 15px;
        line-height: 1.25;
        letter-spacing: 0;
      }
      #${CARD_ID}[data-error="true"] .cpe-status {
        color: #c0392b;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createPngCard() {
    const card = document.createElement('button');
    card.id = CARD_ID;
    card.type = 'button';
    card.setAttribute('aria-label', 'Export PNG');

    const icon = document.createElement('div');
    icon.className = 'cpe-icon';
    icon.textContent = 'PNG';

    const check = document.createElement('div');
    check.className = 'cpe-check';
    check.textContent = '';
    check.setAttribute('aria-hidden', 'true');

    const title = document.createElement('div');
    title.className = 'cpe-title';
    title.append('PNG');
    const ext = document.createElement('span');
    ext.className = 'cpe-ext';
    ext.textContent = '.png';
    title.append(ext);

    const desc = document.createElement('div');
    desc.className = 'cpe-desc';
    desc.textContent = 'Exact asset image export.';

    const status = document.createElement('div');
    status.className = 'cpe-status';

    card.append(icon, check, title, desc, status);
    return card;
  }

  function updateCard(card = document.getElementById(CARD_ID), isError = false) {
    if (!card) return;
    card.dataset.selected = selected ? 'true' : 'false';
    card.dataset.busy = busy ? 'true' : 'false';
    card.dataset.error = isError ? 'true' : 'false';
    card.querySelector('.cpe-check').textContent = selected ? '✓' : '';
    card.querySelector('.cpe-status').textContent = statusText;
  }

  function selectPng() {
    selected = true;
    statusText = busy ? 'Exporting PNG...' : 'Click Download to save PNG.';
    updateCard();
  }

  function clearSelection() {
    if (!selected || busy) return;
    selected = false;
    statusText = '';
    updateCard();
  }

  async function startPngExport() {
    if (busy) return;
    selected = true;
    busy = true;
    statusText = 'Starting PNG export...';
    updateCard();

    try {
      const res = await chrome.runtime.sendMessage({ action: 'export', format: 'png', scale: SCALE });
      if (res && res.started === false) {
        throw new Error(res.error || 'Export failed.');
      }
      statusText = 'Exporting PNG...';
      updateCard();
    } catch (e) {
      busy = false;
      statusText = e.message || 'Export failed.';
      updateCard(undefined, true);
    }
  }

  function injectCard() {
    const panel = findExportPanel();
    if (!panel || panel.querySelector(`#${CARD_ID}`)) return;

    const grid = findFormatGrid(panel);
    if (!grid) return;

    ensureStyle();
    const card = createPngCard();
    const pdfCard = findCardFromLabel(panel, 'PDF');
    if (pdfCard?.parentElement === grid && pdfCard.nextSibling) {
      grid.insertBefore(card, pdfCard.nextSibling);
    } else {
      grid.appendChild(card);
    }
    updateCard(card);
  }

  function scheduleInject() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      injectCard();
    });
  }

  document.addEventListener('click', (event) => {
    const card = event.target.closest?.(`#${CARD_ID}`);
    if (card) {
      event.preventDefault();
      event.stopPropagation();
      selectPng();
      return;
    }

    if (!selected) return;

    const panel = findExportPanel();
    if (!panel || !panel.contains(event.target)) {
      clearSelection();
      return;
    }

    const downloadButton = findDownloadButton(panel);
    if (downloadButton?.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startPngExport();
      return;
    }

    clearSelection();
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'exportStatus' || !selected) return;
    busy = !!msg.busy;
    statusText = msg.message || '';
    updateCard(undefined, msg.type === 'error');
  });

  if (isClaudeDesignPage()) {
    scheduleInject();
    new MutationObserver(scheduleInject).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();
