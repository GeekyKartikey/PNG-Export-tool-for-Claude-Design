// Captures the Claude Design artifact by attaching the Chrome Debugger to the
// already-open claude.ai tab and using Page.captureScreenshot. The browser-level
// compositor includes cross-origin / out-of-process iframes (the design lives in
// a sandboxed claudeusercontent.com iframe), so clipping to that iframe's rect
// yields the rendered design — no new tab, no viewport override.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ALLOWED_FORMATS = new Set(['png', 'pdf']);
const ALLOWED_SCALES = new Set([1, 2, 3]);
// Keep captures below roughly 128 MB of raw RGBA pixels before canvas copies.
const MAX_CAPTURE_PIXELS = 32_000_000;
const TRIM_PADDING_CSS_PX = 4;
const MIN_TRIM_AREA_RATIO = 0.02;
const MIN_TRIM_SIDE_RATIO = 0.08;

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

function validateExportMessage(msg) {
  if (!msg || msg.action !== 'export') {
    return { ok: false, error: 'Invalid export request.' };
  }
  if (!ALLOWED_FORMATS.has(msg.format)) {
    return { ok: false, error: 'Invalid export format.' };
  }
  if (!ALLOWED_SCALES.has(msg.scale)) {
    return { ok: false, error: 'Invalid export scale.' };
  }
  if (typeof msg.tabId !== 'number' || !Number.isFinite(msg.tabId)) {
    return { ok: false, error: 'Invalid export tab.' };
  }
  return {
    ok: true,
    request: { format: msg.format, scale: msg.scale, tabId: msg.tabId },
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

function flattenFrameTree(node, out = []) {
  if (!node) return out;
  if (node.frame) out.push(node.frame);
  for (const child of node.childFrames || []) flattenFrameTree(child, out);
  return out;
}

async function getClaudeFrameId(tabId, iframeSrc) {
  try {
    const { frameTree } = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
    const frames = flattenFrameTree(frameTree);
    const exact = frames.find(frame => frame.url === iframeSrc);
    if (exact) return exact.id;
    return frames.find(frame => isClaudeusercontentUrl(frame.url))?.id || null;
  } catch {
    return null;
  }
}

function isUsableArtboardRect(rect, iframeRect) {
  if (!rect || rect.width < 100 || rect.height < 100) return false;
  if (rect.x < -1 || rect.y < -1) return false;
  if (rect.x + rect.width > iframeRect.width + 1) return false;
  if (rect.y + rect.height > iframeRect.height + 1) return false;
  const fillsIframe = Math.abs(rect.x) < 2 && Math.abs(rect.y) < 2 &&
    Math.abs(rect.width - iframeRect.width) < 2 &&
    Math.abs(rect.height - iframeRect.height) < 2;
  if (fillsIframe) return false;
  const areaRatio = (rect.width * rect.height) / (iframeRect.width * iframeRect.height);
  return areaRatio >= MIN_TRIM_AREA_RATIO;
}

async function getArtboardRect(tabId, frameId, iframeRect) {
  if (!frameId) return null;
  try {
    const { executionContextId } = await chrome.debugger.sendCommand({ tabId }, 'Page.createIsolatedWorld', {
      frameId,
      worldName: 'claude-design-export',
      grantUniveralAccess: true,
    });
    const { result, exceptionDetails } = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      contextId: executionContextId,
      returnByValue: true,
      expression: `JSON.stringify((function(){
        const MIN_SIDE = 100;
        const selectors = [
          '[data-testid*="artboard" i]',
          '[data-testid*="canvas" i]',
          '[data-testid*="design" i]',
          '[aria-label*="artboard" i]',
          '[aria-label*="design" i]',
          '[class*="artboard" i]',
          '[class*="canvas" i]',
          '[class*="design" i]',
          'svg',
          'canvas'
        ];

        function rectFor(el, weight) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
          const r = el.getBoundingClientRect();
          if (r.width < MIN_SIDE || r.height < MIN_SIDE) return null;
          const area = r.width * r.height;
          const viewportMatch = Math.abs(r.left) < 2 && Math.abs(r.top) < 2 &&
            Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
          return {
            x: Math.floor(r.left),
            y: Math.floor(r.top),
            width: Math.ceil(r.width),
            height: Math.ceil(r.height),
            score: weight * 1e12 + area - (viewportMatch ? 1e10 : 0)
          };
        }

        const candidates = [];
        for (const selector of selectors) {
          let nodes = [];
          try { nodes = Array.from(document.querySelectorAll(selector)); } catch (_) {}
          const weight = /artboard|canvas|design/.test(selector) ? 3 : 2;
          for (const node of nodes) {
            const r = rectFor(node, weight);
            if (r) candidates.push(r);
          }
        }

        const bodyKids = Array.from(document.body ? document.body.children : []);
        const visibleKids = bodyKids.map(el => rectFor(el, 1)).filter(Boolean);
        if (visibleKids.length === 1) candidates.push({ ...visibleKids[0], score: visibleKids[0].score + 5e11 });
        if (visibleKids.length > 1 && visibleKids.length <= 30) {
          const minX = Math.min(...visibleKids.map(r => r.x));
          const minY = Math.min(...visibleKids.map(r => r.y));
          const maxX = Math.max(...visibleKids.map(r => r.x + r.width));
          const maxY = Math.max(...visibleKids.map(r => r.y + r.height));
          const width = Math.ceil(maxX - minX);
          const height = Math.ceil(maxY - minY);
          if (width >= MIN_SIDE && height >= MIN_SIDE) {
            const viewportMatch = Math.abs(minX) < 2 && Math.abs(minY) < 2 &&
              Math.abs(width - innerWidth) < 2 && Math.abs(height - innerHeight) < 2;
            candidates.push({
              x: Math.floor(minX),
              y: Math.floor(minY),
              width,
              height,
              score: 1.5e12 + width * height - (viewportMatch ? 1e10 : 0)
            });
          }
        }

        candidates.sort((a, b) => b.score - a.score);
        if (!candidates.length) return null;
        const best = candidates[0];
        return { x: best.x, y: best.y, width: best.width, height: best.height };
      })())`,
    });
    if (exceptionDetails || result?.value == null) return null;
    const rect = JSON.parse(result.value);
    return isUsableArtboardRect(rect, iframeRect) ? rect : null;
  } catch {
    return null;
  }
}

function artboardClip(iframeRect, artboardRect) {
  if (!artboardRect) return null;
  return {
    x: iframeRect.x + artboardRect.x,
    y: iframeRect.y + artboardRect.y,
    width: artboardRect.width,
    height: artboardRect.height,
  };
}

function assertCaptureSize(rect, scale) {
  const pixels = rect.width * rect.height * scale * scale;
  if (pixels > MAX_CAPTURE_PIXELS) {
    throw new Error('Export is too large. Try a lower scale or make the design smaller.');
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
  await chrome.debugger.attach({ tabId }, '1.3').catch((e) => {
    throw new Error('Could not attach to the tab (close DevTools if open): ' + (e.message || e));
  });
  try {
    notify({ busy: true, message: 'Finding design area…' });
    const rect = await getIframeRect(tabId);
    if (!rect || rect.width < 1 || rect.height < 1) {
      throw new Error('No design preview found. Open the design and let it finish rendering.');
    }
    const frameId = await getClaudeFrameId(tabId, rect.src);
    const artboardRect = await getArtboardRect(tabId, frameId, rect);
    const clip = artboardClip(rect, artboardRect) || rect;
    assertCaptureSize(clip, scale);

    await sleep(150); // let any in-progress paint settle

    notify({ busy: true, message: 'Capturing design…' });
    // Always capture lossless PNG: it's the source for both the PNG export and
    // (after trimming) the PDF's JPEG, so we never compound JPEG artifacts.
    // Resolution comes from clip.scale (NOT deviceScaleFactor), so the returned
    // image's TRUE pixel size is width*scale x height*scale.
    const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale },
    });
    const dataUrl = `data:image/png;base64,${data}`;

    if (await isMostlyBlank(dataUrl)) {
      throw new Error('Capture came back blank. Make sure the design is fully visible, then retry.');
    }

    return { dataUrl, usedDirectBounds: !!artboardRect };
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
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
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== 'export') return false;

  const validation = validateExportMessage(msg);
  if (!validation.ok) {
    notify({ busy: false, message: validation.error, type: 'error' });
    sendResponse({ started: false, error: validation.error });
    return false;
  }

  runExport(validation.request);
  sendResponse({ started: true });
  return false;
});
