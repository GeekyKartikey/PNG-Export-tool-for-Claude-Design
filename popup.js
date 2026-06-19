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
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// Find the iframe that holds the Claude Design HTML file
async function findDesignFrame(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const subframes = frames.filter(f => f.parentFrameId !== -1 && f.url && f.url !== 'about:blank');
  if (!subframes.length) return null;
  // Prefer frames whose URL contains .dc.html or /design/
  subframes.sort((a, b) => {
    const score = f => (f.url.includes('.dc.html') ? 2 : f.url.includes('/design/') ? 1 : 0);
    return score(b) - score(a);
  });
  return subframes[0];
}

// Inject html2canvas into the target frame and capture the full document
async function captureFrame(tabId, frameId, scale) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ['html2canvas.min.js'],
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: async (pixelScale) => {
      const root = document.documentElement;
      const w = Math.max(root.scrollWidth, root.clientWidth, document.body?.scrollWidth || 0);
      const h = Math.max(root.scrollHeight, root.clientHeight, document.body?.scrollHeight || 0);
      const canvas = await window.html2canvas(root, {
        width: w, height: h,
        windowWidth: w, windowHeight: h,
        scale: pixelScale,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#ffffff',
      });
      return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
    },
    args: [scale],
  });

  return results[0].result; // { dataUrl, width, height }
}

// Build PDF with page dimensions exactly matching the design (1 CSS px = 1 PDF pt)
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

async function runExport(format) {
  setBusy(true);
  setStatus('Looking for design…');
  const scale = parseInt(scaleSelect.value, 10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url?.includes('claude.ai')) {
      setStatus('Open claude.ai first.', 'error');
      return;
    }

    // 1. Try SVG/canvas fast-path via content script
    const direct = await chrome.tabs.sendMessage(tab.id, { action: format === 'pdf' ? 'exportPdf' : 'exportPng', scale });
    if (direct?.success) {
      setStatus('Saved! Check your downloads.', 'success');
      return;
    }

    // 2. HTML design — inject html2canvas into the design iframe and read the file directly
    setStatus('Reading design file…');
    const frame = await findDesignFrame(tab.id);
    if (!frame) {
      setStatus('No design frame found. Make sure the design is fully loaded.', 'error');
      return;
    }

    const { dataUrl, width, height } = await captureFrame(tab.id, frame.frameId, scale);

    if (format === 'pdf') {
      // Convert PNG → JPEG for embedding in PDF
      const img = await loadImage(dataUrl);
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      const jpeg = c.toDataURL('image/jpeg', 0.95);
      const pdf = buildPdf(jpeg, c.width, c.height, width, height);
      triggerDownload(URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' })), 'claude-design.pdf');
    } else {
      triggerDownload(dataUrl, 'claude-design.png');
    }

    setStatus('Saved! Check your downloads.', 'success');
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
