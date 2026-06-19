const pngBtn = document.getElementById('pngBtn');
const pdfBtn = document.getElementById('pdfBtn');
const statusEl = document.getElementById('status');
const scaleSelect = document.getElementById('scale');

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}
function setBusy(busy) {
  pngBtn.disabled = busy;
  pdfBtn.disabled = busy;
}

// Status updates from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'exportStatus') return;
  setStatus(msg.message, msg.type || '');
  setBusy(!!msg.busy);
});

// Restore the last status if the popup was reopened after closing mid-export.
chrome.storage.session.get('lastStatus').then(({ lastStatus }) => {
  if (lastStatus && !statusEl.textContent) {
    setStatus(lastStatus.message, lastStatus.type || '');
    setBusy(!!lastStatus.busy);
  }
}).catch(() => {});

async function runExport(format) {
  setBusy(true);
  setStatus('Starting…');
  const scale = parseInt(scaleSelect.value, 10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url?.includes('claude.ai')) {
      setStatus('Open claude.ai first.', 'error');
      setBusy(false);
      return;
    }

    // On a Design page the artifact is an HTML iframe — always use the debugger
    // capture path. The SVG/canvas fast-path is only for regular artifact pages,
    // where it must NOT run on /design (it would grab a stray claude.ai SVG and
    // download the wrong thing).
    const isDesign = /\/design\//.test(tab.url) || /\.dc\.html/.test(tab.url);
    if (!isDesign && format === 'png') {
      let direct = null;
      try {
        direct = await chrome.tabs.sendMessage(tab.id, { action: 'exportPng', scale });
      } catch (_) {}
      if (direct?.success) {
        setStatus('Saved! Check your downloads.', 'success');
        setBusy(false);
        return;
      }
    }

    // Hand off to service worker — it attaches the debugger to THIS tab
    // and clips to the already-rendered iframe (no new tab opened)
    setStatus('Capturing…');
    chrome.runtime.sendMessage({ action: 'export', format, scale, tabId: tab.id });

  } catch (e) {
    setStatus(e.message || 'Error.', 'error');
    setBusy(false);
  }
}

pngBtn.addEventListener('click', () => runExport('png'));
pdfBtn.addEventListener('click', () => runExport('pdf'));
