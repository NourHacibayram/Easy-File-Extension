chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'READ_CLIPBOARD') {
    readClipboardImage()
      .then(result => {
        console.log('[Offscreen] readClipboardImage resolved with:', result ? 'image data' : 'null');
        sendResponse({ success: true, image: result });
      })
      .catch(err => {
        console.error('[Offscreen] readClipboardImage rejected with:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }
});

async function readClipboardImage() {
  console.log('[Offscreen] Reading clipboard...');
  // Strategy 1: navigator.clipboard.read()
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      console.log('[Offscreen] navigator.clipboard.read succeeded, items count:', items.length);
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const dataUrl = await blobToDataURL(blob);
            const meta = await getImageDimensions(dataUrl);
            console.log('[Offscreen] Found image via Strategy 1:', type);
            return {
              id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
              dataUrl: dataUrl,
              mimeType: type,
              width: meta.width,
              height: meta.height,
              size: blob.size,
              timestamp: Date.now()
            };
          }
        }
      }
    } catch (err) {
      console.warn('[Offscreen] navigator.clipboard.read failed:', err);
    }
  }

  // Strategy 2: ExecCommand paste on focused contenteditable div or textarea
  console.log('[Offscreen] Falling back to Strategy 2 (execCommand)...');
  return new Promise((resolve) => {
    // We create a temporary textarea to ensure it gets focus cleanly
    const textarea = document.createElement('textarea');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '10px';
    textarea.style.height = '10px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);

    let settled = false;
    let timeoutId;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      textarea.removeEventListener('paste', onPaste);
      textarea.remove();
      resolve(result);
    };

    const onPaste = async (e) => {
      console.log('[Offscreen] Paste event fired');
      if (!e.clipboardData || !e.clipboardData.items) {
        console.warn('[Offscreen] Paste event has no clipboardData');
        return finish(null);
      }

      console.log('[Offscreen] Paste event items count:', e.clipboardData.items.length);
      for (const item of e.clipboardData.items) {
        console.log('[Offscreen] Paste item type:', item.type);
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            const dataUrl = await blobToDataURL(blob);
            const meta = await getImageDimensions(dataUrl);
            console.log('[Offscreen] Found image via Strategy 2:', item.type);
            return finish({
              id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
              dataUrl: dataUrl,
              mimeType: item.type,
              width: meta.width,
              height: meta.height,
              size: blob.size,
              timestamp: Date.now()
            });
          }
        }
      }
      finish(null);
    };

    textarea.addEventListener('paste', onPaste);
    // execCommand may report success without dispatching a paste event.
    timeoutId = setTimeout(() => finish(null), 500);

    try {
      window.focus();
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('paste');
      console.log('[Offscreen] execCommand paste return value:', ok);
      if (!ok) {
        finish(null);
      }
    } catch (err) {
      console.error('[Offscreen] execCommand paste threw error:', err);
      finish(null);
    }
  });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}
