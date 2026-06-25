// Captures the Claude Design document from the claudeusercontent.com iframe's
// own debugger target. Capturing the parent Claude tab only sees the currently
// visible iframe viewport, so full-artboard export must happen inside the frame.

const ALLOWED_FORMATS = new Set(['png', 'pdf']);
const ALLOWED_SCALES = new Set([1, 2, 3]);
// Keep captures below roughly 128 MB of raw RGBA pixels before canvas copies.
const MAX_CAPTURE_PIXELS = 32_000_000;
const TRIM_PADDING_CSS_PX = 4;
const MIN_TRIM_AREA_RATIO = 0.02;
const MIN_TRIM_SIDE_RATIO = 0.08;
const DEBUGGER_COMMAND_TIMEOUT_MS = 10000;
const SCREENSHOT_TIMEOUT_MS = 15000;
const DESIGN_READY_TIMEOUT_MS = 5000;
const CAPTURE_STYLE_ID = 'claude-png-export-capture-style';
const CAPTURE_HIDDEN_ATTR = 'data-claude-png-export-hidden-visibility';
const FRAME_PREPARE_ACTION = 'claudePngPrepareFrameCapture';
const FRAME_RESTORE_ACTION = 'claudePngRestoreFrameCapture';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function debuggerTarget(target) {
  return typeof target === 'number' ? { tabId: target } : target;
}

function debuggerCommand(target, method, params = {}, timeoutMs = DEBUGGER_COMMAND_TIMEOUT_MS) {
  return withTimeout(
    chrome.debugger.sendCommand(debuggerTarget(target), method, params),
    timeoutMs,
    method
  );
}

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

function urlsMatch(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
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
  const { result, exceptionDetails } = await debuggerCommand(tabId, 'Runtime.evaluate', {
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

async function notifyFrameCaptureScripts(tabId, action) {
  await withTimeout(
    chrome.tabs.sendMessage(tabId, { action }).catch(() => {}),
    DESIGN_READY_TIMEOUT_MS + 1000,
    'Frame capture cleanup'
  ).catch(() => {});
}

function pickClaudeTarget(items, iframeSrc) {
  const candidates = Array.from(items || [])
    .filter(item => item?.url && isClaudeusercontentUrl(item.url));
  return candidates.find(item => urlsMatch(item.url, iframeSrc)) ||
    candidates.find(item => iframeSrc && item.url === iframeSrc) ||
    candidates[0] ||
    null;
}

async function attachClaudeFrameSession(tabId, iframeSrc) {
  const attached = [];
  function remember(sessionId, targetInfo) {
    if (!sessionId || !targetInfo?.url || !isClaudeusercontentUrl(targetInfo.url)) return;
    attached.push({ sessionId, url: targetInfo.url, targetInfo });
  }

  function onEvent(source, method, params) {
    if (source.tabId !== tabId || method !== 'Target.attachedToTarget') return;
    remember(params?.sessionId, params?.targetInfo);
    if (params?.sessionId) {
      const child = { ...source, sessionId: params.sessionId };
      debuggerCommand(child, 'Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  }

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    const autoAttachParams = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    };
    await debuggerCommand(tabId, 'Target.setAutoAttach', autoAttachParams)
      .catch(() => debuggerCommand(tabId, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }));
    await sleep(300);

    const chosen = pickClaudeTarget(attached, iframeSrc);
    if (chosen) {
      return { tabId, sessionId: chosen.sessionId };
    }

    const targets = await debuggerCommand(tabId, 'Target.getTargets', {
      filter: [{ type: 'iframe', exclude: false }],
    }).catch(() => debuggerCommand(tabId, 'Target.getTargets').catch(() => null));
    const targetInfo = pickClaudeTarget(targets?.targetInfos, iframeSrc);
    const targetId = targetInfo?.targetId || targetInfo?.id;
    if (!targetId) return null;

    const { sessionId } = await debuggerCommand(tabId, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    return sessionId ? { tabId, sessionId } : null;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

async function installFrameCaptureMask(target) {
  await debuggerCommand(target, 'Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async function(){
      const STYLE_ID = ${JSON.stringify(CAPTURE_STYLE_ID)};
      const HIDE_ATTR = ${JSON.stringify(CAPTURE_HIDDEN_ATTR)};
      document.getElementById(STYLE_ID)?.remove();
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '[data-testid*="tweak" i] { visibility: hidden !important; }',
        '[aria-label*="tweak" i] { visibility: hidden !important; }',
        '[class*="tweak" i] { visibility: hidden !important; }',
        '[role="dialog"] { visibility: hidden !important; }',
        '[data-radix-popper-content-wrapper] { visibility: hidden !important; }'
      ].join('\\n');
      document.documentElement.appendChild(style);

      function hide(el) {
        if (!el || el.hasAttribute(HIDE_ATTR)) return;
        el.setAttribute(HIDE_ATTR, el.style.visibility || '');
        el.style.setProperty('visibility', 'hidden', 'important');
      }
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (!/\\bTweaks\\b/i.test(text)) continue;
        let panel = el;
        while (panel.parentElement) {
          const r = panel.getBoundingClientRect();
          if (r.width >= 180 && r.height >= 80 && r.width <= 1000 && r.height <= 800) break;
          panel = panel.parentElement;
        }
        hide(panel);
      }

      if (document.fonts && document.fonts.ready) {
        await Promise.race([
          document.fonts.ready.catch(() => {}),
          new Promise(resolve => setTimeout(resolve, ${DESIGN_READY_TIMEOUT_MS}))
        ]);
      }
      await Promise.race([
        Promise.all(Array.from(document.images)
          .filter(img => !img.complete)
          .map(img => new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }))),
        new Promise(resolve => setTimeout(resolve, ${DESIGN_READY_TIMEOUT_MS}))
      ]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`,
  }, DEBUGGER_COMMAND_TIMEOUT_MS + DESIGN_READY_TIMEOUT_MS);
}

async function restoreFrameCaptureMask(target) {
  if (!target) return;
  await debuggerCommand(target, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(function(){
      const STYLE_ID = ${JSON.stringify(CAPTURE_STYLE_ID)};
      const HIDE_ATTR = ${JSON.stringify(CAPTURE_HIDDEN_ATTR)};
      document.getElementById(STYLE_ID)?.remove();
      for (const el of Array.from(document.querySelectorAll('[' + HIDE_ATTR + ']'))) {
        const old = el.getAttribute(HIDE_ATTR);
        el.removeAttribute(HIDE_ATTR);
        if (old) el.style.visibility = old;
        else el.style.removeProperty('visibility');
      }
      return true;
    })()`,
  }).catch(() => {});
}

async function getFrameDocumentClip(target) {
  await debuggerCommand(target, 'Page.enable').catch(() => {});
  const { result, exceptionDetails } = await debuggerCommand(target, 'Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `JSON.stringify((function(){
      const doc = document.documentElement;
      const body = document.body;
      const scroller = document.scrollingElement || doc || body;
      const baseWidth = Math.max(
        window.innerWidth || 0,
        doc?.clientWidth || 0,
        doc?.scrollWidth || 0,
        doc?.offsetWidth || 0,
        body?.clientWidth || 0,
        body?.scrollWidth || 0,
        body?.offsetWidth || 0,
        scroller?.scrollWidth || 0
      );
      const baseHeight = Math.max(
        window.innerHeight || 0,
        doc?.clientHeight || 0,
        doc?.scrollHeight || 0,
        doc?.offsetHeight || 0,
        body?.clientHeight || 0,
        body?.scrollHeight || 0,
        body?.offsetHeight || 0,
        scroller?.scrollHeight || 0
      );

      let minX = 0;
      let minY = 0;
      let maxX = baseWidth;
      let maxY = baseHeight;
      for (const el of Array.from(document.body?.querySelectorAll('*') || [])) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const x1 = rect.left + window.scrollX;
        const y1 = rect.top + window.scrollY;
        const x2 = rect.right + window.scrollX;
        const y2 = rect.bottom + window.scrollY;
        if (!Number.isFinite(x1 + y1 + x2 + y2)) continue;
        if (x2 < -10000 || y2 < -10000 || x1 > 100000 || y1 > 100000) continue;
        minX = Math.min(minX, x1);
        minY = Math.min(minY, y1);
        maxX = Math.max(maxX, x2);
        maxY = Math.max(maxY, y2);
      }

      const x = Math.max(0, Math.floor(minX));
      const y = Math.max(0, Math.floor(minY));
      return {
        x,
        y,
        width: Math.ceil(maxX - x),
        height: Math.ceil(maxY - y)
      };
    })())`,
  });

  if (exceptionDetails) {
    throw new Error('Could not measure the design document: ' +
      (exceptionDetails.exception?.description || exceptionDetails.text || 'in-frame evaluation threw'));
  }

  const clip = JSON.parse(result.value);
  if (!clip || clip.width < 100 || clip.height < 100) {
    throw new Error('Could not determine the full design size.');
  }
  return clip;
}

async function captureScreenshotDataUrl(target, clip, scale) {
  const { data } = await debuggerCommand(target, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
    clip: { ...clip, scale },
  }, SCREENSHOT_TIMEOUT_MS);
  return `data:image/png;base64,${data}`;
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

  let frameSession = null;
  try {
    notify({ busy: true, message: 'Finding design document…' });
    const rect = await getIframeRect(tabId);
    if (!rect?.src || !isClaudeusercontentUrl(rect.src)) {
      throw new Error('No design preview found. Open the design and let it finish rendering.');
    }

    notify({ busy: true, message: 'Attaching to design frame…' });
    frameSession = await attachClaudeFrameSession(tabId, rect.src);
    if (!frameSession) {
      throw new Error('Could not attach to the Claude design frame. Update Chrome, reload the extension, and try again.');
    }

    notify({ busy: true, message: 'Preparing full artboard…' });
    await notifyFrameCaptureScripts(tabId, FRAME_PREPARE_ACTION);
    await installFrameCaptureMask(frameSession).catch(() => {});
    await sleep(150);
    const clip = await getFrameDocumentClip(frameSession);
    assertCaptureSize(clip, scale);

    notify({ busy: true, message: 'Capturing full artboard…' });
    const dataUrl = await captureScreenshotDataUrl(frameSession, clip, scale);
    if (await isMostlyBlank(dataUrl)) {
      throw new Error('Capture came back blank. Make sure the design is fully loaded, then retry.');
    }

    return { dataUrl, usedDirectBounds: true };
  } finally {
    await restoreFrameCaptureMask(frameSession);
    await notifyFrameCaptureScripts(tabId, FRAME_RESTORE_ACTION);
    if (frameSession?.sessionId) {
      await debuggerCommand(tabId, 'Target.detachFromTarget', { sessionId: frameSession.sessionId }).catch(() => {});
    }
    await debuggerCommand(tabId, 'Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => {});
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// ---- Auto-trim ----
// Direct frame-target capture normally uses the frame document size and skips
// trimming. This conservative pixel trim remains available for future fallbacks:
// it only removes uniform border/background pixels when doing so looks safe.

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
