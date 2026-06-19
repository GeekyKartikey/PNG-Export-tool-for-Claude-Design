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
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// Get the design iframe's src from the main page (runs in main-frame context, not the sandbox)
async function getDesignIframeSrc(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const iframes = Array.from(document.querySelectorAll('iframe'))
        .filter(f => f.src && f.src.startsWith('http'))
        .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      return iframes[0]?.src ?? null;
    },
  });
  return result;
}

// Wait for a tab to finish loading (with timeout)
function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(fn);
      reject(new Error('Design page took too long to load.'));
    }, timeoutMs);
    function fn(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// Open the design URL in a background tab, inject html2canvas, capture, close
async function captureDesignUrl(designUrl, scale) {
  const tab = await chrome.tabs.create({ url: designUrl, active: false });
  try {
    await waitForTabLoad(tab.id);
    // Brief pause so fonts/images finish rendering after DOMContentLoaded
    await new Promise(r => setTimeout(r, 1200));

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['html2canvas.min.js'],
    });

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (pixelScale) => {
        const root = document.documentElement;
        const w = Math.max(root.scrollWidth, root.clientWidth);
        const h = Math.max(root.scrollHeight, root.clientHeight);
        const canvas = await window.html2canvas(root, {
          width: w, height: h,
          windowWidth: w, windowHeight: h,
          scale: pixelScale,
          useCORS: true,
          allowTaint: true,
          logging: false,
          backgroundColor: '#ffffff',
        });
        return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
      },
      args: [scale],
    });

    return result;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Build PDF with page = exact design CSS dimensions (1 CSS px = 1 PDF pt)
function buildPdf(jpegDataUrl, imgW, imgH, ptW, ptH) {
  const imgBytes = Uint8Array.from(atob(jpegDataUrl.split(',')[1]), c => c.charCodeAt(0));
  const enc = new TextEncoder();
  const stream = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/img0 Do\nQ\n`;
  const o1 = enc.encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const o2 = enc.encode('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  const o3 = enc.encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R\n   /MediaBox [0 0 ${ptW} ${ptH}]\n   /Contents 4 0 R\n   /Resources << /XObject << /img0 5 0 R >> >> >>\nendobj\n`);
  const o4 = enc.encode(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  const o5h = enc.encode(`5 0 obj\n<< /Type /XObject /Subtype /Image\n   /Width ${imgW} /Height ${imgH}\n   /ColorSpace /DeviceRGB /BitsPerComponent 8\n   /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`);
  const o5f = enc.encode('\nendstream\nendobj\n');
  const hdr = enc.encode('%PDF-1.4\n');
  let off = hdr.length;
  const x1 = off; off += o1.length;
  const x2 = off; off += o2.length;
  const x3 = off; off += o3.length;
  const x4 = off; off += o4.length;
  const x5 = off; off += o5h.length + imgBytes.length + o5f.length;
  const xref = enc.encode('xref\n0 6\n0000000000 65535 f \n' +
    [x1, x2, x3, x4, x5].map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join(''));
  const trailer = enc.encode(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF`);
  const parts = [hdr, o1, o2, o3, o4, o5h, imgBytes, o5f, xref, trailer];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

async function runExport(format) {
  setBusy(true);
  setStatus('Looking for design…');
  const scale = parseInt(scaleSelect.value, 10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url?.includes('claude.ai')) {
      setStatus('Open claude.ai first.', 'error');
      return;
    }

    // Fast-path: SVG/canvas artifacts (regular claude.ai, not claude.ai/design)
    let direct;
    try {
      direct = await chrome.tabs.sendMessage(tab.id, { action: format === 'pdf' ? 'exportPdf' : 'exportPng', scale });
    } catch (_) { direct = null; }

    if (direct?.success) {
      setStatus('Saved! Check your downloads.', 'success');
      return;
    }

    // HTML design — open the iframe URL as a real tab (bypasses sandbox)
    setStatus('Finding design URL…');
    const iframeSrc = await getDesignIframeSrc(tab.id);
    if (!iframeSrc) {
      setStatus('No design found. Make sure the design is fully loaded.', 'error');
      return;
    }

    setStatus('Rendering design… (this takes a few seconds)');
    const { dataUrl, width, height } = await captureDesignUrl(iframeSrc, scale);

    if (format === 'pdf') {
      const img = await loadImage(dataUrl);
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      const jpeg = c.toDataURL('image/jpeg', 0.95);
      const pdf = buildPdf(jpeg, c.width, c.height, width, height);
      triggerDownload(URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' })), 'claude-design.pdf');
    } else {
      triggerDownload(dataUrl, 'claude-design.png');
    }

    setStatus('Saved! Check your downloads.', 'success');
  } catch (e) {
    setStatus(e.message || 'Unexpected error.', 'error');
  } finally {
    setBusy(false);
  }
}

pngBtn.addEventListener('click', () => runExport('png'));
pdfBtn.addEventListener('click', () => runExport('pdf'));
