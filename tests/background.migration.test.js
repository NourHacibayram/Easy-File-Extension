const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function makeLegacyImage(index, payloadSize = 1024) {
  return {
    id: `old_${index}`,
    dataUrl: `data:image/png;base64,${String(index % 10).repeat(payloadSize)}`,
    mimeType: 'image/png',
    width: 100 + index,
    height: 80 + index,
    size: payloadSize,
    timestamp: 1000 - index,
    hidden: index % 7 === 0
  };
}

function createHarness(initialEntries, shouldFailSet = () => false) {
  const storage = new Map(initialEntries);
  let messageListener;

  function getStorage(keys) {
    const names = typeof keys === 'string'
      ? [keys]
      : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
    return Object.fromEntries(names.filter((name) => storage.has(name)).map((name) => [name, storage.get(name)]));
  }

  function boot() {
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
          async get(keys) { return getStorage(keys); },
          async set(values) {
            for (const [key, value] of Object.entries(values)) {
              if (shouldFailSet(key, value)) throw new Error('injected write failure');
              storage.set(key, value);
            }
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
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No response for ${message.action}`)), 5000);
      messageListener(message, { url: 'chrome-extension://test-extension/popup.html' }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  boot();
  return { storage, boot, send };
}

async function finishMigration(harness, maxAttempts = 100) {
  let response;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    response = await harness.send({ action: 'GET_IMAGE_LIST', limit: 50 });
    if (!response.success || response.migration.complete) return response;
  }
  throw new Error('Migration did not complete');
}

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

(async () => {
  // A new worker resumes from the durable per-record checkpoint.
  const restartHarness = createHarness([[
    'clipboardImages',
    [makeLegacyImage(0, 13 * 1024 * 1024), makeLegacyImage(1, 13 * 1024 * 1024), makeLegacyImage(2, 1024)]
  ]]);
  const firstBatch = await restartHarness.send({ action: 'GET_IMAGE_LIST', limit: 50 });
  assert.equal(firstBatch.migration.complete, false);
  assert.equal(firstBatch.migration.processed, 1);
  restartHarness.boot();
  const resumed = await finishMigration(restartHarness);
  assert.equal(resumed.success, true);
  assert.equal(resumed.migration.complete, true);
  assert.equal(resumed.total, 3);
  assert.equal(restartHarness.storage.has('clipboardImages'), false);

  // A failed record write retains the source and retries the same stable key.
  let failOnce = true;
  const failureHarness = createHarness(
    [['clipboardImages', [makeLegacyImage(0), makeLegacyImage(1)]]],
    (key) => {
      if (failOnce && key === 'clipboardImageV2:legacy_v2_0') {
        failOnce = false;
        return true;
      }
      return false;
    }
  );
  const failed = await failureHarness.send({ action: 'GET_IMAGE_LIST', limit: 50 });
  assert.equal(failed.success, false);
  assert.equal(failed.code, 'MIGRATION_WRITE_FAILED');
  assert.equal(failureHarness.storage.has('clipboardImages'), true);
  failureHarness.boot();
  const recovered = await finishMigration(failureHarness);
  assert.equal(recovered.success, true);
  assert.equal(recovered.total, 2);

  // More than the UI retention count is migrated before the source is removed.
  const overflowHarness = createHarness([[
    'clipboardImages',
    Array.from({ length: 51 }, (_, index) => makeLegacyImage(index, 32))
  ]]);
  const overflow = await finishMigration(overflowHarness);
  assert.equal(overflow.success, true);
  assert.equal(overflow.total, 51);
  assert.equal(overflow.images.length, 50);
  assert.equal(overflow.hasMore, true);
  assert.equal(overflowHarness.storage.has('clipboardImages'), false);

  // More than 50 entries must also survive across a worker restart mid-copy.
  const overflowRestartHarness = createHarness([[
    'clipboardImages',
    Array.from({ length: 55 }, (_, index) => makeLegacyImage(index, 24))
  ]]);
  for (let attempt = 0; attempt < 13; attempt++) {
    await overflowRestartHarness.send({ action: 'GET_IMAGE_LIST', limit: 50 });
  }
  overflowRestartHarness.boot();
  const overflowAfterRestart = await finishMigration(overflowRestartHarness);
  assert.equal(overflowAfterRestart.total, 55);
  assert.equal(overflowRestartHarness.storage.get('clipboardImageIndexV2').length, 55);

  // A retained legacy array must merge with, never replace, newer V2 records.
  const existingData = 'data:image/png;base64,VjI=';
  const coexistHarness = createHarness([
    ['clipboardImages', [makeLegacyImage(0, 64)]],
    ['clipboardImageIndexV2', [{
      id: 'legacy_v2_0', mimeType: 'image/png', width: 12, height: 12, size: 3,
      timestamp: 2000, hidden: false, dataLength: existingData.length,
      fingerprint: fingerprintDataUrl(existingData), source: 'v2', legacyIndex: -1
    }]],
    ['clipboardImageV2:legacy_v2_0', {
      id: 'legacy_v2_0', dataUrl: existingData, mimeType: 'image/png', width: 12,
      height: 12, size: 3, timestamp: 2000, fingerprint: fingerprintDataUrl(existingData)
    }]
  ]);
  const coexist = await finishMigration(coexistHarness);
  assert.equal(coexist.success, true);
  assert.equal(coexist.total, 2);
  assert.ok(coexistHarness.storage.has('clipboardImageV2:legacy_v2_0'));
  assert.ok(coexistHarness.storage.has('clipboardImageV2:legacy_v2_0_1'));
  assert.equal(coexistHarness.storage.get('clipboardImageV2:legacy_v2_0').dataUrl, existingData);

  // A sampled-fingerprint match is confirmed against the full data before dedupe.
  const collisionExistingData = 'data:image/png;base64,AAAA';
  const newData = 'data:image/png;base64,BBBB';
  const collisionHarness = createHarness([
    ['clipboardImageMigrationV2', { version: 2, phase: 'done', next: 0, sourceCount: 0, entries: [] }],
    ['clipboardImageIndexV2', [{
      id: 'existing', mimeType: 'image/png', width: 1, height: 1, size: 4,
      timestamp: 1, hidden: false, dataLength: collisionExistingData.length,
      fingerprint: fingerprintDataUrl(newData), source: 'v2', legacyIndex: -1
    }]],
    ['clipboardImageV2:existing', {
      id: 'existing', dataUrl: collisionExistingData, mimeType: 'image/png', width: 1,
      height: 1, size: 4, timestamp: 1, fingerprint: fingerprintDataUrl(newData)
    }]
  ]);
  const saved = await collisionHarness.send({
    action: 'SAVE_IMAGE',
    image: { id: 'new_image', dataUrl: newData, mimeType: 'image/png', width: 1, height: 1, size: 4 }
  });
  assert.equal(saved.success, true);
  const collisionList = await collisionHarness.send({ action: 'GET_IMAGE_LIST', limit: 50 });
  assert.equal(collisionList.total, 2);

  // Existing embedded previews are split into lightweight keys during legacy
  // migration, and CLEAR_ALL removes both parts of the stored image.
  const embeddedPreviewImage = {
    ...makeLegacyImage(0, 64),
    thumbnailDataUrl: 'data:image/webp;base64,AA=='
  };
  const previewHarness = createHarness([['clipboardImages', [embeddedPreviewImage]]]);
  const previewList = await finishMigration(previewHarness);
  assert.equal(previewList.success, true);
  const previewId = previewList.images[0].id;
  const previewImageKey = `clipboardImageV2:${encodeURIComponent(previewId)}`;
  const previewThumbKey = `clipboardImageThumbV2:${encodeURIComponent(previewId)}`;
  assert.equal(Object.hasOwn(previewHarness.storage.get(previewImageKey), 'thumbnailDataUrl'), false);
  assert.equal(previewHarness.storage.get(previewThumbKey).thumbnailDataUrl, embeddedPreviewImage.thumbnailDataUrl);
  const cleared = await previewHarness.send({ action: 'CLEAR_ALL' });
  assert.equal(cleared.success, true);
  assert.equal(previewHarness.storage.has(previewImageKey), false);
  assert.equal(previewHarness.storage.has(previewThumbKey), false);

  console.log('background migration regression: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
