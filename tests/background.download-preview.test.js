const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const imageDownload = {
  id: 7,
  filename: 'C:\\Downloads\\reference-board.png',
  mime: 'image/png',
  fileSize: 8,
  state: 'complete',
  exists: true,
  startTime: '2026-08-12T10:00:00.000Z',
  finalUrl: 'https://files.example/reference-board.png'
};
const jsonDownload = {
  id: 8,
  filename: 'C:\\Downloads\\data.json',
  mime: 'application/json',
  fileSize: 8,
  state: 'complete',
  exists: true,
  startTime: '2026-08-12T09:00:00.000Z',
  finalUrl: 'https://files.example/data.json'
};
const oversizedDownload = {
  ...imageDownload,
  id: 9,
  filename: 'C:\\Downloads\\huge.png',
  fileSize: 9 * 1024 * 1024,
  finalUrl: 'https://files.example/huge.png'
};
const videoDownload = {
  id: 10,
  filename: 'C:\\Downloads\\walkthrough.mp4',
  mime: 'video/mp4',
  fileSize: 12,
  state: 'complete',
  exists: true,
  startTime: '2026-08-12T11:00:00.000Z',
  finalUrl: 'https://files.example/walkthrough.mp4'
};
const downloads = [imageDownload, jsonDownload, oversizedDownload, videoDownload];
const storage = new Map();
let messageListener;
let fetchCount = 0;
let thumbnailRenderCount = 0;
let lastThumbnailSource = '';
let lastThumbnailAction = '';
let fetchMode = 'image';

function searchDownloads(query, callback) {
  const result = Number.isInteger(query.id)
    ? downloads.filter((download) => download.id === query.id)
    : downloads.slice(0, query.limit || downloads.length);
  if (typeof callback === 'function') queueMicrotask(() => callback(result));
  return Promise.resolve(result);
}

const chrome = {
  runtime: {
    id: 'test-extension',
    lastError: null,
    onInstalled: { addListener() {} },
    onMessage: { addListener(listener) { messageListener = listener; } },
    getURL(file = '') { return `chrome-extension://test-extension/${file}`; },
    async getContexts() { return []; },
    async sendMessage(message) {
      if (message.target === 'offscreen'
          && (message.action === 'CREATE_THUMBNAIL' || message.action === 'CREATE_VIDEO_THUMBNAIL')) {
        thumbnailRenderCount++;
        lastThumbnailSource = message.dataUrl;
        lastThumbnailAction = message.action;
        return { success: true, thumbnailDataUrl: 'data:image/webp;base64,VEhVTUI=' };
      }
      return { success: true };
    }
  },
  storage: {
    local: {
      async setAccessLevel() {},
      async get(keys) {
        if (keys === undefined || keys === null) return Object.fromEntries(storage);
        const names = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
        return Object.fromEntries(names.filter((name) => storage.has(name)).map((name) => [name, storage.get(name)]));
      },
      async set(values) { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => storage.delete(key)); }
    }
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {}
  },
  offscreen: {
    async createDocument() {},
    async closeDocument() {}
  },
  downloads: { search: searchDownloads },
  tabs: {
    async query() { return []; },
    async sendMessage() { return { success: true }; }
  }
};

class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onload?.();
    }, (error) => {
      this.error = error;
      this.onerror?.();
    });
  }
}

async function fetchStub(url) {
  fetchCount++;
  if (fetchMode === 'html') {
    return new Response('<html>login</html>', {
      status: 200,
      headers: { 'content-type': 'text/html', 'content-length': '18' }
    });
  }
  const isVideo = String(url).endsWith('.mp4');
  return new Response(new Uint8Array(isVideo ? [0, 0, 0, 24, 102, 116, 121, 112] : [137, 80, 78, 71, 1, 2, 3, 4]), {
    status: 200,
    headers: { 'content-type': isVideo ? 'video/mp4' : 'image/png', 'content-length': '8' }
  });
}

const context = vm.createContext({
  chrome,
  console,
  crypto: globalThis.crypto,
  URL,
  AbortController,
  Blob,
  Response,
  fetch: fetchStub,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  FileReader: FakeFileReader
});
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
vm.runInContext(source, context, { filename: 'background.js' });

function send(message, sender = {
  id: 'test-extension',
  url: 'chrome-extension://dynamic-resource-host/picker.html',
  origin: 'chrome-extension://dynamic-resource-host'
}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response for ${message.action}`)), 3000);
    const sendResponse = (response) => {
      clearTimeout(timeout);
      resolve(response);
    };
    messageListener(message, sender, sendResponse);
  });
}

(async () => {
  const list = await send({ action: 'GET_RECENT_DOWNLOADS' });
  assert.equal(list.success, true);
  assert.equal(list.downloads.find((item) => item.id === 7).previewable, true);
  assert.equal(list.downloads.find((item) => item.id === 8).previewable, false);
  assert.equal(list.downloads.find((item) => item.id === 10).previewable, true);
  assert.equal(list.downloads.find((item) => item.id === 10).previewKind, 'video');

  const [firstPreview, duplicatePreview] = await Promise.all([
    send({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 7 }),
    send({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 7 })
  ]);
  assert.equal(firstPreview.success, true);
  assert.equal(duplicatePreview.success, true);
  assert.equal(firstPreview.downloadId, 7);
  assert.equal(firstPreview.thumbnailDataUrl, 'data:image/webp;base64,VEhVTUI=');
  assert.ok(JSON.stringify(firstPreview).length < 512 * 1024, 'preview response stays safely below message limits');
  assert.ok(lastThumbnailSource.startsWith('data:image/png;base64,'));
  assert.ok(lastThumbnailSource.length < 1024, 'the offscreen renderer receives only the bounded source');
  assert.equal(fetchCount, 1, 'concurrent preview requests share one bounded fetch');
  assert.equal(thumbnailRenderCount, 1, 'concurrent preview requests share one thumbnail render');

  const cachedPreview = await send({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 7 });
  assert.equal(cachedPreview.success, true);
  assert.equal(fetchCount, 1, 'memory-cached thumbnails do not refetch originals');
  assert.equal(thumbnailRenderCount, 1);

  const videoPreview = await send({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 10 });
  assert.equal(videoPreview.success, true);
  assert.equal(lastThumbnailAction, 'CREATE_VIDEO_THUMBNAIL');
  assert.ok(lastThumbnailSource.startsWith('data:video/mp4;base64,'));

  const nonImage = await send({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 8 });
  assert.equal(nonImage.success, false);
  assert.equal(nonImage.code, 'UNSUPPORTED_DOWNLOAD_PREVIEW');
  assert.equal(fetchCount, 2, 'non-image downloads never fetch preview data');

  const oversized = await send({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 9 });
  assert.equal(oversized.success, false);
  assert.equal(oversized.code, 'DOWNLOAD_PREVIEW_TOO_LARGE');
  assert.equal(fetchCount, 2, 'known oversized downloads are rejected before fetching');

  const invalidSender = await send(
    { action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 7 },
    { id: 'attacker', url: 'https://attacker.example/', origin: 'https://attacker.example' }
  );
  assert.equal(invalidSender.success, false);
  assert.equal(invalidSender.code, 'INVALID_DOWNLOAD_PREVIEW_REQUEST');

  // A changed download fingerprint bypasses the cache, and an HTML/login
  // response is rejected before any data is sent to the image renderer.
  imageDownload.endTime = '2026-08-12T10:00:01.000Z';
  fetchMode = 'html';
  const wrongType = await send({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: 7 });
  assert.equal(wrongType.success, false);
  assert.equal(wrongType.code, 'UNSUPPORTED_DOWNLOAD_PREVIEW');
  assert.equal(thumbnailRenderCount, 2);

  fetchMode = 'image';
  const selection = await send({ action: 'FETCH_DOWNLOAD_DATA', downloadId: 7 });
  assert.equal(selection.success, true, 'thumbnail support must not alter full download selection');
  assert.ok(selection.dataUrl.startsWith('data:image/png;base64,'));

  console.log('background download preview regression: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
