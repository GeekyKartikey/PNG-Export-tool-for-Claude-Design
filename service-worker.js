// Captures the Claude Design artifact by locating the sandboxed
// claudeusercontent.com design URL, loading that raw document in a temporary
// inactive tab, and screenshotting the clean document rather than the visible
// Claude editor surface. Capturing the editor tab itself includes floating UI
// overlays such as Tweaks panels, so it can never be a reliable asset export.

const ALLOWED_FORMATS = new Set(['png', 'pdf']);
const ALLOWED_SCALES = new Set([1, 2, 3]);
// Keep captures below roughly 128 MB of raw RGBA pixels before canvas copies.
const MAX_CAPTURE_PIXELS = 32_000_000;
const TRIM_PADDING_CSS_PX = 4;
const MIN_TRIM_AREA_RATIO = 0.02;
const MIN_TRIM_SIDE_RATIO = 0.08;
const CAPTURE_TAB_LOAD_TIMEOUT_MS = 15000;

function isClaudeDesignUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' &&
      url.hostname === 'claude.ai' &&
      url.pathname.startsWith('/design/');
  } catch {
    return false;
  }
}

function isClaudeusercontentUrl(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return hostname === 'claudeusercontent.com' ||
      hostname.endsWith('.claudeusercontent.com');
  } catch {
    return false;
  }
}

let statusTabId = null;

function validateExportMessage(msg, sender) {
  if (!msg || msg.action !== 'export') {
    return { ok: false, error: 'Invalid export request.' };
  }
  if (!ALLOWED_FORMATS.has(msg.format)) {
    return { ok: false, error: 'Invalid export format.' };
  }
  if (!ALLOWED_SCALES.has(msg.scale)) {
    return { ok: false, error: 'Invalid export scale.' };
  }
  const tabId = typeof msg.tabId === 'number' ? msg.tabId : sender?.tab?.id;
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
    return { ok: false, error: 'Invalid export tab.' };
  }
  return {
    ok: true,
    request: { format: msg.format, scale: msg.scale, tabId },
  };
}

async function assertClaudeDesignTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isClaudeDesignUrl(tab.url)) {
    throw new Error('Open a Claude design first.');
  }
}

// Live status to the popup (ignored if closed) + persisted so a reopened popup
// can show the final result, and a badge so success/failure is visible regardless.
function notify(status) {
  chrome.runtime.sendMessage({ action: 'exportStatus', ...status }).catch(() => {});
  if (statusTabId != null) {
    chrome.tabs.sendMessage(statusTabId, { action: 'exportStatus', ...status }).catch(() => {});
  }
  chrome.storage.session.set({ lastStatus: status }).catch(() => {});
}
function setBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#27ae60' : '#c0392b' }).catch(() => {});
}
function clearBadge() {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

// Find the design iframe's rect in CSS px (page coordinates). Only
// claudeusercontent.com frames are eligible; unrelated iframes must fail closed.
async function getIframeRect(tabId) {
  const { result, exceptionDetails } = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `JSON.stringify((function(){
      const isClaudeusercontent = (src) => {
        try {
          const host = new URL(src, document.baseURI).hostname;
          return host === 'claudeusercontent.com' || host.endsWith('.claudeusercontent.com');
        } catch (_) {
          return false;
        }
      };
      const pool = Array.from(document.querySelectorAll('iframe'))
        .filter(f => isClaudeusercontent(f.src));
      const vis = pool
        .map(f => ({ frame: f, rect: f.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 100 && rect.height > 100)
        .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
      if (!vis.length) return null;
      const f = vis[0].frame;
      const r = vis[0].rect;
      return { x: Math.floor(r.left + window.scrollX),
               y: Math.floor(r.top  + window.scrollY),
               width:  Math.ceil(r.width),
               height: Math.ceil(r.height),
               src: f.src };
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

function assertCaptureSize(rect, scale) {
  const pixels = rect.width * rect.height * scale * scale;
  if (pixels > MAX_CAPTURE_PIXELS) {
    throw new Error('Export is too large. Try a lower scale or make the design smaller.');
  }
}

async function getDesignUrlFromClaudeTab(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3').catch((e) => {
    throw new Error('Could not inspect the Claude tab (close DevTools if open): ' + (e.message || e));
  });
  try {
    notify({ busy: true, message: 'Finding design document…' });
    const rect = await getIframeRect(tabId);
    if (!rect?.src || !isClaudeusercontentUrl(rect.src)) {
      throw new Error('No design preview found. Open the design and let it finish rendering.');
    }
    return rect.src;
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Timed out loading the design document.'));
    }, CAPTURE_TAB_LOAD_TIMEOUT_MS);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch((e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(e);
    });
  });
}

async function prepareRawDesignDocument(tabId) {
  // Print media is the closest match to Claude's own PDF/print export path and
  // usually hides editor-only controls. The extra DOM pass handles tweak panels
  // that remain mounted outside print styles.
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmulatedMedia', { media: 'print' }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async function(){
      const style = document.createElement('style');
      style.textContent = '@media screen, print { [data-testid*="tweak" i], [aria-label*="tweak" i] { display: none !important; } }';
      document.documentElement.appendChild(style);

      for (const el of Array.from(document.querySelectorAll('*'))) {
        const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (!text || !/\\bTweaks\\b/i.test(text)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width <= 800 && r.height <= 600) {
          el.style.setProperty('display', 'none', 'important');
        }
      }

      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready.catch(() => {});
      }
      await Promise.all(Array.from(document.images)
        .filter(img => !img.complete)
        .map(img => new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        })));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`,
  });
}

async function getRawDocumentClip(tabId) {
  const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
  const content = metrics.cssContentSize || metrics.contentSize;
  const clip = {
    x: Math.max(0, Math.floor(content?.x || 0)),
    y: Math.max(0, Math.floor(content?.y || 0)),
    width: Math.ceil(content?.width || 0),
    height: Math.ceil(content?.height || 0),
  };
  if (clip.width < 100 || clip.height < 100) {
    throw new Error('Could not determine the design document size.');
  }
  return clip;
}

async function captureRawDesignUrl(designUrl, scale) {
  if (!isClaudeusercontentUrl(designUrl)) {
    throw new Error('Invalid design document URL.');
  }

  notify({ busy: true, message: 'Opening clean design document…' });
  const tab = await chrome.tabs.create({ url: designUrl, active: false });
  let attached = false;
  try {
    await waitForTabComplete(tab.id);
    await chrome.debugger.attach({ tabId: tab.id }, '1.3').catch((e) => {
      throw new Error('Could not capture the design document: ' + (e.message || e));
    });
    attached = true;

    await prepareRawDesignDocument(tab.id);
    const clip = await getRawDocumentClip(tab.id);
    assertCaptureSize(clip, scale);

    notify({ busy: true, message: 'Capturing clean asset…' });
    const { data } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { ...clip, scale },
    });
    const dataUrl = `data:image/png;base64,${data}`;

    if (await isMostlyBlank(dataUrl)) {
      throw new Error('Capture came back blank. Make sure the design is fully loaded, then retry.');
    }

    return { dataUrl, usedDirectBounds: true };
  } finally {
    if (attached) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
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

async function captureDesignFromTab(tabId, scale) {
  const designUrl = await getDesignUrlFromClaudeTab(tabId);
  return captureRawDesignUrl(designUrl, scale);
}

// ---- Auto-trim ----
// The design iframe's element box is the whole preview pane — far larger than
// the rendered design, which sits in one corner on claude.ai's page background.
// A raw clip therefore leaves the design marooned in a sea of empty margin
// (~70% of the image in practice). We can't read the cross-origin iframe's DOM
// to find the design's true bounds, so we trim the uniform background border off
// the captured pixels instead. Returns an OffscreenCanvas cropped to the content
// (or the full image, if the border isn't uniform enough to trim safely).

// Bounding box of everything that differs from the dominant border color.
function contentBox(data, W, H) {
  // Background = the most common color along the 1px image border, quantized to
  // 5 bits/channel so anti-aliasing / compression noise falls into one bucket.
  const counts = new Map();
  const tally = (x, y) => {
    const i = (y * W + x) * 4;
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < W; x++) { tally(x, 0); tally(x, H - 1); }
  for (let y = 0; y < H; y++) { tally(0, y); tally(W - 1, y); }

  let bestKey = -1, best = 0, total = 0;
  for (const [k, c] of counts) { total += c; if (c > best) { best = c; bestKey = k; } }
  if (!total || best / total < 0.5) return null; // border not uniform — don't risk trimming

  const bgR = (((bestKey >> 10) & 31) << 3) + 4;
  const bgG = (((bestKey >> 5) & 31) << 3) + 4;
  const bgB = ((bestKey & 31) << 3) + 4;
  const TOL = 24; // per-channel; covers quantization + capture noise, well below design contrast

  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(data[i] - bgR) > TOL || Math.abs(data[i + 1] - bgG) > TOL || Math.abs(data[i + 2] - bgB) > TOL) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // entirely background
  return { minX, minY, maxX, maxY };
}

async function canvasFromDataUrl(dataUrl, willRead = false) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = willRead ?
    canvas.getContext('2d', { willReadFrequently: true }) :
    canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { canvas, pxW: W, pxH: H };
}

async function trimToContent(dataUrl, scale) {
  const full = await canvasFromDataUrl(dataUrl, true);
  const { canvas, pxW: W, pxH: H } = full;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let box = null;
  try { box = contentBox(ctx.getImageData(0, 0, W, H).data, W, H); } catch { /* keep full image */ }
  if (!box) return full;

  const pad = Math.max(2, Math.ceil(TRIM_PADDING_CSS_PX * scale));
  box = {
    minX: Math.max(0, box.minX - pad),
    minY: Math.max(0, box.minY - pad),
    maxX: Math.min(W - 1, box.maxX + pad),
    maxY: Math.min(H - 1, box.maxY + pad),
  };

  const cw = box.maxX - box.minX + 1, ch = box.maxY - box.minY + 1;
  if (cw >= W && ch >= H) return full; // nothing to trim
  if ((cw * ch) / (W * H) < MIN_TRIM_AREA_RATIO) return full;
  if (cw / W < MIN_TRIM_SIDE_RATIO || ch / H < MIN_TRIM_SIDE_RATIO) return full;

  const out = new OffscreenCanvas(cw, ch);
  out.getContext('2d').drawImage(canvas, box.minX, box.minY, cw, ch, 0, 0, cw, ch);
  return { canvas: out, pxW: cw, pxH: ch };
}

// Encode an OffscreenCanvas to a base64 data: URL (the worker has no
// canvas.toDataURL; convertToBlob + manual base64 is the worker-safe path).
async function canvasToDataUrl(canvas, type, quality) {
  const blob = await canvas.convertToBlob(quality == null ? { type } : { type, quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { dataUrl: `data:${type};base64,${uint8ToBase64(bytes)}`, bytes };
}

// ---- PDF (page size = design CSS dimensions; 1 CSS px = 1 PDF pt) ----

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
  statusTabId = tabId;
  clearBadge();
  try {
    await assertClaudeDesignTab(tabId);
    const { dataUrl: raw, usedDirectBounds } = await captureDesignFromTab(tabId, scale);

    let bounded;
    if (usedDirectBounds) {
      bounded = await canvasFromDataUrl(raw);
    } else {
      notify({ busy: true, message: 'Trimming margins…' });
      bounded = await trimToContent(raw, scale);
    }
    const { canvas, pxW, pxH } = bounded;

    notify({ busy: true, message: 'Saving file…' });

    if (format === 'pdf') {
      // JPEG-encode the trimmed canvas; canvas dims are authoritative, so the
      // XObject /Width /Height always match the stream. Page size (pt) = the
      // design's CSS size = pixel size / scale (1 CSS px = 1 pt).
      const { bytes } = await canvasToDataUrl(canvas, 'image/jpeg', 0.95);
      const pdf = buildPdf(bytes, pxW, pxH, Math.round(pxW / scale), Math.round(pxH / scale));
      const pdfUrl = `data:application/pdf;base64,${uint8ToBase64(pdf)}`;
      await downloadDataUrl(pdfUrl, 'claude-design.pdf');
    } else {
      const { dataUrl } = await canvasToDataUrl(canvas, 'image/png');
      await downloadDataUrl(dataUrl, 'claude-design.png');
    }

    setBadge(true);
    notify({ busy: false, message: 'Saved! Check your downloads.', type: 'success' });
  } catch (e) {
    setBadge(false);
    notify({ busy: false, message: e.message || 'Export failed.', type: 'error' });
  } finally {
    exporting = false;
    setTimeout(() => {
      if (statusTabId === tabId) statusTabId = null;
    }, 1000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action !== 'export') return false;

  const validation = validateExportMessage(msg, sender);
  if (!validation.ok) {
    notify({ busy: false, message: validation.error, type: 'error' });
    sendResponse({ started: false, error: validation.error });
    return false;
  }
  if (exporting) {
    const error = 'An export is already running.';
    notify({ busy: true, message: error });
    sendResponse({ started: false, error });
    return false;
  }

  runExport(validation.request);
  sendResponse({ started: true });
  return false;
});
