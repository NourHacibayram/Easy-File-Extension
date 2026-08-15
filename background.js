const MAX_ACTIVE_IMAGES = 50;
const MAX_IMAGE_LIST_PAGE_SIZE = 50;
const IMAGE_INDEX_KEY = 'clipboardImageIndexV2';
const LEGACY_IMAGES_KEY = 'clipboardImages';
const IMAGE_MIGRATION_KEY = 'clipboardImageMigrationV2';
const IMAGE_KEY_PREFIX = 'clipboardImageV2:';
const THUMB_KEY_PREFIX = 'clipboardImageThumbV2:';
const MAX_NEW_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_NEW_IMAGE_DATA_URL_LENGTH = Math.ceil(MAX_NEW_IMAGE_BYTES * 4 / 3) + 1024;
const MAX_IMAGE_RESPONSE_LENGTH = 56 * 1024 * 1024;
const LEGACY_RESPONSE_BUDGET = 24 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_DOWNLOAD_IMAGE_PREVIEW_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_VIDEO_PREVIEW_SOURCE_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_THUMBNAIL_FETCH_TIMEOUT_MS = 8000;
const DOWNLOAD_THUMBNAIL_RENDER_TIMEOUT_MS = 5000;
const MAX_DOWNLOAD_THUMBNAIL_CACHE_ENTRIES = 24;
const SUPPORTED_DOWNLOAD_IMAGE_PREVIEW_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif'
]);
const SUPPORTED_DOWNLOAD_VIDEO_PREVIEW_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg'
]);
const MIGRATION_BATCH_RECORDS = 2;
const MIGRATION_BATCH_BYTES = 24 * 1024 * 1024;
const MAX_THUMBNAIL_DATA_URL_LENGTH = 512 * 1024;

let creatingOffscreen = null;
let clipboardCheckPromise = null;
let imageMigrationPromise = null;
let imageMutationQueue = Promise.resolve();
let legacyMigrationCache = null;
let offscreenOperationQueue = Promise.resolve();
const thumbnailRequests = new Map();
const downloadThumbnailRequests = new Map();
const downloadThumbnailCache = new Map();
const pickerSessions = new Map();
const pickerSessionChallenges = new Map();
const PICKER_SESSION_TTL_MS = 10 * 60_000;
const PICKER_COMMAND_TYPES = new Set([
  'CIP_CLOSE',
  'CIP_SHOW_ALL',
  'CIP_PICK_IMAGE',
  'CIP_PICK_DOWNLOAD',
  'CIP_PICK_BATCH'
]);

// Clipboard images must only be reachable through the validated message API.
// Content scripts still receive the small settings values they need via
// GET_DOMAIN_STATE and a targeted tab message from the popup.
try {
  const accessLevelPromise = chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS'
  });
  if (accessLevelPromise && typeof accessLevelPromise.catch === 'function') {
    accessLevelPromise.catch(() => {});
  }
} catch (error) {
  // Older Chromium builds do not expose setAccessLevel. The message boundary
  // and trusted-event checks still protect the normal runtime path.
}

chrome.runtime.onInstalled.addListener(() => {
  updateBadge().catch(() => {});
});

if (typeof chrome !== 'undefined' && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'OPEN_PICKER') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_PICKER' }).catch(() => {});
        }
      } catch (error) {
        // Ignore tab query errors
      }
    }
  });
}

function imageStorageKey(id) {
  return IMAGE_KEY_PREFIX + encodeURIComponent(id);
}

function thumbnailStorageKey(id) {
  return THUMB_KEY_PREFIX + encodeURIComponent(id);
}

function isManagedImageStorageKey(key) {
  return typeof key === 'string'
    && (key.startsWith(IMAGE_KEY_PREFIX) || key.startsWith(THUMB_KEY_PREFIX));
}

function thumbnailKeyForImageKey(key) {
  return typeof key === 'string' && key.startsWith(IMAGE_KEY_PREFIX)
    ? THUMB_KEY_PREFIX + key.slice(IMAGE_KEY_PREFIX.length)
    : '';
}

function isValidImageId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= 160
    && /^[a-zA-Z0-9_.:-]+$/.test(id);
}

function makeImageId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `img_${Date.now()}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeMimeType(value) {
  return typeof value === 'string' && /^image\/[a-z0-9.+-]+$/i.test(value)
    ? value.toLowerCase()
    : 'image/png';
}

function decodedBase64Bytes(dataUrl) {
  if (typeof dataUrl !== 'string') return Infinity;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return Infinity;
  const encoded = dataUrl.length - comma - 1;
  let padding = 0;
  if (dataUrl.endsWith('==')) padding = 2;
  else if (dataUrl.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor(encoded * 3 / 4) - padding);
}

function fingerprintDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return '';
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(dataUrl.length / 8192));
  for (let i = 0; i < dataUrl.length; i += step) {
    hash ^= dataUrl.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= dataUrl.length;
  return `${dataUrl.length}:${(hash >>> 0).toString(16)}`;
}

function normalizeStoredRecord(item, requestedId = '') {
  if (!item || typeof item !== 'object' || typeof item.dataUrl !== 'string') {
    return null;
  }

  const id = isValidImageId(requestedId)
    ? requestedId
    : (isValidImageId(item.id) ? item.id : makeImageId());
  const mimeType = normalizeMimeType(item.mimeType || item.dataUrl.match(/^data:([^;,]+)/i)?.[1]);

  return {
    id,
    dataUrl: item.dataUrl,
    mimeType,
    width: finiteNumber(item.width),
    height: finiteNumber(item.height),
    size: finiteNumber(item.size, Math.round(item.dataUrl.length * 0.75)),
    timestamp: finiteNumber(item.timestamp, Date.now()),
    thumbnailDataUrl: typeof item.thumbnailDataUrl === 'string'
      && item.thumbnailDataUrl.startsWith('data:image/')
      && item.thumbnailDataUrl.length <= MAX_THUMBNAIL_DATA_URL_LENGTH
      ? item.thumbnailDataUrl
      : '',
    fingerprint: typeof item.fingerprint === 'string'
      ? item.fingerprint
      : fingerprintDataUrl(item.dataUrl)
  };
}

function imageRecordForStorage(record) {
  const { thumbnailDataUrl, ...storedRecord } = record;
  return storedRecord;
}

function validThumbnailDataUrl(value) {
  return typeof value === 'string'
    && value.startsWith('data:image/')
    && value.length <= MAX_THUMBNAIL_DATA_URL_LENGTH;
}

function makeStoredThumbnail(id, fingerprint, thumbnailDataUrl) {
  return {
    id,
    fingerprint,
    thumbnailDataUrl
  };
}

function readValidStoredThumbnail(value, indexItem) {
  if (!value || typeof value !== 'object') return '';
  if (value.id !== indexItem.id || value.fingerprint !== indexItem.fingerprint) return '';
  return validThumbnailDataUrl(value.thumbnailDataUrl) ? value.thumbnailDataUrl : '';
}

function metadataFromRecord(record, hidden = false, source = 'v2', legacyIndex = -1) {
  return {
    id: record.id,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    size: record.size,
    timestamp: record.timestamp,
    hidden: !!hidden,
    dataLength: record.dataUrl.length,
    fingerprint: record.fingerprint,
    source,
    legacyIndex
  };
}

function sanitizeIndex(rawIndex) {
  if (!Array.isArray(rawIndex)) return [];
  const seen = new Set();
  const result = [];

  for (const item of rawIndex) {
    if (!item || !isValidImageId(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push({
      id: item.id,
      mimeType: normalizeMimeType(item.mimeType),
      width: finiteNumber(item.width),
      height: finiteNumber(item.height),
      size: finiteNumber(item.size),
      timestamp: finiteNumber(item.timestamp),
      hidden: !!item.hidden,
      dataLength: finiteNumber(item.dataLength),
      fingerprint: typeof item.fingerprint === 'string' ? item.fingerprint : '',
      source: item.source === 'legacy' ? 'legacy' : 'v2',
      legacyIndex: Number.isInteger(item.legacyIndex) ? item.legacyIndex : -1
    });
  }
  return result;
}

function sanitizeMigrationEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  const result = [];
  const seen = new Set();
  for (const item of rawEntries) {
    if (!item || !isValidImageId(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push({
      id: item.id,
      mimeType: normalizeMimeType(item.mimeType),
      width: finiteNumber(item.width),
      height: finiteNumber(item.height),
      size: finiteNumber(item.size),
      timestamp: finiteNumber(item.timestamp),
      hidden: !!item.hidden,
      dataLength: finiteNumber(item.dataLength),
      fingerprint: typeof item.fingerprint === 'string' ? item.fingerprint : '',
      source: item.source === 'legacy' ? 'legacy' : 'v2',
      legacyIndex: Number.isInteger(item.legacyIndex) ? item.legacyIndex : -1
    });
  }
  return result;
}

function publicMetadata(item) {
  return {
    id: item.id,
    mimeType: item.mimeType,
    width: item.width,
    height: item.height,
    size: item.size,
    timestamp: item.timestamp,
    hidden: item.hidden,
    dataLength: item.dataLength,
    available: item.dataLength > 0 && item.dataLength <= MAX_IMAGE_RESPONSE_LENGTH
  };
}

function enforceActiveImageLimit(index, protectedIds = []) {
  const protectedSet = new Set(protectedIds);
  const overflow = index.filter((item) => !item.hidden).length - MAX_ACTIVE_IMAGES;
  if (overflow <= 0) return { index, removed: [] };

  // Timestamps define age; the index position is a deterministic fallback for
  // legacy records with equal timestamps. Hidden records are never candidates.
  const candidates = index
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => !item.hidden && !protectedSet.has(item.id))
    .sort((left, right) =>
      left.item.timestamp - right.item.timestamp || right.position - left.position
    );
  const removed = candidates.slice(0, overflow).map(({ item }) => item);
  const removedIds = new Set(removed.map((item) => item.id));
  return {
    index: index.filter((item) => !removedIds.has(item.id)),
    removed
  };
}

async function ensureImageStore() {
  if (imageMigrationPromise) return imageMigrationPromise;
  imageMigrationPromise = enqueueImageMutation(advanceImageStore).finally(() => {
    imageMigrationPromise = null;
  });
  return imageMigrationPromise;
}

function stableLegacyImageId(position) {
  return `legacy_v2_${position}`;
}

function uniqueLegacyImageId(position, occupiedIds) {
  const base = stableLegacyImageId(position);
  let candidate = base;
  let suffix = 1;
  while (occupiedIds.has(candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

function migrationSummary(state) {
  const phase = state?.phase || 'done';
  const total = finiteNumber(state?.sourceCount);
  const processed = phase === 'done' ? total : Math.min(total, finiteNumber(state?.next));
  return {
    complete: phase === 'done',
    phase,
    processed,
    total,
    error: typeof state?.lastError === 'string' ? state.lastError : undefined
  };
}

function normalizeMigrationState(rawState) {
  if (!rawState || rawState.version !== 2 || typeof rawState.phase !== 'string') return null;
  return {
    version: 2,
    phase: rawState.phase,
    next: Math.max(0, Math.floor(finiteNumber(rawState.next))),
    sourceCount: Math.max(0, Math.floor(finiteNumber(rawState.sourceCount))),
    entries: sanitizeMigrationEntries(rawState.entries),
    supersededKeys: Array.isArray(rawState.supersededKeys)
      ? rawState.supersededKeys.filter(isManagedImageStorageKey)
      : [],
    keysToDelete: Array.isArray(rawState.keysToDelete)
      ? rawState.keysToDelete.filter(isManagedImageStorageKey)
      : [],
    lastError: typeof rawState.lastError === 'string' ? rawState.lastError : null
  };
}

async function getLegacyImages() {
  if (legacyMigrationCache) return legacyMigrationCache;
  const stored = await chrome.storage.local.get(LEGACY_IMAGES_KEY);
  legacyMigrationCache = Array.isArray(stored[LEGACY_IMAGES_KEY])
    ? stored[LEGACY_IMAGES_KEY]
    : null;
  return legacyMigrationCache;
}

async function resumeClearing(state) {
  await chrome.storage.local.set({ [IMAGE_INDEX_KEY]: [] });
  await chrome.storage.local.remove([LEGACY_IMAGES_KEY, ...state.keysToDelete]);
  const doneState = { version: 2, phase: 'done', next: 0, sourceCount: 0, entries: [] };
  await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: doneState });
  legacyMigrationCache = null;
  return { index: [], state: doneState };
}

async function advanceImageStore() {
  const smallState = await chrome.storage.local.get([IMAGE_MIGRATION_KEY, IMAGE_INDEX_KEY]);
  let state = normalizeMigrationState(smallState[IMAGE_MIGRATION_KEY]);
  const existingIndex = sanitizeIndex(smallState[IMAGE_INDEX_KEY]);

  if (state?.phase === 'clearing') return resumeClearing(state);
  if (state?.phase === 'done') return { index: existingIndex, state };
  if (state?.phase === 'failed') {
    const error = new Error(state.lastError || 'Legacy gallery migration needs attention.');
    error.code = 'MIGRATION_FAILED';
    throw error;
  }

  if (!state) {
    const legacyImages = await getLegacyImages();
    if (!legacyImages) {
      state = { version: 2, phase: 'done', next: 0, sourceCount: 0, entries: [] };
      await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: state });
      return { index: existingIndex, state };
    }

    state = {
      version: 2,
      phase: 'copy',
      next: 0,
      sourceCount: legacyImages.length,
      // If a previous build created valid V2 records but retained the legacy
      // array, preserve those records and merge the legacy source around them.
      entries: existingIndex,
      supersededKeys: [],
      lastError: null
    };
    // Persist intent before copying anything. Deterministic destination keys
    // make a retry safe if the service worker is stopped between checkpoints.
    await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: state });
  }

  if (state.phase === 'copy') {
    const legacyImages = await getLegacyImages();
    if (!legacyImages || legacyImages.length !== state.sourceCount) {
      state = {
        ...state,
        phase: 'failed',
        lastError: 'The legacy gallery changed during migration; the original data was retained.'
      };
      await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: state });
      const error = new Error(state.lastError);
      error.code = 'MIGRATION_FAILED';
      throw error;
    }

    let copiedRecords = 0;
    let copiedBytes = 0;
    while (state.next < state.sourceCount && copiedRecords < MIGRATION_BATCH_RECORDS) {
      const position = state.next;
      const legacyItem = legacyImages[position];
      const occupiedIds = new Set(state.entries.map((entry) => entry.id));
      const preferredId = uniqueLegacyImageId(position, occupiedIds);
      const record = normalizeStoredRecord(legacyItem, preferredId);
      const recordBytes = record?.dataUrl.length || 0;
      if (copiedRecords > 0 && copiedBytes + recordBytes > MIGRATION_BATCH_BYTES) break;

      try {
        if (record) {
          const writes = {
            [imageStorageKey(record.id)]: imageRecordForStorage(record)
          };
          if (validThumbnailDataUrl(record.thumbnailDataUrl)) {
            writes[thumbnailStorageKey(record.id)] = makeStoredThumbnail(
              record.id,
              record.fingerprint,
              record.thumbnailDataUrl
            );
          }
          await chrome.storage.local.set(writes);
        }
        state = {
          ...state,
          next: position + 1,
          entries: record
            ? [...state.entries, metadataFromRecord(record, legacyItem.hidden)]
            : state.entries,
          lastError: null
        };
        await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: state });
      } catch (error) {
        const migrationError = new Error(`Could not migrate image ${position + 1}: ${error.message}`);
        migrationError.code = 'MIGRATION_WRITE_FAILED';
        throw migrationError;
      }
      copiedRecords++;
      copiedBytes += recordBytes;
    }

    if (state.next >= state.sourceCount) {
      state = { ...state, phase: 'commit' };
      await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: state });
    }
  }

  if (state.phase === 'commit') {
    await chrome.storage.local.set({ [IMAGE_INDEX_KEY]: state.entries });
    state = { ...state, phase: 'cleanup' };
    await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: state });
  }

  if (state.phase === 'cleanup') {
    const destinationKeys = new Set(state.entries.flatMap((item) => [
      imageStorageKey(item.id),
      thumbnailStorageKey(item.id)
    ]));
    const staleKeys = state.supersededKeys.filter((key) => !destinationKeys.has(key));
    const staleThumbnailKeys = staleKeys
      .map(thumbnailKeyForImageKey)
      .filter(Boolean)
      .filter((key) => !destinationKeys.has(key));
    await chrome.storage.local.remove([LEGACY_IMAGES_KEY, ...staleKeys, ...staleThumbnailKeys]);
    state = {
      version: 2,
      phase: 'done',
      next: state.sourceCount,
      sourceCount: state.sourceCount,
      entries: []
    };
    await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: state });
    legacyMigrationCache = null;
    return { index: sanitizeIndex(await readStoredIndexOnly()), state };
  }

  return { index: state.entries, state };
}

async function readStoredIndexOnly() {
  const stored = await chrome.storage.local.get(IMAGE_INDEX_KEY);
  return stored[IMAGE_INDEX_KEY];
}

async function readImageIndex() {
  const snapshot = await ensureImageStore();
  return snapshot.index;
}

async function readCompleteImageIndex() {
  // This helper is called only from an operation already holding the image
  // mutation queue. Calling ensureImageStore here would enqueue behind itself.
  const snapshot = await advanceImageStore();
  if (snapshot.state?.phase !== 'done') {
    const error = new Error(`Gallery migration is in progress (${snapshot.state.next}/${snapshot.state.sourceCount}).`);
    error.code = 'MIGRATION_IN_PROGRESS';
    throw error;
  }
  return snapshot.index;
}

async function readImageRecord(indexItem) {
  if (!indexItem) return null;

  if (indexItem.source === 'legacy') {
    const stored = await chrome.storage.local.get(LEGACY_IMAGES_KEY);
    const legacyImages = Array.isArray(stored[LEGACY_IMAGES_KEY])
      ? stored[LEGACY_IMAGES_KEY]
      : [];
    const legacyItem = legacyImages[indexItem.legacyIndex];
    return normalizeStoredRecord(legacyItem, indexItem.id);
  }

  const key = imageStorageKey(indexItem.id);
  const stored = await chrome.storage.local.get(key);
  return normalizeStoredRecord(stored[key], indexItem.id);
}

async function updateBadge(index = null) {
  try {
    let images = index;
    if (!images) {
      const stored = await chrome.storage.local.get([IMAGE_INDEX_KEY, IMAGE_MIGRATION_KEY]);
      const state = normalizeMigrationState(stored[IMAGE_MIGRATION_KEY]);
      images = state && state.phase !== 'done'
        ? state.entries
        : sanitizeIndex(stored[IMAGE_INDEX_KEY]);
    }
    const count = images.filter((image) => !image.hidden).length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#4F46E5' });
  } catch (error) {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function hasOffscreenDocument(path) {
  const documentUrl = chrome.runtime.getURL(path);
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl]
    });
    return contexts.length > 0;
  }

  if (globalThis.clients && typeof globalThis.clients.matchAll === 'function') {
    const matchedClients = await globalThis.clients.matchAll();
    return matchedClients.some((client) => client.url === documentUrl);
  }
  return false;
}

async function setupOffscreenDocument(path) {
  if (await hasOffscreenDocument(path)) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: path,
    reasons: ['CLIPBOARD'],
    justification: 'Read image data from the clipboard after a user action'
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument('offscreen.html')) {
      await chrome.offscreen.closeDocument();
    }
  } catch (error) {
    // The browser may already have torn down the document.
  }
}

function autoCheckClipboard() {
  if (clipboardCheckPromise) return clipboardCheckPromise;
  clipboardCheckPromise = enqueueOffscreenOperation(performClipboardCheck).finally(() => {
    clipboardCheckPromise = null;
  });
  return clipboardCheckPromise;
}

function enqueueOffscreenOperation(operation) {
  const result = offscreenOperationQueue.then(operation);
  offscreenOperationQueue = result.catch(() => {});
  return result;
}

async function performClipboardCheck() {
  try {
    await setupOffscreenDocument('offscreen.html');
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'READ_CLIPBOARD'
        });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (response?.success && response.image) {
      const saved = await saveImage(response.image);
      await updateBadge();
      return { found: true, saved };
    }
    return {
      found: false,
      saved: false,
      error: response?.error || undefined
    };
  } catch (error) {
    return { found: false, saved: false, code: error.code, error: error.message };
  } finally {
    await closeOffscreenDocument();
  }
}

function getImageThumbnail(indexItem) {
  const requestKey = `${indexItem.id}:${indexItem.fingerprint}`;
  if (thumbnailRequests.has(requestKey)) return thumbnailRequests.get(requestKey);
  const request = (async () => {
    const thumbnailKey = thumbnailStorageKey(indexItem.id);
    const storedThumbnail = await chrome.storage.local.get(thumbnailKey);
    const cachedThumbnail = readValidStoredThumbnail(storedThumbnail[thumbnailKey], indexItem);
    if (cachedThumbnail) return cachedThumbnail;

    const record = await readImageRecord(indexItem);
    if (!record) {
      const error = new Error('Stored image data is unavailable.');
      error.code = 'CORRUPT_IMAGE';
      throw error;
    }
    if (record.dataUrl.length > MAX_IMAGE_RESPONSE_LENGTH) {
      const error = new Error('This legacy image is too large to preview.');
      error.code = 'IMAGE_TOO_LARGE';
      throw error;
    }
    const recordFingerprint = fingerprintDataUrl(record.dataUrl);
    if (indexItem.fingerprint && indexItem.fingerprint !== recordFingerprint) {
      const error = new Error('Stored image metadata no longer matches its data.');
      error.code = 'CORRUPT_IMAGE';
      throw error;
    }

    const thumbnailDataUrl = validThumbnailDataUrl(record.thumbnailDataUrl)
      ? record.thumbnailDataUrl
      : await enqueueOffscreenOperation(async () => {
        try {
          await setupOffscreenDocument('offscreen.html');
          const response = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'CREATE_THUMBNAIL',
            dataUrl: record.dataUrl
          });
          if (!response?.success || !validThumbnailDataUrl(response.thumbnailDataUrl)) {
            throw new Error(response?.error || 'Could not create image preview.');
          }
          return response.thumbnailDataUrl;
        } finally {
          await closeOffscreenDocument();
        }
      });

    if (indexItem.source !== 'legacy') {
      await enqueueImageMutation(async () => {
        const currentIndex = sanitizeIndex(await readStoredIndexOnly());
        const currentItem = currentIndex.find((item) => item.id === indexItem.id);
        if (!currentItem
            || currentItem.source === 'legacy'
            || currentItem.fingerprint !== indexItem.fingerprint
            || currentItem.dataLength !== indexItem.dataLength) return;

        // Older V2 indexes may not have a fingerprint. Confirm their full data
        // only on this compatibility path before committing a reusable cache.
        if (!currentItem.fingerprint) {
          const currentRecord = await readImageRecord(currentItem);
          if (!currentRecord || fingerprintDataUrl(currentRecord.dataUrl) !== recordFingerprint) return;
        } else if (currentItem.fingerprint !== recordFingerprint) {
          return;
        }

        await chrome.storage.local.set({
          [thumbnailKey]: makeStoredThumbnail(
            currentItem.id,
            currentItem.fingerprint,
            thumbnailDataUrl
          )
        });
      });
    }
    return thumbnailDataUrl;
  })().finally(() => thumbnailRequests.delete(requestKey));
  thumbnailRequests.set(requestKey, request);
  return request;
}

function getFileTypeCategory(ext, mime) {
  ext = (ext || '').toLowerCase();
  mime = (mime || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext) || mime.startsWith('image/')) return 'image';
  if (ext === 'pdf' || mime.includes('pdf')) return 'pdf';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext) || mime.startsWith('video/')) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext) || mime.startsWith('audio/')) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || mime.includes('zip') || mime.includes('compressed')) return 'archive';
  if (['exe', 'msi', 'bat', 'cmd'].includes(ext)) return 'exe';
  return 'file';
}

function getMimeFromExt(ext) {
  const mimes = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
    avif: 'image/avif', mp4: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', zip: 'application/zip',
    txt: 'text/plain', json: 'application/json'
  };
  return mimes[(ext || '').toLowerCase()] || 'application/octet-stream';
}

function getDownloadNameAndExt(item) {
  const name = typeof item?.filename === 'string' && item.filename
    ? item.filename.split(/[\\/]/).pop()
    : 'download';
  const dot = name.lastIndexOf('.');
  return {
    name,
    ext: dot > -1 ? name.slice(dot + 1).toLowerCase() : ''
  };
}

function supportedDownloadPreviewMime(value) {
  const mime = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  if (mime === 'image/jpg' || mime === 'image/pjpeg') return 'image/jpeg';
  return SUPPORTED_DOWNLOAD_IMAGE_PREVIEW_MIMES.has(mime) ? mime : '';
}

function supportedDownloadVideoPreviewMime(value) {
  const mime = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  return SUPPORTED_DOWNLOAD_VIDEO_PREVIEW_MIMES.has(mime) ? mime : '';
}

function getDownloadPreviewType(item, ext = getDownloadNameAndExt(item).ext) {
  const advertisedMime = supportedDownloadPreviewMime(item?.mime);
  if (advertisedMime) return { kind: 'image', mime: advertisedMime };
  const inferredImageMime = supportedDownloadPreviewMime(getMimeFromExt(ext));
  if (inferredImageMime) return { kind: 'image', mime: inferredImageMime };

  const advertisedVideoMime = supportedDownloadVideoPreviewMime(item?.mime);
  if (advertisedVideoMime) return { kind: 'video', mime: advertisedVideoMime };
  const inferredVideoMime = supportedDownloadVideoPreviewMime(getMimeFromExt(ext));
  return inferredVideoMime ? { kind: 'video', mime: inferredVideoMime } : null;
}

function downloadPreviewFingerprint(item) {
  return [
    item.id,
    item.startTime || '',
    item.endTime || '',
    Number.isFinite(item.fileSize) ? item.fileSize : '',
    item.filename || ''
  ].join(':');
}

function makeDownloadPreviewError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rememberDownloadThumbnail(fingerprint, thumbnailDataUrl) {
  downloadThumbnailCache.delete(fingerprint);
  downloadThumbnailCache.set(fingerprint, thumbnailDataUrl);
  while (downloadThumbnailCache.size > MAX_DOWNLOAD_THUMBNAIL_CACHE_ENTRIES) {
    downloadThumbnailCache.delete(downloadThumbnailCache.keys().next().value);
  }
}

function promiseWithTimeout(promise, timeoutMs, error) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(reason);
      }
    );
  });
}

async function fetchDownloadPreviewSource(item, previewType) {
  const maxBytes = previewType.kind === 'video'
    ? MAX_DOWNLOAD_VIDEO_PREVIEW_SOURCE_BYTES
    : MAX_DOWNLOAD_IMAGE_PREVIEW_SOURCE_BYTES;
  const knownSize = Number(item.fileSize);
  if (Number.isFinite(knownSize) && knownSize > maxBytes) {
    throw makeDownloadPreviewError(`This ${previewType.kind} is too large for a quick preview.`, 'DOWNLOAD_PREVIEW_TOO_LARGE');
  }

  const url = item.finalUrl || item.url;
  if (!/^https?:\/\//i.test(url || '')) {
    throw makeDownloadPreviewError('This file cannot be previewed from its download source.', 'DOWNLOAD_PREVIEW_UNAVAILABLE');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_THUMBNAIL_FETCH_TIMEOUT_MS);
  try {
    const options = {
      signal: controller.signal,
      credentials: 'include'
    };
    // The stream is canceled as soon as it crosses the bounded preview limit.
    // Fetch the complete image because partial-range responses often cannot be
    // decoded, and servers are free to ignore Range anyway.
    const response = await fetch(url, options);
    if (!response.ok) {
      throw makeDownloadPreviewError(`Image preview request failed (${response.status}).`, 'DOWNLOAD_PREVIEW_FETCH_FAILED');
    }

    const contentRange = response.headers.get('content-range') || '';
    const rangeTotalMatch = contentRange.match(/\/(\d+)$/);
    const rangeTotal = rangeTotalMatch ? Number(rangeTotalMatch[1]) : NaN;
    const advertisedLength = Number(response.headers.get('content-length'));
    if ((Number.isFinite(rangeTotal) && rangeTotal > maxBytes)
        || (Number.isFinite(advertisedLength) && advertisedLength > maxBytes)) {
      throw makeDownloadPreviewError(`This ${previewType.kind} is too large for a quick preview.`, 'DOWNLOAD_PREVIEW_TOO_LARGE');
    }

    const responseTypeHeader = response.headers.get('content-type') || '';
    const responseImageMime = supportedDownloadPreviewMime(responseTypeHeader);
    const responseVideoMime = supportedDownloadVideoPreviewMime(responseTypeHeader);
    const responseType = responseImageMime || responseVideoMime;
    const normalizedHeader = responseTypeHeader.split(';', 1)[0].trim().toLowerCase();
    if (normalizedHeader && normalizedHeader !== 'application/octet-stream'
        && (!responseType || (previewType.kind === 'image' ? !responseImageMime : !responseVideoMime))) {
      throw makeDownloadPreviewError('The download source did not return the expected preview format.', 'UNSUPPORTED_DOWNLOAD_PREVIEW');
    }

    const chunks = [];
    let receivedBytes = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) {
          await reader.cancel();
          throw makeDownloadPreviewError(`This ${previewType.kind} is too large for a quick preview.`, 'DOWNLOAD_PREVIEW_TOO_LARGE');
        }
        chunks.push(value);
      }
    } else {
      const buffer = await response.arrayBuffer();
      receivedBytes = buffer.byteLength;
      if (receivedBytes > maxBytes) {
        throw makeDownloadPreviewError(`This ${previewType.kind} is too large for a quick preview.`, 'DOWNLOAD_PREVIEW_TOO_LARGE');
      }
      chunks.push(buffer);
    }
    if (receivedBytes === 0) {
      throw makeDownloadPreviewError('The downloaded file is empty.', 'DOWNLOAD_PREVIEW_UNAVAILABLE');
    }

    const sourceDataUrl = await blobToDataURL(new Blob(chunks, { type: responseType || previewType.mime }));
    const maxDataUrlLength = Math.ceil(maxBytes * 4 / 3) + 1024;
    if (typeof sourceDataUrl !== 'string'
        || !sourceDataUrl.startsWith(`data:${previewType.kind}/`)
        || sourceDataUrl.length > maxDataUrlLength) {
      throw makeDownloadPreviewError('The media preview source is invalid.', 'DOWNLOAD_PREVIEW_TOO_LARGE');
    }
    return sourceDataUrl;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw makeDownloadPreviewError('Media preview timed out.', 'DOWNLOAD_PREVIEW_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function createDownloadThumbnail(item, previewType) {
  const sourceDataUrl = await fetchDownloadPreviewSource(item, previewType);
  return enqueueOffscreenOperation(async () => {
    try {
      await setupOffscreenDocument('offscreen.html');
      const response = await promiseWithTimeout(
        chrome.runtime.sendMessage({
          target: 'offscreen',
          action: previewType.kind === 'video' ? 'CREATE_VIDEO_THUMBNAIL' : 'CREATE_THUMBNAIL',
          dataUrl: sourceDataUrl
        }),
        DOWNLOAD_THUMBNAIL_RENDER_TIMEOUT_MS,
        makeDownloadPreviewError('Media preview rendering timed out.', 'DOWNLOAD_PREVIEW_TIMEOUT')
      );
      if (!response?.success || !validThumbnailDataUrl(response.thumbnailDataUrl)) {
        throw makeDownloadPreviewError(
          response?.error || 'Could not create a media preview.',
          'DOWNLOAD_PREVIEW_RENDER_FAILED'
        );
      }
      return response.thumbnailDataUrl;
    } finally {
      await closeOffscreenDocument();
    }
  });
}

async function getDownloadThumbnail(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId });
  const item = Array.isArray(items) ? items[0] : null;
  if (!item || item.state !== 'complete' || item.exists === false) {
    throw makeDownloadPreviewError('Download is unavailable.', 'DOWNLOAD_NOT_FOUND');
  }
  const { ext } = getDownloadNameAndExt(item);
  const previewType = getDownloadPreviewType(item, ext);
  if (!previewType) {
    throw makeDownloadPreviewError('This file type does not support a preview.', 'UNSUPPORTED_DOWNLOAD_PREVIEW');
  }

  const fingerprint = downloadPreviewFingerprint(item);
  if (downloadThumbnailCache.has(fingerprint)) {
    const cached = downloadThumbnailCache.get(fingerprint);
    downloadThumbnailCache.delete(fingerprint);
    downloadThumbnailCache.set(fingerprint, cached);
    return cached;
  }
  if (downloadThumbnailRequests.has(fingerprint)) return downloadThumbnailRequests.get(fingerprint);

  const request = createDownloadThumbnail(item, previewType)
    .then((thumbnailDataUrl) => {
      rememberDownloadThumbnail(fingerprint, thumbnailDataUrl);
      return thumbnailDataUrl;
    })
    .finally(() => downloadThumbnailRequests.delete(fingerprint));
  downloadThumbnailRequests.set(fingerprint, request);
  return request;
}

function senderHostname(sender) {
  try {
    return new URL(sender?.url || sender?.tab?.url || '').hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

function isExtensionPageSender(sender) {
  const extensionOrigin = chrome.runtime.getURL('');
  return [sender?.url, sender?.origin].some((value) =>
    typeof value === 'string' && value.startsWith(extensionOrigin)
  );
}

function registerPickerSession(token, sender) {
  if (!/^[a-f0-9]{32}$/.test(token || '') || !Number.isInteger(sender?.tab?.id)) return false;
  let parentOrigin = '';
  try {
    parentOrigin = typeof sender.tab.url === 'string' ? new URL(sender.tab.url).origin : '';
  } catch (error) {}
  pickerSessions.set(token, createPickerSession(
    sender.tab.id,
    parentOrigin === 'null' ? '' : parentOrigin
  ));
  return true;
}

function createPickerSession(tabId, parentOrigin) {
  return {
    tabId,
    parentOrigin,
    expiresAt: Date.now() + PICKER_SESSION_TTL_MS,
    clipboardAuthorized: true,
    commandIds: new Set()
  };
}

function consumePickerSession(token, sender) {
  const session = pickerSessions.get(token);
  const valid = !!session
    && session.expiresAt >= Date.now()
    && Number.isInteger(sender?.tab?.id)
    && sender.tab.id === session.tabId
    && session.clipboardAuthorized;
  if (valid) session.clipboardAuthorized = false;
  return valid;
}

function isPickerDocumentSender(sender) {
  try {
    const senderUrl = new URL(sender?.url || '');
    const extensionUrl = new URL(chrome.runtime.getURL('picker.html'));
    // Dynamic web-accessible URLs can use a randomized host. Chrome still
    // identifies the sender with this extension's runtime id; constrain the
    // remaining URL to an extension-scheme picker document only.
    return sender?.id === chrome.runtime.id
      && senderUrl.protocol === 'chrome-extension:'
      && (senderUrl.pathname === extensionUrl.pathname || senderUrl.pathname.endsWith('/picker.html'));
  } catch (error) {
    return false;
  }
}

function normalizePickerRelay(message) {
  if (!message || message.action !== 'RELAY_PICKER_COMMAND') return null;
  if (!PICKER_COMMAND_TYPES.has(message.type)) return null;
  if (!/^[a-f0-9]{32}$/.test(message.token || '')) return null;
  if (!/^[a-f0-9]{24,64}$/.test(message.commandId || '')) return null;
  const command = {
    action: 'PICKER_COMMAND',
    type: message.type,
    token: message.token,
    commandId: message.commandId,
    parentOrigin: typeof message.parentOrigin === 'string' ? message.parentOrigin : ''
  };
  if (message.type === 'CIP_PICK_IMAGE') {
    if (!isValidImageId(message.imageId)) return null;
    command.imageId = message.imageId;
  }
  if (message.type === 'CIP_PICK_DOWNLOAD') {
    if (!Number.isSafeInteger(message.downloadId) || message.downloadId < 0) return null;
    command.downloadId = message.downloadId;
    command.name = typeof message.name === 'string' ? message.name.slice(0, 255) : 'download';
  }
  if (message.type === 'CIP_PICK_BATCH') {
    if (!Array.isArray(message.items) || message.items.length === 0 || message.items.length > 50) return null;
    const validItems = [];
    for (const item of message.items) {
      if (!item || typeof item !== 'object') return null;
      if (item.kind === 'image') {
        if (!isValidImageId(item.id)) return null;
        validItems.push({ kind: 'image', id: item.id });
      } else if (item.kind === 'download') {
        if (!Number.isSafeInteger(item.id) || item.id < 0) return null;
        validItems.push({
          kind: 'download',
          id: item.id,
          name: typeof item.name === 'string' ? item.name.slice(0, 255) : 'download'
        });
      } else {
        return null;
      }
    }
    if (validItems.length === 0) return null;
    command.items = validItems;
  }
  return command;
}

async function revalidatePickerSession(command, sender) {
  if (!Number.isInteger(sender?.tab?.id)) return null;
  const tabId = sender.tab.id;
  let tabOrigin = '';
  try {
    tabOrigin = new URL(sender.tab.url || '').origin;
    if (tabOrigin === 'null') tabOrigin = '';
  } catch (error) {}
  if (tabOrigin !== command.parentOrigin) return null;

  const existingChallenge = pickerSessionChallenges.get(command.token);
  if (existingChallenge) return existingChallenge;

  const challenge = (async () => {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'PICKER_SESSION_CHALLENGE',
        token: command.token,
        parentOrigin: command.parentOrigin
      });
      if (!response?.success) return null;

      // REGISTER_PICKER_SESSION may have won the race while the content script
      // answered. Reuse it when it describes this exact tab-bound picker.
      const current = pickerSessions.get(command.token);
      if (current && current.tabId === tabId && current.parentOrigin === command.parentOrigin) return current;

      const recovered = createPickerSession(tabId, command.parentOrigin);
      pickerSessions.set(command.token, recovered);
      return recovered;
    } catch (error) {
      return null;
    }
  })();
  pickerSessionChallenges.set(command.token, challenge);
  try {
    return await challenge;
  } finally {
    if (pickerSessionChallenges.get(command.token) === challenge) {
      pickerSessionChallenges.delete(command.token);
    }
  }
}

async function relayPickerCommand(message, sender) {
  const command = normalizePickerRelay(message);
  if (!command || !isPickerDocumentSender(sender)) {
    return { success: false, code: 'INVALID_PICKER_COMMAND' };
  }
  let session = pickerSessions.get(command.token);
  if (!session) session = await revalidatePickerSession(command, sender);
  if (!session) return { success: false, code: 'INVALID_PICKER_SESSION' };
  if (Number.isInteger(sender?.tab?.id) && sender.tab.id !== session.tabId) {
    return { success: false, code: 'INVALID_PICKER_TAB' };
  }
  if (session.expiresAt < Date.now() || command.parentOrigin !== session.parentOrigin) {
    pickerSessions.delete(command.token);
    return { success: false, code: 'EXPIRED_PICKER_SESSION' };
  }
  if (session.commandIds.has(command.commandId)) return { success: true, duplicate: true };
  session.commandIds.add(command.commandId);
  while (session.commandIds.size > 64) session.commandIds.delete(session.commandIds.values().next().value);
  session.expiresAt = Date.now() + PICKER_SESSION_TTL_MS;

  try {
    const response = await chrome.tabs.sendMessage(session.tabId, command);
    if (response?.success) return response;
    session.commandIds.delete(command.commandId);
    return { success: false, code: response?.code || 'HOST_REJECTED_COMMAND' };
  } catch (error) {
    session.commandIds.delete(command.commandId);
    return { success: false, code: 'HOST_UNAVAILABLE', error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return false;

  if (message.action === 'GET_DOMAIN_STATE') {
    chrome.storage.local.get('disabledDomains')
      .then((data) => {
        const list = Array.isArray(data.disabledDomains) ? data.disabledDomains : [];
        const hostname = senderHostname(sender);
        sendResponse({ success: true, disabled: !!hostname && list.includes(hostname) });
      })
      .catch((error) => sendResponse({ success: false, disabled: false, error: error.message }));
    return true;
  }

  if (message.action === 'REGISTER_PICKER_SESSION') {
    sendResponse({ success: registerPickerSession(message.token, sender) });
    return false;
  }

  if (message.action === 'UNREGISTER_PICKER_SESSION') {
    const session = pickerSessions.get(message.token);
    const validSender = session
      && Number.isInteger(sender?.tab?.id)
      && sender.tab.id === session.tabId;
    if (validSender) pickerSessions.delete(message.token);
    sendResponse({ success: !!validSender });
    return false;
  }

  if (message.action === 'RELAY_PICKER_COMMAND') {
    relayPickerCommand(message, sender).then(sendResponse);
    return true;
  }

  if (message.action === 'AUTO_CHECK_CLIPBOARD') {
    if (!isExtensionPageSender(sender) && !consumePickerSession(message.sessionToken, sender)) {
      sendResponse({ success: false, found: false, saved: false, code: 'USER_ACTION_REQUIRED', error: 'Use the extension picker or popup to sync the clipboard.' });
      return false;
    }
    autoCheckClipboard()
      .then((result) => sendResponse({ success: !result.error, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'SAVE_IMAGE') {
    saveImage(message.image)
      .then(async (saved) => {
        await updateBadge();
        sendResponse({ success: true, saved });
      })
      .catch((error) => sendResponse({
        success: false,
        code: error.code || 'SAVE_FAILED',
        error: error.message
      }));
    return true;
  }

  if (message.action === 'GET_IMAGE_LIST') {
    ensureImageStore()
      .then(({ index, state }) => {
        const offset = Math.max(0, Number.isInteger(message.offset) ? message.offset : 0);
        const limit = Math.min(
          MAX_IMAGE_LIST_PAGE_SIZE,
          Math.max(1, Number.isInteger(message.limit) ? message.limit : MAX_IMAGE_LIST_PAGE_SIZE)
        );
        const images = index.slice(offset, offset + limit).map(publicMetadata);
        sendResponse({
          success: true,
          images,
          total: index.length,
          hasMore: offset + images.length < index.length || state?.phase !== 'done',
          migration: migrationSummary(state)
        });
      })
      .catch((error) => sendResponse({ success: false, code: error.code || 'LIST_FAILED', error: error.message }));
    return true;
  }

  if (message.action === 'GET_IMAGE_DATA') {
    if (!isValidImageId(message.id)) {
      sendResponse({ success: false, code: 'INVALID_ID', error: 'Invalid image id.' });
      return false;
    }

    (async () => {
      try {
        const index = await readImageIndex();
        const indexItem = index.find((item) => item.id === message.id);
        if (!indexItem) {
          return sendResponse({ success: false, code: 'NOT_FOUND', error: 'Image no longer exists.' });
        }
        if (indexItem.dataLength > MAX_IMAGE_RESPONSE_LENGTH) {
          return sendResponse({ success: false, code: 'IMAGE_TOO_LARGE', error: 'This legacy image is too large to transfer.' });
        }

        const record = await readImageRecord(indexItem);
        if (!record) {
          return sendResponse({ success: false, code: 'CORRUPT_IMAGE', error: 'Stored image data is unavailable.' });
        }
        if (record.dataUrl.length > MAX_IMAGE_RESPONSE_LENGTH) {
          return sendResponse({ success: false, code: 'IMAGE_TOO_LARGE', error: 'This legacy image is too large to transfer.' });
        }
        sendResponse({
          success: true,
          image: {
            id: indexItem.id,
            dataUrl: record.dataUrl,
            mimeType: record.mimeType,
            size: record.size
          }
        });
      } catch (error) {
        sendResponse({ success: false, code: 'IMAGE_READ_FAILED', error: error.message });
      }
    })();
    return true;
  }

  if (message.action === 'GET_IMAGE_THUMBNAIL') {
    if (!isValidImageId(message.id)) {
      sendResponse({ success: false, code: 'INVALID_ID', error: 'Invalid image id.' });
      return false;
    }

    (async () => {
      try {
        const index = await readImageIndex();
        const indexItem = index.find((item) => item.id === message.id);
        if (!indexItem) {
          return sendResponse({ success: false, code: 'NOT_FOUND', error: 'Image no longer exists.' });
        }
        const thumbnailDataUrl = await getImageThumbnail(indexItem);
        sendResponse({
          success: true,
          id: indexItem.id,
          thumbnailDataUrl
        });
      } catch (error) {
        sendResponse({ success: false, code: error.code || 'THUMBNAIL_FAILED', error: error.message });
      }
    })();
    return true;
  }

  // Backward-compatible response for content scripts that were injected before
  // an extension reload. The response is deliberately kept well below 64 MiB.
  if (message.action === 'GET_IMAGES') {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ success: false, images: [], code: 'REFRESH_REQUIRED', error: 'Refresh this tab after reloading the extension.' });
      return false;
    }
    (async () => {
      try {
        const index = await readImageIndex();
        const images = [];
        let responseSize = 1024;
        for (const indexItem of index) {
          if (indexItem.dataLength <= 0 || indexItem.dataLength > LEGACY_RESPONSE_BUDGET) continue;
          if (responseSize + indexItem.dataLength + 1024 > LEGACY_RESPONSE_BUDGET) continue;
          const record = await readImageRecord(indexItem);
          if (!record) continue;
          if (record.dataUrl.length > LEGACY_RESPONSE_BUDGET
              || responseSize + record.dataUrl.length + 1024 > LEGACY_RESPONSE_BUDGET) continue;
          images.push({
            id: indexItem.id,
            dataUrl: record.dataUrl,
            mimeType: record.mimeType,
            width: indexItem.width,
            height: indexItem.height,
            size: record.size,
            timestamp: indexItem.timestamp,
            hidden: indexItem.hidden
          });
          responseSize += record.dataUrl.length + 1024;
        }
        sendResponse({ success: true, images, total: index.length, truncated: images.length < index.length });
      } catch (error) {
        sendResponse({ success: false, images: [], code: 'LIST_FAILED', error: error.message });
      }
    })();
    return true;
  }

  if (message.action === 'GET_RECENT_DOWNLOADS') {
    chrome.downloads.search({ state: 'complete', limit: 12, orderBy: ['-startTime'] }, (items) => {
      if (chrome.runtime.lastError || !Array.isArray(items)) {
        sendResponse({ success: false, downloads: [], error: chrome.runtime.lastError?.message });
        return;
      }
      const downloads = items.map((item) => {
        const { name, ext } = getDownloadNameAndExt(item);
        const mime = item.mime || getMimeFromExt(ext);
        return {
          id: item.id,
          name,
          ext,
          mime,
          fileSize: item.fileSize || 0,
          category: getFileTypeCategory(ext, item.mime),
          previewKind: getDownloadPreviewType(item, ext)?.kind || '',
          previewable: !!getDownloadPreviewType(item, ext),
          startTime: item.startTime
        };
      });
      sendResponse({ success: true, downloads });
    });
    return true;
  }

  if (message.action === 'GET_DOWNLOAD_THUMBNAIL') {
    if ((!isExtensionPageSender(sender) && !isPickerDocumentSender(sender))
        || !Number.isSafeInteger(message.downloadId)
        || message.downloadId < 0) {
      sendResponse({
        success: false,
        code: 'INVALID_DOWNLOAD_PREVIEW_REQUEST',
        error: 'Invalid download preview request.'
      });
      return false;
    }
    getDownloadThumbnail(message.downloadId)
      .then((thumbnailDataUrl) => sendResponse({
        success: true,
        downloadId: message.downloadId,
        thumbnailDataUrl
      }))
      .catch((error) => sendResponse({
        success: false,
        code: error.code || 'DOWNLOAD_PREVIEW_FAILED',
        error: error.message
      }));
    return true;
  }

  if (message.action === 'FETCH_DOWNLOAD_DATA') {
    (async () => {
      try {
        if (!Number.isInteger(message.downloadId)) throw new Error('Invalid download id.');
        const items = await chrome.downloads.search({ id: message.downloadId });
        const item = Array.isArray(items) ? items[0] : null;
        if (!item || item.state !== 'complete') throw new Error('Download is unavailable.');
        const url = item.finalUrl || item.url;
        if (!/^https?:\/\//i.test(url || '')) throw new Error('This download must be selected from disk.');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(url, { signal: controller.signal, credentials: 'include' });
          if (!response.ok) throw new Error(`Download request failed (${response.status}).`);
          const advertisedLength = Number(response.headers.get('content-length'));
          if (Number.isFinite(advertisedLength) && advertisedLength > MAX_DOWNLOAD_BYTES) {
            throw new Error('This download is too large for quick upload.');
          }

          const chunks = [];
          let receivedBytes = 0;
          if (response.body?.getReader) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              receivedBytes += value.byteLength;
              if (receivedBytes > MAX_DOWNLOAD_BYTES) {
                await reader.cancel();
                throw new Error('This download is too large for quick upload.');
              }
              chunks.push(value);
            }
          } else {
            const buffer = await response.arrayBuffer();
            receivedBytes = buffer.byteLength;
            if (receivedBytes > MAX_DOWNLOAD_BYTES) throw new Error('This download is too large for quick upload.');
            chunks.push(buffer);
          }

          const blob = new Blob(chunks, {
            type: response.headers.get('content-type') || item.mime || 'application/octet-stream'
          });
          const dataUrl = await blobToDataURL(blob);
          sendResponse({ success: true, dataUrl });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.action === 'DELETE_IMAGE') {
    deleteImage(message.id)
      .then(async () => {
        await updateBadge();
        sendResponse({ success: true });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'TOGGLE_HIDE_IMAGE') {
    toggleHideImage(message.id)
      .then(async (result) => {
        await updateBadge();
        sendResponse({ success: true, ...result });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'CLEAR_ALL') {
    clearAllImages()
      .then(async () => {
        await updateBadge([]);
        sendResponse({ success: true });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'FETCH_SYSTEM_CLIPBOARD') {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ success: false, found: false, saved: false, code: 'USER_ACTION_REQUIRED', error: 'Use the extension popup to sync the clipboard.' });
      return false;
    }
    autoCheckClipboard()
      .then((result) => sendResponse({
        success: !result.error,
        found: result.found,
        saved: result.saved,
        error: result.error
      }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});

function enqueueImageMutation(operation) {
  const result = imageMutationQueue.then(operation);
  imageMutationQueue = result.catch(() => {});
  return result;
}

function saveImage(newImage) {
  return enqueueImageMutation(() => saveImageNow(newImage));
}

function validateNewImage(newImage) {
  if (!newImage || typeof newImage.dataUrl !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(newImage.dataUrl)) {
    const error = new Error('Invalid image data.');
    error.code = 'INVALID_IMAGE';
    throw error;
  }
  if (newImage.dataUrl.length > MAX_NEW_IMAGE_DATA_URL_LENGTH) {
    const error = new Error('Image is too large. Capture or paste a smaller image.');
    error.code = 'IMAGE_TOO_LARGE';
    throw error;
  }
  if (decodedBase64Bytes(newImage.dataUrl) > MAX_NEW_IMAGE_BYTES) {
    const error = new Error('Image is too large. Capture or paste a smaller image.');
    error.code = 'IMAGE_TOO_LARGE';
    throw error;
  }
}

async function saveImageNow(newImage) {
  validateNewImage(newImage);
  let index = await readCompleteImageIndex();
  const requestedId = isValidImageId(newImage.id) ? newImage.id : makeImageId();
  const fingerprint = fingerprintDataUrl(newImage.dataUrl);
  let duplicate = null;
  for (const candidate of index.filter((item) => item.fingerprint && item.fingerprint === fingerprint)) {
    const candidateRecord = await readImageRecord(candidate);
    if (candidateRecord?.dataUrl === newImage.dataUrl) {
      duplicate = candidate;
      break;
    }
  }
  if (duplicate && index[0]?.id === duplicate.id) return false;
  let id = duplicate?.id || requestedId;
  while (index.some((item) => item.id === id && item.id !== duplicate?.id)) id = makeImageId();

  const record = normalizeStoredRecord({ ...newImage, id, fingerprint }, id);
  if (!record) throw new Error('Invalid image data.');
  const metadata = metadataFromRecord(record, duplicate?.hidden || false);

  const writes = { [imageStorageKey(id)]: imageRecordForStorage(record) };
  if (validThumbnailDataUrl(record.thumbnailDataUrl)) {
    writes[thumbnailStorageKey(id)] = makeStoredThumbnail(
      id,
      record.fingerprint,
      record.thumbnailDataUrl
    );
  }
  await chrome.storage.local.set(writes);
  const removed = [];
  index = index.filter((item) => {
    if (item.id === duplicate?.id || item.id === id) {
      if (item.id !== id) removed.push(item);
      return false;
    }
    return true;
  });
  index.unshift(metadata);
  const retention = enforceActiveImageLimit(index, [id]);
  index = retention.index;
  removed.push(...retention.removed);
  await chrome.storage.local.set({ [IMAGE_INDEX_KEY]: index });
  await removeImageRecords(removed);
  notifyImagesChanged();
  return true;
}

function toggleHideImage(id) {
  return enqueueImageMutation(async () => {
    if (!isValidImageId(id)) throw new Error('Invalid image id.');
    const index = await readCompleteImageIndex();
    const current = index.find((item) => item.id === id);
    if (!current) throw new Error('Image no longer exists.');
    const hidden = !current.hidden;
    const updated = index.map((item) => {
      if (item.id !== id) return item;
      return { ...item, hidden };
    });
    // Restoring a protected image at capacity keeps that image and rotates out
    // the oldest other active record. Hiding never causes record eviction.
    const retention = hidden
      ? { index: updated, removed: [] }
      : enforceActiveImageLimit(updated, [id]);
    await chrome.storage.local.set({ [IMAGE_INDEX_KEY]: retention.index });
    await removeImageRecords(retention.removed);
    notifyImagesChanged();
    return {
      hidden,
      removedIds: retention.removed.map((item) => item.id)
    };
  });
}

function deleteImage(id) {
  return enqueueImageMutation(async () => {
    if (!isValidImageId(id)) throw new Error('Invalid image id.');
    const index = await readCompleteImageIndex();
    const removed = index.filter((item) => item.id === id);
    if (removed.length === 0) throw new Error('Image no longer exists.');
    await chrome.storage.local.set({
      [IMAGE_INDEX_KEY]: index.filter((item) => item.id !== id)
    });
    await removeImageRecords(removed);
    notifyImagesChanged();
  });
}

function clearAllImages() {
  return enqueueImageMutation(async () => {
    const stored = await chrome.storage.local.get([IMAGE_INDEX_KEY, IMAGE_MIGRATION_KEY]);
    const index = sanitizeIndex(stored[IMAGE_INDEX_KEY]);
    const priorState = normalizeMigrationState(stored[IMAGE_MIGRATION_KEY]);
    const keys = new Set([
      ...index.flatMap((item) => [
        ...(item.source !== 'legacy' ? [imageStorageKey(item.id)] : []),
        thumbnailStorageKey(item.id)
      ]),
      ...(priorState?.entries || []).flatMap((item) => [
        imageStorageKey(item.id),
        thumbnailStorageKey(item.id)
      ]),
      ...(priorState?.supersededKeys || []),
      ...(priorState?.keysToDelete || [])
    ]);
    // A crash can occur after writing the next deterministic record but before
    // checkpointing it, so include that one possible key in the clearing WAL.
    if (priorState?.phase === 'copy' && priorState.next < priorState.sourceCount) {
      const occupiedIds = new Set((priorState.entries || []).map((entry) => entry.id));
      const pendingId = uniqueLegacyImageId(priorState.next, occupiedIds);
      keys.add(imageStorageKey(pendingId));
      keys.add(thumbnailStorageKey(pendingId));
    }
    const clearingState = {
      version: 2,
      phase: 'clearing',
      next: 0,
      sourceCount: 0,
      entries: [],
      keysToDelete: [...keys]
    };
    await chrome.storage.local.set({ [IMAGE_MIGRATION_KEY]: clearingState });
    await chrome.storage.local.set({ [IMAGE_INDEX_KEY]: [] });
    await chrome.storage.local.remove([LEGACY_IMAGES_KEY, ...keys]);
    await chrome.storage.local.set({
      [IMAGE_MIGRATION_KEY]: { version: 2, phase: 'done', next: 0, sourceCount: 0, entries: [] }
    });
    legacyMigrationCache = null;
    notifyImagesChanged();
  });
}

async function removeImageRecords(items) {
  const keys = items.flatMap((item) => {
    if (!item || !isValidImageId(item.id)) return [];
    return [
      ...(item.source !== 'legacy' ? [imageStorageKey(item.id)] : []),
      thumbnailStorageKey(item.id)
    ];
  });
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

function notifyImagesChanged() {
  chrome.tabs.query({})
    .then((tabs) => Promise.allSettled(
      tabs
        .filter((tab) => Number.isInteger(tab.id))
        .map((tab) => chrome.tabs.sendMessage(tab.id, { action: 'IMAGES_CHANGED' }))
    ))
    .catch(() => {});
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read file data.'));
    reader.readAsDataURL(blob);
  });
}

// Restore the badge without starting the potentially expensive legacy migration.
// Migration advances only while an extension UI is actively requesting it.
updateBadge().catch(() => {});
