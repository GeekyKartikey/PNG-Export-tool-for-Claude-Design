// Fast-path: find SVG or Canvas for non-HTML artifact designs
function findDesignElement() {
  const prioritySelectors = [
    '[data-testid*="artifact"] svg',
    '[class*="artifact"] svg',
    '[class*="preview"] svg',
    '[class*="render"] svg',
  ];
  for (const sel of prioritySelectors) {
    const el = document.querySelector(sel);
    if (el) return { el, type: 'svg' };
  }

  const allSvgs = Array.from(document.querySelectorAll('svg'))
    .filter(s => s.clientWidth > 100 && s.clientHeight > 100)
    .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  if (allSvgs.length > 0) return { el: allSvgs[0], type: 'svg' };

  const allCanvases = Array.from(document.querySelectorAll('canvas'))
    .filter(c => c.width > 100 && c.height > 100)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  if (allCanvases.length > 0) return { el: allCanvases[0], type: 'canvas' };

  return null;
}

function getSvgDimensions(svgEl) {
  const vb = svgEl.viewBox?.baseVal;
  return {
    width:  (vb?.width  > 0 ? vb.width  : null) || parseFloat(svgEl.getAttribute('width'))  || svgEl.clientWidth  || 800,
    height: (vb?.height > 0 ? vb.height : null) || parseFloat(svgEl.getAttribute('height')) || svgEl.clientHeight || 600,
  };
}

function svgToCanvas(svgEl, scale) {
  const { width, height } = getSvgDimensions(svgEl);
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);

  const pageStyles = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');
  if (pageStyles) {
    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = pageStyles;
    clone.insertBefore(styleEl, clone.firstChild);
  }

  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
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
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed.')); };
    img.src = url;
  });
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

async function tryDirectExport(action, scale) {
  const found = findDesignElement();
  if (!found) return { success: false, needsFrameCapture: true };

  try {
    let dataUrl, width, height;
    if (found.type === 'svg') {
      const r = await svgToCanvas(found.el, scale);
      dataUrl = r.canvas.toDataURL('image/png');
      width = r.width; height = r.height;
    } else {
      dataUrl = found.el.toDataURL('image/png');
      width = found.el.width; height = found.el.height;
    }

    if (action === 'exportPdf') {
      return { success: false, needsFrameCapture: true }; // let popup build PDF
    }
    triggerDownload(dataUrl, 'claude-design.png');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'exportPng' || msg.action === 'exportPdf') {
    tryDirectExport(msg.action, msg.scale || 1).then(sendResponse);
    return true;
  }
});
