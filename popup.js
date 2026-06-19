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

async function getActiveClaudeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url?.includes('claude.ai')) {
    throw new Error('Open claude.ai and create a design first.');
  }
  return tab;
}

async function sendExport(action, extra = {}) {
  setBusy(true);
  setStatus('Looking for design…');
  try {
    const tab = await getActiveClaudeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { action, ...extra });
    if (response?.success) {
      setStatus('Saved! Check your downloads.', 'success');
    } else {
      setStatus(response?.error || 'Export failed — try again.', 'error');
    }
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('Could not establish connection')) {
      setStatus('Refresh claude.ai and try again.', 'error');
    } else {
      setStatus(msg || 'Unexpected error.', 'error');
    }
  } finally {
    setBusy(false);
  }
}

pngBtn.addEventListener('click', () => {
  const scale = parseInt(scaleSelect.value, 10);
  sendExport('exportPng', { scale });
});

pdfBtn.addEventListener('click', () => {
  // PDF always exports at the design's original dimensions — scale selector is irrelevant
  sendExport('exportPdf');
});
