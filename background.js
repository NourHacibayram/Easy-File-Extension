const MAX_IMAGES = 25;

// Ensure storage initialized on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['clipboardImages'], (result) => {
    if (!result.clipboardImages) {
      chrome.storage.local.set({ clipboardImages: [] });
    }
  });
  updateBadge();
});

// Update badge with current stored image count
async function updateBadge() {
  const data = await chrome.storage.local.get(['clipboardImages']);
  const count = (data.clipboardImages || []).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4F46E5' });
}

// Offscreen document helper
let creatingOffscreen;
async function hasOffscreenDocument(path) {
  if ('getContexts' in chrome.runtime) {
    const documentUrl = chrome.runtime.getURL(path);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl]
    });
    return contexts.length > 0;
  }
  return false;
}

async function setupOffscreenDocument(path) {
  if (await hasOffscreenDocument(path)) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
        url: path,
        reasons: ['CLIPBOARD'],
        justification: 'Read image data from clipboard'
      })
      .catch((err) => {
        // A previous service-worker instance may already have created it.
        if (!String(err && err.message).toLowerCase().includes('single offscreen')) {
          throw err;
        }
      })
      .finally(() => {
        creatingOffscreen = null;
      });
    await creatingOffscreen;
  }
}

// Auto-sync clipboard on focus change & tab switch
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    autoCheckClipboard();
  }
});

chrome.tabs.onActivated.addListener(() => {
  autoCheckClipboard();
});

// Periodic background auto-check
setInterval(() => {
  chrome.windows.getCurrent((win) => {
    if (win && win.focused) {
      autoCheckClipboard();
    }
  });
}, 3000);

let clipboardCheckPromise = null;
function autoCheckClipboard() {
  if (clipboardCheckPromise) return clipboardCheckPromise;

  clipboardCheckPromise = performClipboardCheck().finally(() => {
    clipboardCheckPromise = null;
  });
  return clipboardCheckPromise;
}

async function performClipboardCheck() {
  try {
    await setupOffscreenDocument('offscreen.html');
    let res;
    let attempts = 0;
    while (attempts < 3) {
      try {
        res = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'READ_CLIPBOARD'
        });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 3) throw err;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (res && res.success && res.image) {
      const saved = await saveImage(res.image);
      await updateBadge();
      return { found: true, saved };
    }
    return { found: false, saved: false };
  } catch (err) {
    return { found: false, saved: false, error: err.message };
  }
}

// Helper to determine file icon category
function getFileTypeCategory(ext, mime) {
  ext = (ext || '').toLowerCase();
  mime = (mime || '').toLowerCase();

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext) || mime.startsWith('image/')) return 'image';
  if (['pdf'].includes(ext) || mime.includes('pdf')) return 'pdf';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext) || mime.startsWith('video/')) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext) || mime.startsWith('audio/')) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || mime.includes('zip') || mime.includes('compressed')) return 'archive';
  if (['exe', 'msi', 'bat', 'cmd'].includes(ext)) return 'exe';
  return 'file';
}

function getMimeFromExt(ext) {
  const mimes = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    zip: 'application/zip',
    txt: 'text/plain',
    json: 'application/json'
  };
  return mimes[ext.toLowerCase()] || 'application/octet-stream';
}

// Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'AUTO_CHECK_CLIPBOARD') {
    autoCheckClipboard()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'SAVE_IMAGE') {
    saveImage(message.image)
      .then(saved => {
        updateBadge();
        sendResponse({ success: true, saved });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'GET_IMAGES') {
    chrome.storage.local.get(['clipboardImages'], (data) => {
      sendResponse({ success: true, images: data.clipboardImages || [] });
    });
    return true;
  }

  if (message.action === 'GET_RECENT_DOWNLOADS') {
    if (chrome.downloads && chrome.downloads.search) {
      chrome.downloads.search({ state: 'complete', limit: 12, orderBy: ['-startTime'] }, (items) => {
        if (chrome.runtime.lastError || !items) {
          return sendResponse({ success: false, downloads: [] });
        }
        const processed = items.map(item => {
          const name = item.filename ? item.filename.split(/[\\/]/).pop() : 'download';
          const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
          return {
            id: item.id,
            filename: item.filename,
            name: name,
            ext: ext,
            mime: item.mime || getMimeFromExt(ext),
            fileSize: item.fileSize || 0,
            url: item.finalUrl || item.url,
            category: getFileTypeCategory(ext, item.mime),
            startTime: item.startTime
          };
        });
        sendResponse({ success: true, downloads: processed });
      });
    } else {
      sendResponse({ success: false, downloads: [] });
    }
    return true;
  }

  if (message.action === 'FETCH_DOWNLOAD_DATA') {
    (async () => {
      try {
        if (!message.url) throw new Error('No URL');
        const res = await fetch(message.url);
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onload = () => sendResponse({ success: true, dataUrl: reader.result });
        reader.onerror = (e) => sendResponse({ success: false, error: e.message });
        reader.readAsDataURL(blob);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'DELETE_IMAGE') {
    deleteImage(message.id).then(() => {
      updateBadge();
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'CLEAR_ALL') {
    chrome.storage.local.set({ clipboardImages: [] }, () => {
      updateBadge();
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'FETCH_SYSTEM_CLIPBOARD') {
    (async () => {
      try {
        const result = await autoCheckClipboard();
        const data = await chrome.storage.local.get(['clipboardImages']);
        sendResponse({
          success: !result.error,
          found: result.found,
          saved: result.saved,
          images: data.clipboardImages || [],
          error: result.error
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

let imageWriteQueue = Promise.resolve();

function saveImage(newImg) {
  const write = imageWriteQueue.then(() => saveImageNow(newImg));
  // Keep the queue usable even when one storage write fails.
  imageWriteQueue = write.catch(() => {});
  return write;
}

async function saveImageNow(newImg) {
  if (!newImg || !newImg.dataUrl) return false;
  const data = await chrome.storage.local.get(['clipboardImages']);
  let list = data.clipboardImages || [];

  // Prevent immediate exact duplicate
  if (list.length > 0 && list[0].dataUrl === newImg.dataUrl) {
    return false;
  }

  // Remove existing duplicate if present elsewhere
  list = list.filter(item => item.dataUrl !== newImg.dataUrl);

  // Add to front
  list.unshift(newImg);

  // Trim to max limit
  if (list.length > MAX_IMAGES) {
    list = list.slice(0, MAX_IMAGES);
  }

  await chrome.storage.local.set({ clipboardImages: list });
  return true;
}

async function deleteImage(id) {
  const data = await chrome.storage.local.get(['clipboardImages']);
  let list = data.clipboardImages || [];
  list = list.filter(img => img.id !== id);
  await chrome.storage.local.set({ clipboardImages: list });
}
