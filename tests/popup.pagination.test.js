const assert = require('node:assert/strict');
const {
  POPUP_ACTIVE_IMAGE_LIMIT,
  POPUP_IMAGE_LIST_PAGE_SIZE,
  fetchPopupImageList,
  popupImagesForView
} = require('../popup.js');

function makeImage(id, hidden = false) {
  return { id, hidden, width: 100, height: 100, timestamp: id };
}

async function testCompletePagination() {
  const source = [
    ...Array.from({ length: 70 }, (_, index) => makeImage(`active-${index}`)),
    ...Array.from({ length: 55 }, (_, index) => makeImage(`hidden-${index}`, true))
  ];
  // A duplicate crossing a page boundary exercises defensive ID de-duplication
  // without changing the server-side offsets used for subsequent pages.
  source.splice(50, 0, source[49]);
  const requests = [];

  const response = await fetchPopupImageList(async (message) => {
    requests.push(message);
    const images = source.slice(message.offset, message.offset + message.limit);
    return {
      success: true,
      images,
      total: source.length,
      hasMore: message.offset + images.length < source.length,
      migration: { complete: true, processed: source.length, total: source.length }
    };
  });

  assert.deepEqual(requests.map(({ offset }) => offset), [0, 50, 100]);
  assert.ok(requests.every(({ limit }) => limit === POPUP_IMAGE_LIST_PAGE_SIZE));
  assert.equal(response.images.length, 125);
  assert.equal(new Set(response.images.map(({ id }) => id)).size, response.images.length);
  assert.equal(popupImagesForView(response.images, 'active').length, POPUP_ACTIVE_IMAGE_LIMIT);
  assert.equal(popupImagesForView(response.images, 'hidden').length, 55);
}

async function testMigrationSnapshotStopsForPolling() {
  const firstSnapshot = Array.from({ length: 52 }, (_, index) => makeImage(`legacy-${index}`, index >= 45));
  let calls = 0;
  const response = await fetchPopupImageList(async (message) => {
    calls++;
    const available = calls === 1
      ? firstSnapshot
      : [...firstSnapshot, makeImage('legacy-52', true), makeImage('legacy-53', true)];
    const images = available.slice(message.offset, message.offset + message.limit);
    return {
      success: true,
      images,
      total: available.length,
      // Migration has more future data, but this load should stop once the
      // currently reported snapshot has been paged and let the timer poll.
      hasMore: true,
      migration: { complete: false, processed: available.length, total: 120, phase: 'copy' }
    };
  });

  assert.equal(calls, 2);
  assert.equal(response.images.length, 54);
  assert.equal(response.migration.complete, false);
  assert.equal(response.migration.processed, 54);
  assert.equal(popupImagesForView(response.images, 'hidden').length, 9);
}

async function testStaleLoadStopsBetweenPages() {
  let current = true;
  let calls = 0;
  const response = await fetchPopupImageList(async () => {
    calls++;
    current = false;
    return {
      success: true,
      images: Array.from({ length: 50 }, (_, index) => makeImage(`stale-${index}`)),
      total: 100,
      hasMore: true,
      migration: { complete: true, processed: 100, total: 100 }
    };
  }, () => current);

  assert.equal(response, null);
  assert.equal(calls, 1);
}

(async () => {
  await testCompletePagination();
  await testMigrationSnapshotStopsForPolling();
  await testStaleLoadStopsBetweenPages();
  console.log('popup pagination regression: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
