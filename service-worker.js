// Service worker owns the full export lifecycle (survives popup close).
// Uses the Chrome Debugger API (Page.captureScreenshot) instead of html2canvas —
// this uses Chrome's own renderer so it works with any CSS, gradients, web fonts, etc.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// Capture the full page via Chrome DevTools Protocol.
// Returns { dataUrl, cssWidth, cssHeight, imgW, imgH }
async function captureWithDebugger(tabId, screenshotFormat, scale) {
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    // Get the actual rendered content dimensions
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const cssWidth  = Math.ceil(metrics.contentSize.width);
    const cssHeight = Math.ceil(metrics.contentSize.height);

    if (!cssWidth || !cssHeight) throw new Error('Design rendered with zero dimensions — try waiting for it to fully load.');

    // Expand viewport to the full content size so nothing is clipped
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width: cssWidth,
      height: cssHeight,
      deviceScaleFactor: scale,  // 1 = original px, 2 = double resolution
      mobile: false,
    });

    // Give layout a moment to settle after viewport change
    await sleep(400);

    const params = { format: screenshotFormat, captureBeyondViewport: true };
    if (screenshotFormat === 'jpeg') params.quality = 95;

    const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);

    const mime = screenshotFormat === 'png' ? 'image/png' : 'image/jpeg';
    return {
      dataUrl: `data:${mime};base64,${data}`,
      cssWidth,
      cssHeight,
      imgW: Math.round(cssWidth * scale),
      imgH: Math.round(cssHeight * scale),
    };
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// Convert Uint8Array → base64 without blowing the call stack on large files
function uint8ToBase64(arr) {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    out += String.fromCharCode(...arr.subarray(i, Math.min(i + chunk, arr.length)));
  }
  return btoa(out);
}

// Build a minimal PDF. Page size = design CSS dimensions (1 CSS px = 1 PDF pt).
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

function notify(status) {
  chrome.runtime.sendMessage({ action: 'exportStatus', ...status }).catch(() => {});
}

async function runExport({ format, scale, iframeSrc }) {
  let designTab = null;
  try {
    notify({ busy: true, message: 'Opening design…' });
    designTab = await chrome.tabs.create({ url: iframeSrc, active: false });

    await waitForTabLoad(designTab.id);
    // Allow fonts and any JS-driven layout to finish
    await sleep(2000);

    notify({ busy: true, message: 'Capturing design…' });

    // PNG export: capture as PNG directly
    // PDF export: capture as JPEG (smaller, embeds into PDF without re-encoding)
    const screenshotFormat = format === 'pdf' ? 'jpeg' : 'png';
    const { dataUrl, cssWidth, cssHeight, imgW, imgH } = await captureWithDebugger(
      designTab.id, screenshotFormat, scale
    );

    notify({ busy: true, message: 'Saving file…' });

    if (format === 'pdf') {
      const pdfBytes = buildPdf(dataUrl, imgW, imgH, cssWidth, cssHeight);
      const pdfDataUrl = `data:application/pdf;base64,${uint8ToBase64(pdfBytes)}`;
      await chrome.downloads.download({ url: pdfDataUrl, filename: 'claude-design.pdf', saveAs: false });
    } else {
      await chrome.downloads.download({ url: dataUrl, filename: 'claude-design.png', saveAs: false });
    }

    notify({ busy: false, message: 'Saved! Check your downloads.', type: 'success' });
  } catch (e) {
    notify({ busy: false, message: e.message || 'Export failed.', type: 'error' });
  } finally {
    if (designTab) chrome.tabs.remove(designTab.id).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'export') {
    runExport(msg);
    sendResponse({ started: true });
  }
});
