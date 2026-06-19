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

// Get the design iframe src from the current tab
async function getIframeSrc(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Find the largest non-blank iframe (the design preview)
      const frames = Array.from(document.querySelectorAll('iframe'))
        .filter(f => f.src && f.src.startsWith('http'))
        .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      return frames[0]?.src ?? null;
    },
  });
  return result;
}

// Receive progress updates from the service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'exportStatus') return;
  setStatus(msg.message, msg.type || '');
  setBusy(msg.busy);
});

async function runExport(format) {
  setBusy(true);
  setStatus('Looking for design…');
  const scale = parseInt(scaleSelect.value, 10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url?.includes('claude.ai')) {
      setStatus('Open claude.ai first.', 'error');
      setBusy(false);
      return;
    }

    // Try SVG/canvas fast-path for regular artifact pages
    let direct = null;
    try {
      direct = await chrome.tabs.sendMessage(tab.id, {
        action: format === 'pdf' ? 'exportPdf' : 'exportPng', scale,
      });
    } catch (_) { /* no content script or no SVG found */ }

    if (direct?.success) {
      setStatus('Saved! Check your downloads.', 'success');
      setBusy(false);
      return;
    }

    // HTML design path — hand off to service worker (survives popup close)
    const iframeSrc = await getIframeSrc(tab.id);
    if (!iframeSrc) {
      setStatus('No design found. Make sure the design is fully loaded.', 'error');
      setBusy(false);
      return;
    }

    setStatus('Starting export…');
    // Service worker takes over from here and sends back status updates
    chrome.runtime.sendMessage({ action: 'export', format, scale, iframeSrc });

  } catch (e) {
    setStatus(e.message || 'Unexpected error.', 'error');
    setBusy(false);
  }
}

pngBtn.addEventListener('click', () => runExport('png'));
pdfBtn.addEventListener('click', () => runExport('pdf'));
