const MAX_CLIPBOARD_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_STORED_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_STORED_DATA_URL_LENGTH = Math.ceil(MAX_STORED_IMAGE_BYTES * 4 / 3) + 1024;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'READ_CLIPBOARD') {
    readClipboardImage()
      .then(result => {
        sendResponse({ success: true, image: result });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  if (message.action === 'CREATE_THUMBNAIL') {
    createThumbnail(message.dataUrl)
      .then((thumbnailDataUrl) => sendResponse({ success: true, thumbnailDataUrl }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

async function readClipboardImage() {
  // Strategy 1: navigator.clipboard.read()
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            if (blob.size > MAX_CLIPBOARD_SOURCE_BYTES) return null;
            return prepareClipboardImage(blob, type);
          }
        }
      }
    } catch (err) {
      // Expected in offscreen document contexts; fall back to execCommand Strategy 2
    }
  }

  // Strategy 2: ExecCommand paste on focused contenteditable div or textarea
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
      if (!e.clipboardData || !e.clipboardData.items) {
        return finish(null);
      }

      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            clearTimeout(timeoutId);
            if (blob.size > MAX_CLIPBOARD_SOURCE_BYTES) return finish(null);
            try {
              return finish(await prepareClipboardImage(blob, item.type));
            } catch (error) {
              return finish(null);
            }
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
      if (!ok) {
        finish(null);
      }
    } catch (err) {
      finish(null);
    }
  });
}

async function prepareClipboardImage(blob, sourceMimeType) {
  const rawDataUrl = await blobToDataURL(blob);
  let prepared;
  if (rawDataUrl.length <= MAX_STORED_DATA_URL_LENGTH) {
    prepared = { dataUrl: rawDataUrl, mimeType: sourceMimeType, ...(await getImageDimensions(rawDataUrl)) };
  } else {
    prepared = await compressImage(rawDataUrl);
  }
  if (!prepared || prepared.dataUrl.length > MAX_STORED_DATA_URL_LENGTH) return null;
  return {
    id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    dataUrl: prepared.dataUrl,
    mimeType: prepared.mimeType,
    width: prepared.width,
    height: prepared.height,
    size: Math.round(prepared.dataUrl.length * 0.75),
    timestamp: Date.now()
  };
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0
    });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = dataUrl;
  });
}

function createThumbnail(dataUrl, maxDimension = 240) {
  return new Promise((resolve, reject) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      reject(new Error('Invalid image preview source.'));
      return;
    }
    const image = new Image();
    image.onload = () => {
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      if (!sourceWidth || !sourceHeight) {
        reject(new Error('Image dimensions are unavailable.'));
        return;
      }
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas is unavailable.'));
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Could not encode image preview.'));
          return;
        }
        blobToDataURL(blob).then(resolve, reject);
      }, 'image/webp', 0.72);
    };
    image.onerror = () => reject(new Error('Could not decode image preview.'));
    image.src = dataUrl;
  });
}

function compressImage(dataUrl, maxDim = 1200, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    const sourceMimeType = dataUrl.match(/^data:([^;,]+)/i)?.[1] || 'image/png';
    img.onload = () => {
      try {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas is unavailable.');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(async (blob) => {
          if (!blob) {
            resolve({ dataUrl, mimeType: sourceMimeType, width, height });
            return;
          }
          try {
            resolve({
              dataUrl: await blobToDataURL(blob),
              mimeType: blob.type || 'image/webp',
              width,
              height
            });
          } catch (error) {
            resolve({ dataUrl, mimeType: sourceMimeType, width, height });
          }
        }, 'image/webp', quality);
      } catch (error) {
        resolve({ dataUrl, mimeType: sourceMimeType, width: 0, height: 0 });
      }
    };
    img.onerror = () => resolve({ dataUrl, mimeType: sourceMimeType, width: 0, height: 0 });
    img.src = dataUrl;
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
