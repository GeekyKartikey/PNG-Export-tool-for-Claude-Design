// Captures the Claude Design artifact by attaching the Chrome Debugger to the
// already-open claude.ai tab and using Page.captureScreenshot. The browser-level
// compositor includes cross-origin / out-of-process iframes (the design lives in
// a sandboxed claudeusercontent.com iframe), so clipping to that iframe's rect
// yields the rendered design — no new tab, no viewport override.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Live status to the popup (ignored if closed) + persisted so a reopened popup
// can show the final result, and a badge so success/failure is visible regardless.
function notify(status) {
  chrome.runtime.sendMessage({ action: 'exportStatus', ...status }).catch(() => {});
  chrome.storage.session.set({ lastStatus: status }).catch(() => {});
}
function setBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#27ae60' : '#c0392b' }).catch(() => {});
}
function clearBadge() {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

// Find the design iframe's rect in CSS px (page coordinates). Anchored to the
// claudeusercontent.com origin so we never grab a Stripe/Turnstile/analytics frame.
async function getIframeRect(tabId) {
  const { result, exceptionDetails } = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `JSON.stringify((function(){
      let pool = Array.from(document.querySelectorAll('iframe[src*="claudeusercontent.com"]'));
      if (!pool.length) pool = Array.from(document.querySelectorAll('iframe'));
      const vis = pool
        .map(f => f.getBoundingClientRect())
        .filter(r => r.width > 100 && r.height > 100)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));
      if (!vis.length) return null;
      const r = vis[0];
      return { x: Math.floor(r.left + window.scrollX),
               y: Math.floor(r.top  + window.scrollY),
               width:  Math.ceil(r.width),
               height: Math.ceil(r.height) };
    })())`,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error('Failed to locate design preview: ' +
      (exceptionDetails.exception?.description || exceptionDetails.text || 'in-page evaluation threw'));
  }
  if (result?.value == null) return null; // genuine "no iframe found"
  return JSON.parse(result.value);
}

// Decode the capture and check whether it's essentially all white/blank, so we
// can report a clear error instead of silently saving an empty image.
async function isMostlyBlank(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    // Sample at a decent resolution so thin lines / sparse text aren't averaged
    // into white by downscaling, and only flag a frame with essentially no signal.
    const w = Math.min(256, bmp.width), h = Math.min(256, bmp.height);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 252 || data[i + 1] < 252 || data[i + 2] < 252) nonWhite++;
    }
    bmp.close();
    return nonWhite < 8; // essentially zero non-white pixels => truly blank
  } catch {
    return false; // if we can't tell, don't block the download
  }
}

async function captureDesignFromTab(tabId, format, scale) {
  await chrome.debugger.attach({ tabId }, '1.3').catch((e) => {
    throw new Error('Could not attach to the tab (close DevTools if open): ' + (e.message || e));
  });
  try {
    notify({ busy: true, message: 'Finding design area…' });
    const rect = await getIframeRect(tabId);
    if (!rect || rect.width < 1 || rect.height < 1) {
      throw new Error('No design preview found. Open the design and let it finish rendering.');
    }

    await sleep(150); // let any in-progress paint settle

    notify({ busy: true, message: 'Capturing design…' });
    const fmt = format === 'pdf' ? 'jpeg' : 'png';
    const params = {
      format: fmt,
      captureBeyondViewport: true,
      fromSurface: true,
      // Resolution comes from clip.scale (NOT deviceScaleFactor), so the returned
      // image's TRUE pixel size is width*scale x height*scale.
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale },
    };
    if (fmt === 'jpeg') params.quality = 95;

    const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);
    const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${data}`;

    if (await isMostlyBlank(dataUrl)) {
      throw new Error('Capture came back blank. Make sure the design is fully visible, then retry.');
    }

    return { dataUrl, cssW: rect.width, cssH: rect.height };
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// ---- PDF (page size = design CSS dimensions; 1 CSS px = 1 PDF pt) ----

// True pixel dimensions from a JPEG's SOFn marker, so the PDF XObject /Width
// /Height always match the embedded stream regardless of how Chrome scaled it.
function jpegSize(bytes) {
  let i = 2; // skip SOI (FFD8)
  while (i < bytes.length - 8) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const m = bytes[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6],
               width:  (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

function buildPdf(imgBytes, imgW, imgH, ptW, ptH) {
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

function uint8ToBase64(arr) {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    out += String.fromCharCode(...arr.subarray(i, Math.min(i + chunk, arr.length)));
  }
  return btoa(out);
}

// ---- Download via an offscreen document (URL.createObjectURL isn't available
//      in the service worker, and large data: URLs exceed Chrome's download
//      URL size limit and fail silently). ----

let creatingOffscreen = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create a blob URL so large PNG/PDF exports can be downloaded.',
    });
  }
  try {
    await creatingOffscreen;
  } catch (e) {
    // A concurrent caller may have already created the doc (getContexts race).
    // Treat that as success; rethrow anything else.
    if (!/single offscreen document/i.test(e?.message || '')) throw e;
  } finally {
    creatingOffscreen = null; // always clear the latch so a transient failure doesn't stick
  }
}

async function downloadDataUrl(dataUrl, filename) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'blobUrl', dataUrl });
  if (!res?.url) throw new Error('Could not prepare the file for download.');
  const id = await chrome.downloads.download({ url: res.url, filename, saveAs: false });
  // download() resolves when the download STARTS; revoking now would race Chrome's
  // async read of the blob and truncate large files. Revoke only once it's done.
  chrome.downloads.onChanged.addListener(function onCh(d) {
    if (d.id !== id || !d.state) return;
    if (d.state.current === 'complete' || d.state.current === 'interrupted') {
      chrome.downloads.onChanged.removeListener(onCh);
      chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'revoke', url: res.url }).catch(() => {});
    }
  });
}

let exporting = false;
async function runExport({ format, scale, tabId }) {
  if (exporting) {
    notify({ busy: true, message: 'An export is already running…' });
    return;
  }
  exporting = true;
  clearBadge();
  try {
    const { dataUrl, cssW, cssH } = await captureDesignFromTab(tabId, format, scale);

    notify({ busy: true, message: 'Saving file…' });

    if (format === 'pdf') {
      const imgBytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
      const size = jpegSize(imgBytes) || { width: Math.round(cssW * scale), height: Math.round(cssH * scale) };
      const pdf = buildPdf(imgBytes, size.width, size.height, cssW, cssH);
      const pdfUrl = `data:application/pdf;base64,${uint8ToBase64(pdf)}`;
      await downloadDataUrl(pdfUrl, 'claude-design.pdf');
    } else {
      await downloadDataUrl(dataUrl, 'claude-design.png');
    }

    setBadge(true);
    notify({ busy: false, message: 'Saved! Check your downloads.', type: 'success' });
  } catch (e) {
    setBadge(false);
    notify({ busy: false, message: e.message || 'Export failed.', type: 'error' });
  } finally {
    exporting = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'export') {
    runExport(msg);
    sendResponse({ started: true });
  }
});
