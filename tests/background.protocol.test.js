const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const legacyImages = Array.from({ length: 5 }, (_, index) => ({
  id: `img_legacy_${index}`,
  dataUrl: `data:image/png;base64,${String(index).repeat(14 * 1024 * 1024)}`,
  mimeType: 'image/png',
  width: 1920,
  height: 1080,
  size: 10 * 1024 * 1024,
  timestamp: Date.now() - index,
  hidden: index === 4
}));

const storage = new Map([['clipboardImages', legacyImages]]);
let messageListener;
let fullImageRecordReads = 0;
let thumbnailGenerationCount = 0;

function getStorage(keys) {
  if (typeof keys === 'string' && keys.startsWith('clipboardImageV2:')) {
    fullImageRecordReads++;
  }
  if (keys === undefined || keys === null) return Object.fromEntries(storage);
  const names = typeof keys === 'string'
    ? [keys]
    : (Array.isArray(keys) ? keys : Object.keys(keys));
  return Object.fromEntries(names.filter((name) => storage.has(name)).map((name) => [name, storage.get(name)]));
}

const chrome = {
  runtime: {
    id: 'test-extension',
    onInstalled: { addListener() {} },
    onMessage: { addListener(listener) { messageListener = listener; } },
    getURL(file) { return `chrome-extension://test-extension/${file}`; },
    async getContexts() { return []; },
    async sendMessage(message) {
      if (message.action === 'CREATE_THUMBNAIL') {
        thumbnailGenerationCount++;
        return { success: true, thumbnailDataUrl: 'data:image/webp;base64,AA==' };
      }
      if (message.target === 'offscreen') return { success: true, image: null };
      return { success: true };
    }
  },
  storage: {
    local: {
      async setAccessLevel() {},
      async get(keys) { return getStorage(keys); },
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
  downloads: {
    async search() { return []; }
  },
  tabs: {
    async query() { return []; },
    async sendMessage() {}
  }
};

const context = vm.createContext({
  chrome,
  console,
  crypto: globalThis.crypto,
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
  FileReader: class {}
});
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
vm.runInContext(source, context, { filename: 'background.js' });

function send(message, sender = { url: 'chrome-extension://test-extension/popup.html', origin: 'chrome-extension://test-extension' }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response for ${message.action}`)), 10000);
    const sendResponse = (response) => {
      clearTimeout(timeout);
      resolve(response);
    };
    messageListener(message, sender, sendResponse);
  });
}

(async () => {
  let list = await send({ action: 'GET_IMAGE_LIST', limit: 50 });
  assert.equal(list.success, true);
  assert.equal(list.migration.complete, false);
  assert.equal(storage.has('clipboardImages'), true, 'source must remain until every record is committed');
  for (let attempt = 0; !list.migration.complete && attempt < 10; attempt++) {
    list = await send({ action: 'GET_IMAGE_LIST', limit: 50 });
  }
  assert.equal(list.migration.complete, true);
  assert.equal(list.images.length, 5);
  assert.ok(JSON.stringify(list).length < 64 * 1024, 'metadata list must stay small');
  assert.ok(list.images.every((image) => !Object.hasOwn(image, 'dataUrl')));
  assert.equal(storage.has('clipboardImages'), false, 'legacy source is removed only after a complete copy');

  const detail = await send({ action: 'GET_IMAGE_DATA', id: list.images[0].id });
  assert.equal(detail.success, true);
  assert.equal(detail.image.id, list.images[0].id);
  assert.ok(detail.image.dataUrl.startsWith('data:image/png;base64,'));
  assert.ok(JSON.stringify(detail).length < 56 * 1024 * 1024);

  const thumbnail = await send({ action: 'GET_IMAGE_THUMBNAIL', id: list.images[0].id });
  assert.equal(thumbnail.success, true);
  assert.equal(thumbnail.id, list.images[0].id);
  assert.equal(typeof thumbnail.thumbnailDataUrl, 'string');
  assert.ok(JSON.stringify(thumbnail).length < 512 * 1024);
  const fullRecordReadsAfterThumbnail = fullImageRecordReads;
  const thumbKey = `clipboardImageThumbV2:${encodeURIComponent(list.images[0].id)}`;
  const imageKey = `clipboardImageV2:${encodeURIComponent(list.images[0].id)}`;
  assert.equal(storage.get(thumbKey).thumbnailDataUrl, thumbnail.thumbnailDataUrl);
  assert.equal(storage.get(thumbKey).fingerprint, storage.get(imageKey).fingerprint);
  assert.equal(Object.hasOwn(storage.get(imageKey), 'thumbnailDataUrl'), false,
    'full-resolution records must not be rewritten to cache a preview');

  const cachedThumbnail = await send({ action: 'GET_IMAGE_THUMBNAIL', id: list.images[0].id });
  assert.equal(cachedThumbnail.success, true);
  assert.equal(cachedThumbnail.thumbnailDataUrl, thumbnail.thumbnailDataUrl);
  assert.equal(fullImageRecordReads, fullRecordReadsAfterThumbnail,
    'a cached preview must not read the full-resolution record');
  assert.equal(thumbnailGenerationCount, 1, 'a cached preview must not be regenerated');

  const legacy = await send({ action: 'GET_IMAGES' });
  assert.equal(legacy.success, true);
  assert.equal(legacy.truncated, true);
  assert.ok(JSON.stringify(legacy).length < 24 * 1024 * 1024);

  const clipboard = await send({ action: 'FETCH_SYSTEM_CLIPBOARD' });
  assert.equal(clipboard.success, true);
  assert.equal(Object.hasOwn(clipboard, 'images'), false);

  const oversizedSave = await send({
    action: 'SAVE_IMAGE',
    image: {
      id: 'img_too_large',
      dataUrl: `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`,
      mimeType: 'image/png'
    }
  });
  assert.equal(oversizedSave.success, false);
  assert.equal(oversizedSave.code, 'IMAGE_TOO_LARGE');

  const missing = await send({ action: 'GET_IMAGE_DATA', id: 'img_missing' });
  assert.equal(missing.success, false);
  assert.equal(missing.code, 'NOT_FOUND');

  const deleted = await send({ action: 'DELETE_IMAGE', id: list.images[0].id });
  assert.equal(deleted.success, true);
  assert.equal(storage.has(imageKey), false);
  assert.equal(storage.has(thumbKey), false, 'deleting an image must remove its cached preview');

  console.log('background protocol regression: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
