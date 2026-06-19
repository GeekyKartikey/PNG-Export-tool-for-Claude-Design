// Runs in the offscreen document. Turns a data: URL into a blob: URL (the
// service worker can't call URL.createObjectURL), so chrome.downloads can save
// arbitrarily large files without hitting Chrome's data:-URL size limit.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return; // not for us — let other listeners handle it

  if (msg.cmd === 'blobUrl') {
    fetch(msg.dataUrl)
      .then((r) => r.blob())
      .then((blob) => sendResponse({ url: URL.createObjectURL(blob) }))
      .catch((e) => sendResponse({ error: e.message || String(e) }));
    return true; // async response
  }

  if (msg.cmd === 'revoke') {
    try { URL.revokeObjectURL(msg.url); } catch (_) {}
    sendResponse({ ok: true });
    return false;
  }
});
