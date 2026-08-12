const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function fingerprintDataUrl(dataUrl) {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(dataUrl.length / 8192));
  for (let index = 0; index < dataUrl.length; index += step) {
    hash ^= dataUrl.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= dataUrl.length;
  return `${dataUrl.length}:${(hash >>> 0).toString(16)}`;
}

function makeImage(id, timestamp, hidden = false) {
  const dataUrl = `data:image/png;base64,${Buffer.from(id).toString('base64')}`;
  const fingerprint = fingerprintDataUrl(dataUrl);
  return {
    metadata: {
      id,
      mimeType: 'image/png',
      width: 10,
      height: 10,
      size: 10,
      timestamp,
      hidden,
      dataLength: dataUrl.length,
      fingerprint,
      source: 'v2',
      legacyIndex: -1
    },
    record: {
      id,
      dataUrl,
      mimeType: 'image/png',
      width: 10,
      height: 10,
      size: 10,
      timestamp,
      fingerprint
    },
    thumbnail: {
      id,
      fingerprint,
      thumbnailDataUrl: 'data:image/webp;base64,AA=='
    }
  };
}

function createHarness(images) {
  const storage = new Map([
    ['clipboardImageMigrationV2', {
      version: 2,
      phase: 'done',
      next: 0,
      sourceCount: 0,
      entries: []
    }],
    ['clipboardImageIndexV2', images.map((image) => image.metadata)]
  ]);
  for (const image of images) {
    storage.set(`clipboardImageV2:${encodeURIComponent(image.metadata.id)}`, image.record);
    storage.set(`clipboardImageThumbV2:${encodeURIComponent(image.metadata.id)}`, image.thumbnail);
  }

  let messageListener;
  const chrome = {
    runtime: {
      id: 'test-extension',
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } },
      getURL(file) { return `chrome-extension://test-extension/${file}`; },
      async getContexts() { return []; },
      async sendMessage() { return { success: true }; }
    },
    storage: {
      local: {
        async setAccessLevel() {},
        async get(keys) {
          const names = typeof keys === 'string'
            ? [keys]
            : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
          return Object.fromEntries(
            names.filter((name) => storage.has(name)).map((name) => [name, storage.get(name)])
          );
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        },
        async remove(keys) {
          for (const key of (Array.isArray(keys) ? keys : [keys])) storage.delete(key);
        }
      }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    offscreen: { async createDocument() {}, async closeDocument() {} },
    downloads: { async search() { return []; } },
    tabs: { async query() { return []; }, async sendMessage() {} }
  };

  vm.runInContext(source, vm.createContext({
    chrome,
    console,
    crypto: globalThis.crypto,
    URL,
    Blob,
    AbortController,
    setTimeout,
    clearTimeout,
    FileReader: class {}
  }), { filename: 'background.js' });

  function send(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No response for ${message.action}`)), 5000);
      messageListener(
        message,
        { url: 'chrome-extension://test-extension/popup.html' },
        (response) => {
          clearTimeout(timer);
          resolve(response);
        }
      );
    });
  }

  return { storage, send };
}

function activeImages() {
  return Array.from({ length: 50 }, (_, index) =>
    makeImage(`active_${index}`, 1000 - index)
  );
}

(async () => {
  // New captures rotate only the active gallery. Even much older hidden
  // records and their preview keys remain protected.
  const hiddenA = makeImage('hidden_a', 100, true);
  const hiddenB = makeImage('hidden_b', 200, true);
  const saveHarness = createHarness([...activeImages(), hiddenA, hiddenB]);
  const newDataUrl = 'data:image/png;base64,TkVX';
  const saved = await saveHarness.send({
    action: 'SAVE_IMAGE',
    image: {
      id: 'new_capture',
      dataUrl: newDataUrl,
      mimeType: 'image/png',
      width: 10,
      height: 10,
      size: 3,
      timestamp: 2000
    }
  });
  assert.equal(saved.success, true);
  const savedIndex = saveHarness.storage.get('clipboardImageIndexV2');
  assert.equal(savedIndex.filter((item) => !item.hidden).length, 50);
  assert.equal(savedIndex.filter((item) => item.hidden).length, 2);
  assert.ok(savedIndex.some((item) => item.id === 'new_capture'));
  assert.ok(savedIndex.some((item) => item.id === 'hidden_a'));
  assert.ok(savedIndex.some((item) => item.id === 'hidden_b'));
  assert.ok(!savedIndex.some((item) => item.id === 'active_49'));
  assert.ok(saveHarness.storage.has('clipboardImageV2:hidden_a'));
  assert.ok(saveHarness.storage.has('clipboardImageThumbV2:hidden_a'));
  assert.equal(saveHarness.storage.has('clipboardImageV2:active_49'), false);
  assert.equal(saveHarness.storage.has('clipboardImageThumbV2:active_49'), false);

  // Restoring at capacity keeps the restored image and removes the oldest
  // other active image. The response tells callers exactly what was rotated.
  const restoredImage = makeImage('protected_hidden', 1, true);
  const restoreHarness = createHarness([...activeImages(), restoredImage]);
  const restored = await restoreHarness.send({
    action: 'TOGGLE_HIDE_IMAGE',
    id: 'protected_hidden'
  });
  assert.equal(restored.success, true);
  assert.equal(restored.hidden, false);
  assert.deepEqual(Array.from(restored.removedIds), ['active_49']);
  const restoredIndex = restoreHarness.storage.get('clipboardImageIndexV2');
  assert.equal(restoredIndex.filter((item) => !item.hidden).length, 50);
  assert.ok(restoredIndex.some((item) => item.id === 'protected_hidden' && !item.hidden));
  assert.ok(!restoredIndex.some((item) => item.id === 'active_49'));
  assert.ok(restoreHarness.storage.has('clipboardImageV2:protected_hidden'));
  assert.ok(restoreHarness.storage.has('clipboardImageThumbV2:protected_hidden'));
  assert.equal(restoreHarness.storage.has('clipboardImageV2:active_49'), false);
  assert.equal(restoreHarness.storage.has('clipboardImageThumbV2:active_49'), false);

  const hidden = await restoreHarness.send({
    action: 'TOGGLE_HIDE_IMAGE',
    id: 'active_0'
  });
  assert.equal(hidden.success, true);
  assert.equal(hidden.hidden, true);
  assert.deepEqual(Array.from(hidden.removedIds), []);
  assert.ok(restoreHarness.storage.has('clipboardImageV2:active_0'));

  console.log('background protected retention regression: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
