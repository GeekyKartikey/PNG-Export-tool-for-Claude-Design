// Fast-path for SVG/canvas artifacts on regular claude.ai pages.
// claude.ai/design pages use HTML iframes — handled by the service worker instead.

function findDesignElement() {
  const prioritySelectors = [
    '[data-testid*="artifact"] svg',
    '[class*="artifact"] svg',
    '[class*="preview"] svg',
  ];
  for (const sel of prioritySelectors) {
    const el = document.querySelector(sel);
    if (el) return { el, type: 'svg' };
  }
  const svgs = Array.from(document.querySelectorAll('svg'))
    .filter(s => s.clientWidth > 100 && s.clientHeight > 100)
    .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  if (svgs.length) return { el: svgs[0], type: 'svg' };

  const canvases = Array.from(document.querySelectorAll('canvas'))
    .filter(c => c.width > 100 && c.height > 100)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  if (canvases.length) return { el: canvases[0], type: 'canvas' };

  return null;
}

function svgToCanvas(svgEl, scale) {
  const vb = svgEl.viewBox?.baseVal;
  const w = (vb?.width > 0 ? vb.width : null) || parseFloat(svgEl.getAttribute('width')) || svgEl.clientWidth || 800;
  const h = (vb?.height > 0 ? vb.height : null) || parseFloat(svgEl.getAttribute('height')) || svgEl.clientHeight || 600;
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', w); clone.setAttribute('height', h);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ canvas, width: w, height: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed.')); };
    img.src = url;
  });
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'exportPng' && msg.action !== 'exportPdf') return;
  (async () => {
    const found = findDesignElement();
    if (!found) { sendResponse({ success: false }); return; }
    try {
      const { canvas } = await svgToCanvas(found.el, msg.scale || 1);
      triggerDownload(canvas.toDataURL('image/png'), 'claude-design.png');
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});
