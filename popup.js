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
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Crop a screenshot dataUrl to the given CSS bounds, accounting for DPR and scale
async function cropScreenshot(screenshotDataUrl, bounds, scale) {
  const { left, top, width, height, dpr } = bounds;
  const img = await loadImage(screenshotDataUrl);

  const outW = Math.round(width * dpr * scale);
  const outH = Math.round(height * dpr * scale);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    img,
    left * dpr, top * dpr, width * dpr, height * dpr,
    0, 0, outW, outH
  );
  return canvas;
}

async function screenshotExport(tab, bounds, format, scale) {
  const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const canvas = await cropScreenshot(screenshotUrl, bounds, scale);

  if (format === 'pdf') {
    // Build PDF at original design dimensions (1pt per CSS pixel)
    const w = Math.round(bounds.width);
    const h = Math.round(bounds.height);
    const jpeg = canvas.toDataURL('image/jpeg', 0.95);
    const pdf = buildPdf(jpeg, canvas.width, canvas.height, w, h);
    triggerDownload(URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' })), 'claude-design.pdf');
  } else {
    triggerDownload(canvas.toDataURL('image/png'), 'claude-design.png');
  }
}

// Minimal dependency-free PDF builder: page is exactly w x h points (CSS px → pt 1:1)
function buildPdf(jpegDataUrl, imgW, imgH, ptW, ptH) {
  const imgBytes = Uint8Array.from(atob(jpegDataUrl.split(',')[1]), c => c.charCodeAt(0));
  const enc = new TextEncoder();
  const stream = `q\n${ptW}.00 0 0 ${ptH}.00 0 0 cm\n/img0 Do\nQ\n`;
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

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

async function runExport(format) {
  setBusy(true);
  setStatus('Looking for design…');
  const scale = parseInt(scaleSelect.value, 10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url?.includes('claude.ai')) {
      setStatus('Open claude.ai and create a design first.', 'error');
      return;
    }

    const action = format === 'pdf' ? 'exportPdf' : 'exportPng';
    const response = await chrome.tabs.sendMessage(tab.id, { action, scale });

    if (response?.success) {
      setStatus('Saved! Check your downloads.', 'success');
      return;
    }

    // SVG/canvas not found — fall back to screenshot crop
    if (response?.needsScreenshot && response?.bounds) {
      setStatus('Capturing design…');
      await screenshotExport(tab, response.bounds, format, scale);
      setStatus('Saved! Check your downloads.', 'success');
      return;
    }

    setStatus(response?.error || 'No design found on this page.', 'error');
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

pngBtn.addEventListener('click', () => runExport('png'));
pdfBtn.addEventListener('click', () => runExport('pdf'));
