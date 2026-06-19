// Captures the design by attaching the Chrome Debugger to the already-open
// claude.ai tab, finding the rendered iframe via Runtime.evaluate, and using
// Page.captureScreenshot with a clip to that exact region.
// No new tab needed — the iframe is already rendered with its postMessage data.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function notify(status) {
  chrome.runtime.sendMessage({ action: 'exportStatus', ...status }).catch(() => {});
}

// Use Runtime.evaluate to find the design iframe's position in the page.
// Returns { x, y, width, height } in CSS pixels, or null.
async function getIframeRect(tabId) {
  const { result } = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `JSON.stringify((function() {
      const frames = Array.from(document.querySelectorAll('iframe'))
        .filter(f => f.clientWidth > 100 && f.clientHeight > 100)
        .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      if (!frames.length) return null;
      const r = frames[0].getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY,
               width: r.width, height: r.height };
    })())`,
    returnByValue: true,
  });
  if (!result?.value) return null;
  return JSON.parse(result.value);
}

async function captureDesignFromTab(tabId, format, scale) {
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    notify({ busy: true, message: 'Finding design area…' });
    const rect = await getIframeRect(tabId);
    if (!rect) throw new Error('No design preview found. Make sure the design is fully loaded.');

    // Expand viewport so the full iframe region is in the layout tree
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width:  Math.max(Math.ceil(metrics.contentSize.width),  Math.ceil(rect.x + rect.width)),
      height: Math.max(Math.ceil(metrics.contentSize.height), Math.ceil(rect.y + rect.height)),
      deviceScaleFactor: scale,
      mobile: false,
    });
    await sleep(300);

    notify({ busy: true, message: 'Capturing design…' });
    const fmt = format === 'pdf' ? 'jpeg' : 'png';
    const params = {
      format: fmt,
      captureBeyondViewport: true,
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
    };
    if (fmt === 'jpeg') params.quality = 95;

    const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);

    // Restore viewport
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');

    const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    return {
      dataUrl: `data:${mime};base64,${data}`,
      cssW: Math.round(rect.width),
      cssH: Math.round(rect.height),
      imgW: Math.round(rect.width  * scale),
      imgH: Math.round(rect.height * scale),
    };
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

function uint8ToBase64(arr) {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    out += String.fromCharCode(...arr.subarray(i, Math.min(i + chunk, arr.length)));
  }
  return btoa(out);
}

// PDF page size = design CSS dimensions (1 CSS px = 1 PDF pt)
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

async function runExport({ format, scale, tabId }) {
  try {
    const { dataUrl, cssW, cssH, imgW, imgH } = await captureDesignFromTab(tabId, format, scale);

    notify({ busy: true, message: 'Saving file…' });

    if (format === 'pdf') {
      const pdf = buildPdf(dataUrl, imgW, imgH, cssW, cssH);
      const b64 = `data:application/pdf;base64,${uint8ToBase64(pdf)}`;
      await chrome.downloads.download({ url: b64, filename: 'claude-design.pdf', saveAs: false });
    } else {
      await chrome.downloads.download({ url: dataUrl, filename: 'claude-design.png', saveAs: false });
    }

    notify({ busy: false, message: 'Saved! Check your downloads.', type: 'success' });
  } catch (e) {
    notify({ busy: false, message: e.message || 'Export failed.', type: 'error' });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'export') {
    runExport(msg);
    sendResponse({ started: true });
  }
});
