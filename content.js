// Find the best design element (SVG or Canvas) on the page
function findDesignElement() {
  const prioritySelectors = [
    '[data-testid*="artifact"] svg',
    '[class*="artifact"] svg',
    '[class*="preview"] svg',
    '[class*="render"] svg',
    '[class*="design"] svg',
  ];

  for (const sel of prioritySelectors) {
    const el = document.querySelector(sel);
    if (el) return { el, type: 'svg' };
  }

  // Find largest SVG on the page (skip tiny icons)
  const allSvgs = Array.from(document.querySelectorAll('svg'))
    .filter(s => s.clientWidth > 100 && s.clientHeight > 100)
    .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));

  if (allSvgs.length > 0) return { el: allSvgs[0], type: 'svg' };

  // Find largest Canvas
  const allCanvases = Array.from(document.querySelectorAll('canvas'))
    .filter(c => c.width > 100 && c.height > 100)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));

  if (allCanvases.length > 0) return { el: allCanvases[0], type: 'canvas' };

  // Try accessible iframes
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const doc = iframe.contentDocument;
      if (!doc) continue;
      const svg = doc.querySelector('svg');
      if (svg && svg.clientWidth > 100) return { el: svg, type: 'svg' };
      const canvas = doc.querySelector('canvas');
      if (canvas && canvas.width > 100) return { el: canvas, type: 'canvas' };
    } catch (_) { /* cross-origin, skip */ }
  }

  return null;
}

function getSvgDimensions(svgEl) {
  const viewBox = svgEl.viewBox?.baseVal;
  const width = (viewBox?.width > 0 ? viewBox.width : null)
    || parseFloat(svgEl.getAttribute('width'))
    || svgEl.clientWidth
    || 800;
  const height = (viewBox?.height > 0 ? viewBox.height : null)
    || parseFloat(svgEl.getAttribute('height'))
    || svgEl.clientHeight
    || 600;
  return { width, height };
}

function svgToCanvas(svgEl, scale) {
  const { width, height } = getSvgDimensions(svgEl);

  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);

  // Inline page styles so fonts/colors render correctly
  const pageStyles = Array.from(document.querySelectorAll('style'))
    .map(s => s.textContent).join('\n');
  if (pageStyles) {
    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = pageStyles;
    clone.insertBefore(styleEl, clone.firstChild);
  }

  const svgStr = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ canvas, width, height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to render SVG — it may contain external resources.'));
    };
    img.src = url;
  });
}

// Build a minimal valid PDF containing one JPEG image at the design's exact dimensions.
// 1px = 1pt so the PDF page matches the design's logical size exactly — no A4, no templates.
function buildPdf(jpegDataUrl, pxW, pxH) {
  const ptW = pxW.toFixed(2);
  const ptH = pxH.toFixed(2);
  const imgBytes = Uint8Array.from(atob(jpegDataUrl.split(',')[1]), c => c.charCodeAt(0));
  const enc = new TextEncoder();

  const stream = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/img0 Do\nQ\n`;

  const o1 = enc.encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const o2 = enc.encode('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  const o3 = enc.encode(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R\n` +
    `   /MediaBox [0 0 ${ptW} ${ptH}]\n` +
    `   /Contents 4 0 R\n` +
    `   /Resources << /XObject << /img0 5 0 R >> >> >>\nendobj\n`
  );
  const o4 = enc.encode(
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`
  );
  const o5h = enc.encode(
    `5 0 obj\n<< /Type /XObject /Subtype /Image\n` +
    `   /Width ${pxW} /Height ${pxH}\n` +
    `   /ColorSpace /DeviceRGB /BitsPerComponent 8\n` +
    `   /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`
  );
  const o5f = enc.encode('\nendstream\nendobj\n');
  const hdr = enc.encode('%PDF-1.4\n');

  let off = hdr.length;
  const x1 = off; off += o1.length;
  const x2 = off; off += o2.length;
  const x3 = off; off += o3.length;
  const x4 = off; off += o4.length;
  const x5 = off; off += o5h.length + imgBytes.length + o5f.length;

  const xref = enc.encode(
    'xref\n0 6\n0000000000 65535 f \n' +
    `${String(x1).padStart(10, '0')} 00000 n \n` +
    `${String(x2).padStart(10, '0')} 00000 n \n` +
    `${String(x3).padStart(10, '0')} 00000 n \n` +
    `${String(x4).padStart(10, '0')} 00000 n \n` +
    `${String(x5).padStart(10, '0')} 00000 n \n`
  );
  const trailer = enc.encode(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF`);

  const parts = [hdr, o1, o2, o3, o4, o5h, imgBytes, o5f, xref, trailer];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function exportPng(scale = 1) {
  const found = findDesignElement();
  if (!found) {
    return { success: false, error: 'No design found. Make sure a Claude Design artifact is visible.' };
  }

  try {
    let dataUrl;
    if (found.type === 'svg') {
      const { canvas } = await svgToCanvas(found.el, scale);
      dataUrl = canvas.toDataURL('image/png');
    } else {
      dataUrl = found.el.toDataURL('image/png');
    }
    triggerDownload(dataUrl, 'claude-design.png');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function exportPdf() {
  const found = findDesignElement();
  if (!found) {
    return { success: false, error: 'No design found. Make sure a Claude Design artifact is visible.' };
  }

  try {
    let jpegDataUrl, width, height;

    if (found.type === 'svg') {
      const result = await svgToCanvas(found.el, 1);
      width = result.width;
      height = result.height;
      // Re-draw onto a white canvas to get a clean JPEG (no alpha channel issues)
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(result.canvas, 0, 0);
      jpegDataUrl = c.toDataURL('image/jpeg', 0.95);
    } else {
      width = found.el.width;
      height = found.el.height;
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(found.el, 0, 0);
      jpegDataUrl = c.toDataURL('image/jpeg', 0.95);
    }

    const pdfBytes = buildPdf(jpegDataUrl, width, height);
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, 'claude-design.pdf');
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'exportPng') {
    exportPng(msg.scale || 1).then(sendResponse);
    return true;
  }
  if (msg.action === 'exportPdf') {
    exportPdf().then(sendResponse);
    return true;
  }
});
