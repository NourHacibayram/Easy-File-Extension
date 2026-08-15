function normalizePickerThumbnailResponse(response, previewKind, resourceId, maxLength) {
  const responseMatches = previewKind === 'download'
    ? response?.downloadId === resourceId
    : response?.id === resourceId;
  return response?.success
    && responseMatches
    && typeof response.thumbnailDataUrl === 'string'
    && response.thumbnailDataUrl.startsWith('data:image/')
    && response.thumbnailDataUrl.length <= maxLength
    ? response.thumbnailDataUrl
    : '';
}

(function () {
  if (typeof document === 'undefined') return;
  const query = new URLSearchParams(location.search);
  const token = query.get('token') || '';
  const expectedParentOrigin = parseParentOrigin(query.get('parentOrigin'));
  const clipboardGrid = document.getElementById('clipboard-grid');
  const downloadsGrid = document.getElementById('downloads-grid');
  const hiddenGrid = document.getElementById('hidden-grid');
  const hiddenSection = document.getElementById('hidden-section');
  const toggleHiddenButton = document.getElementById('toggle-hidden');
  const toggleMultiSelectButton = document.getElementById('toggle-multiselect');
  const multiSelectBar = document.getElementById('multiselect-bar');
  const multiSelectCount = document.getElementById('multiselect-count');
  const multiSelectSelectAllButton = document.getElementById('multiselect-select-all');
  const multiSelectClearButton = document.getElementById('multiselect-clear');
  const multiSelectAttachButton = document.getElementById('multiselect-attach');
  const multiSelectAttachLabel = document.getElementById('multiselect-attach-label');
  const sourceTabs = Array.from(document.querySelectorAll('[role="tab"][aria-controls]'));
  const sourcePanels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
  const migrationStatus = document.getElementById('migration-status');
  const pickerBody = document.getElementById('picker-body');

  const MAX_PREVIEW_CONCURRENCY = 2;
  const PREVIEW_CACHE_LIMIT = 16;
  const MAX_PREVIEW_DATA_URL_LENGTH = 512 * 1024;
  const IMAGE_LIST_PAGE_SIZE = 50;
  let images = [];
  let downloads = [];
  let hiddenVisible = false;
  let listInFlight = false;
  let listRefreshQueued = false;
  let listRetryTimer = null;
  let renderGeneration = 0;
  let previewObserver = null;
  let activePreviewRequests = 0;
  let toastTimer = null;
  let downloadsInFlight = false;
  let downloadsRefreshQueued = false;
  let multiSelectActive = false;
  const selectedItems = new Map();
  const previewQueue = [];
  const previewCache = new Map();

  if (!/^[a-f0-9]{32}$/.test(token) || window.parent === window) {
    showFatalState('This picker must be opened from an upload field.');
    return;
  }

  toggleMultiSelectButton?.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    setMultiSelectMode(!multiSelectActive);
  });

  multiSelectSelectAllButton?.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    selectVisibleTiles();
  });

  multiSelectClearButton?.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    clearSelection();
  });

  multiSelectAttachButton?.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    attachSelectedItems();
  });

  document.getElementById('show-all').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    sendToHost({ type: 'CIP_SHOW_ALL' });
  });

  document.getElementById('close-picker').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    sendToHost({ type: 'CIP_CLOSE' });
  });

  toggleHiddenButton?.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    activateSourceTab(document.getElementById('source-protected'));
  });

  sourceTabs.forEach((tab, index) => {
    tab.addEventListener('click', (event) => {
      if (event.isTrusted) activateSourceTab(tab);
    });
    tab.addEventListener('keydown', (event) => {
      if (!event.isTrusted || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let targetIndex = index;
      if (event.key === 'Home') targetIndex = 0;
      else if (event.key === 'End') targetIndex = sourceTabs.length - 1;
      else targetIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + sourceTabs.length) % sourceTabs.length;
      activateSourceTab(sourceTabs[targetIndex]);
      sourceTabs[targetIndex].focus();
    });
  });

  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') {
      if (multiSelectActive && selectedItems.size > 0) {
        clearSelection();
      } else {
        sendToHost({ type: 'CIP_CLOSE' });
      }
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (expectedParentOrigin && event.origin !== expectedParentOrigin) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.token !== token) return;
    if (message.type === 'CIP_HOST_REFRESH') {
      requestImageList();
      loadDownloads();
    }
    if (message.type === 'CIP_HOST_ERROR') {
      clearBusyTiles();
      showToast(typeof message.message === 'string' ? message.message : 'Could not attach this file.');
    }
  });

  renderGridState(clipboardGrid, 'Loading clipboard images...');
  renderGridState(downloadsGrid, 'Loading recent downloads...');
  requestImageList();
  loadDownloads();

  function parseParentOrigin(value) {
    try {
      if (!value) return '';
      const parsed = new URL(value);
      return ['http:', 'https:', 'file:', 'chrome-extension:'].includes(parsed.protocol) ? parsed.origin : '';
    } catch (error) {
      return '';
    }
  }

  function sendToHost(message) {
    const command = {
      ...message,
      token,
      parentOrigin: expectedParentOrigin,
      commandId: createCommandId()
    };
    // Keep the direct path for immediate feedback on Chromium versions that
    // preserve extension MessageEvent identity. The extension-internal relay
    // is the reliable path across dynamic WAR origins and source=null events;
    // both are idempotent through commandId.
    window.parent.postMessage(command, expectedParentOrigin || '*');
    chrome.runtime.sendMessage({ action: 'RELAY_PICKER_COMMAND', ...command })
      .then((response) => {
        if (!response?.success && message.type !== 'CIP_CLOSE') {
          clearBusyTiles();
          showToast('The page connection changed. Refresh the page and try again.');
        }
      })
      .catch(() => {
        if (message.type !== 'CIP_CLOSE') {
          clearBusyTiles();
          showToast('The extension was updated. Refresh the page and try again.');
        }
      });
  }

  function createCommandId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function activateSourceTab(tab) {
    if (!tab) return;
    const panelId = tab.getAttribute('aria-controls');
    sourceTabs.forEach((item) => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    sourcePanels.forEach((panel) => {
      panel.hidden = panel.id !== panelId;
    });
    hiddenVisible = panelId === 'hidden-section';
    toggleHiddenButton?.setAttribute('aria-expanded', String(hiddenVisible));
    if (hiddenVisible) renderHiddenImages();
    else observeVisiblePreviews();
    pickerBody.scrollTop = 0;
  }

  async function requestImageList() {
    if (listInFlight) {
      listRefreshQueued = true;
      return;
    }

    clearTimeout(listRetryTimer);
    listRetryTimer = null;
    listInFlight = true;
    try {
      const nextImages = [];
      const seenIds = new Set();
      let offset = 0;
      let maxReportedTotal = 0;
      let latestMigration = null;

      // `hasMore` also stays true while migration is producing future items.
      // Follow only totals reported by the bounded pages we actually receive;
      // the existing retry below will pick up future migration snapshots.
      while (true) {
        const page = await requestImageListPage(offset, IMAGE_LIST_PAGE_SIZE);
        if (page.migration) latestMigration = page.migration;
        appendUniqueImages(nextImages, seenIds, page.images);

        const nextOffset = offset + page.images.length;
        maxReportedTotal = Math.max(
          maxReportedTotal,
          normalizeImageListTotal(page.total, nextOffset),
          nextOffset
        );
        if (page.images.length === 0 || nextOffset >= maxReportedTotal) break;
        offset = nextOffset;
      }

      images = nextImages;
      discardRemovedPreviewCache();
      renderImageSections();
      updateMigrationStatus(latestMigration);

      if (latestMigration && latestMigration.complete === false) {
        listRetryTimer = setTimeout(() => requestImageList(), 500);
      }
    } catch (error) {
      renderGridState(clipboardGrid, /context invalidated/i.test(error.message || '')
        ? 'Extension updated. Refresh this page.'
        : 'Could not load clipboard images.', true);
      showToast(error.message || 'Could not load clipboard images.');
    } finally {
      listInFlight = false;
      if (listRefreshQueued) {
        listRefreshQueued = false;
        queueMicrotask(requestImageList);
      }
    }
  }

  async function requestImageListPage(offset, limit) {
    const response = await chrome.runtime.sendMessage({
      action: 'GET_IMAGE_LIST',
      offset,
      limit: Math.min(IMAGE_LIST_PAGE_SIZE, Math.max(1, limit))
    });
    if (!response?.success) {
      throw new Error(response?.error || 'Could not load clipboard images.');
    }
    return {
      images: Array.isArray(response.images) ? response.images : [],
      total: response.total,
      migration: response.migration && typeof response.migration === 'object'
        ? response.migration
        : null
    };
  }

  function normalizeImageListTotal(value, pageLength) {
    return Number.isSafeInteger(value) && value >= 0
      ? Math.max(value, pageLength)
      : pageLength;
  }

  function appendUniqueImages(target, seenIds, pageImages) {
    pageImages.forEach((image) => {
      if (!image || typeof image.id !== 'string' || !image.id || seenIds.has(image.id)) return;
      seenIds.add(image.id);
      target.push(image);
    });
  }

  function updateMigrationStatus(migration) {
    if (!migration || migration.complete !== false) {
      migrationStatus.hidden = true;
      migrationStatus.textContent = '';
      return;
    }

    const processed = Math.max(0, Number(migration.processed) || 0);
    const total = Math.max(processed, Number(migration.total) || 0);
    const phase = typeof migration.phase === 'string' && migration.phase ? ` (${migration.phase})` : '';
    migrationStatus.textContent = total > 0
      ? `Migrating saved gallery${phase}: ${processed} of ${total}. Existing images stay available while this finishes.`
      : `Migrating saved gallery${phase}. Existing images stay available while this finishes.`;
    migrationStatus.hidden = false;
  }

  async function loadDownloads() {
    if (downloadsInFlight) {
      downloadsRefreshQueued = true;
      return;
    }
    downloadsInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'GET_RECENT_DOWNLOADS' });
      if (!response?.success) throw new Error(response?.error || 'Could not load recent downloads.');
      downloads = Array.isArray(response.downloads) ? response.downloads : [];
      renderDownloads();
    } catch (error) {
      renderGridState(downloadsGrid, 'Could not load recent downloads.', true);
    } finally {
      downloadsInFlight = false;
      if (downloadsRefreshQueued) {
        downloadsRefreshQueued = false;
        queueMicrotask(loadDownloads);
      }
    }
  }

  function renderImageSections() {
    renderGeneration++;
    resetPreviewWork();
    const activeImages = images.filter((image) => !image.hidden).slice(0, 30);
    const hiddenImages = images.filter((image) => image.hidden);
    document.getElementById('clipboard-count').textContent = String(activeImages.length);
    document.getElementById('clipboard-tab-count').textContent = String(activeImages.length);
    document.getElementById('hidden-count').textContent = String(hiddenImages.length);
    document.getElementById('hidden-section-count').textContent = String(hiddenImages.length);

    clipboardGrid.replaceChildren();
    if (activeImages.length === 0) {
      renderGridState(clipboardGrid, 'No clipboard images yet.');
    } else {
      activeImages.forEach((image) => clipboardGrid.appendChild(createImageTile(image, false)));
    }

    if (hiddenVisible) renderHiddenImages(false);
    else hiddenGrid.replaceChildren();
    observeVisiblePreviews();
  }

  function renderHiddenImages(resetWork = true) {
    if (resetWork) {
      renderGeneration++;
      resetPreviewWork();
    }
    const hiddenImages = images.filter((image) => image.hidden);
    hiddenGrid.replaceChildren();
    if (hiddenImages.length === 0) {
      renderGridState(hiddenGrid, 'No protected images.');
    } else {
      hiddenImages.forEach((image) => hiddenGrid.appendChild(createImageTile(image, true)));
    }
    observeVisiblePreviews();
  }

  function setMultiSelectMode(active) {
    multiSelectActive = !!active;
    toggleMultiSelectButton?.setAttribute('aria-pressed', String(multiSelectActive));
    document.querySelector('.picker-shell')?.classList.toggle('is-multiselect-active', multiSelectActive);
    const label = document.getElementById('multiselect-toggle-label');
    if (label) label.textContent = multiSelectActive ? 'Done' : 'Select multiple';
    updateMultiSelectUI();
  }

  function toggleItemSelection(itemKey, itemData, clickedTile) {
    if (selectedItems.has(itemKey)) {
      selectedItems.delete(itemKey);
    } else {
      if (selectedItems.size >= 50) {
        showToast('You can select up to 50 files at once.');
        return;
      }
      selectedItems.set(itemKey, itemData);
    }
    syncTileSelectionDom(itemKey);
    updateMultiSelectUI();
  }

  function syncTileSelectionDom(itemKey) {
    const isSelected = selectedItems.has(itemKey);
    document.querySelectorAll(`.tile[data-item-key="${CSS.escape(itemKey)}"]`).forEach((tile) => {
      tile.classList.toggle('is-selected', isSelected);
      if (isSelected) {
        tile.setAttribute('aria-checked', 'true');
      } else {
        tile.removeAttribute('aria-checked');
      }
    });
  }

  function updateMultiSelectUI() {
    const count = selectedItems.size;
    if (multiSelectCount) multiSelectCount.textContent = `${count} selected`;
    if (multiSelectAttachLabel) {
      multiSelectAttachLabel.textContent = count > 0 ? `Attach selected (${count})` : 'Attach selected';
    }
    if (multiSelectAttachButton) {
      multiSelectAttachButton.disabled = count === 0;
      multiSelectAttachButton.removeAttribute('aria-busy');
    }
    const shell = document.querySelector('.picker-shell');
    if (multiSelectActive) {
      if (multiSelectBar) multiSelectBar.hidden = false;
      shell?.classList.add('has-multiselect-bar');
    } else {
      if (multiSelectBar) multiSelectBar.hidden = true;
      shell?.classList.remove('has-multiselect-bar');
    }
  }

  function selectVisibleTiles() {
    const activeSection = document.querySelector('.source-section:not([hidden])');
    if (!activeSection) return;
    const tiles = activeSection.querySelectorAll('.tile[data-item-key]');
    tiles.forEach((tile) => {
      const itemKey = tile.dataset.itemKey;
      if (!itemKey) return;
      if (itemKey.startsWith('image:')) {
        const id = tile.dataset.imageId;
        if (id && !selectedItems.has(itemKey) && selectedItems.size < 50) {
          selectedItems.set(itemKey, { kind: 'image', id });
          syncTileSelectionDom(itemKey);
        }
      } else if (itemKey.startsWith('download:')) {
        const downloadId = Number(tile.dataset.downloadId);
        const name = tile.dataset.downloadName || 'download';
        if (Number.isSafeInteger(downloadId) && !selectedItems.has(itemKey) && selectedItems.size < 50) {
          selectedItems.set(itemKey, { kind: 'download', id: downloadId, name });
          syncTileSelectionDom(itemKey);
        }
      }
    });
    updateMultiSelectUI();
  }

  function clearSelection() {
    selectedItems.clear();
    document.querySelectorAll('.tile.is-selected').forEach((tile) => {
      tile.classList.remove('is-selected');
      tile.removeAttribute('aria-checked');
    });
    updateMultiSelectUI();
  }

  function attachSelectedItems() {
    if (selectedItems.size === 0) return;
    multiSelectAttachButton?.setAttribute('aria-busy', 'true');
    selectedItems.forEach((item, itemKey) => {
      document.querySelectorAll(`.tile[data-item-key="${CSS.escape(itemKey)}"]`).forEach((tile) => {
        tile.setAttribute('aria-busy', 'true');
      });
    });
    sendToHost({
      type: 'CIP_PICK_BATCH',
      items: Array.from(selectedItems.values())
    });
  }

  function createImageTile(image, isHidden) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tile-wrap';

    const itemKey = `image:${image.id}`;
    const isSelected = selectedItems.has(itemKey);

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `tile${isSelected ? ' is-selected' : ''}`;
    tile.dataset.imageId = image.id;
    tile.dataset.itemKey = itemKey;
    if (isSelected) tile.setAttribute('aria-checked', 'true');
    tile.title = `Use ${image.width || 0} by ${image.height || 0} image`;
    tile.setAttribute('aria-label', `Attach ${image.width || 0} by ${image.height || 0} image`);

    const square = document.createElement('span');
    square.className = 'tile-square';
    const preview = document.createElement('img');
    preview.className = 'preview';
    preview.alt = '';
    preview.decoding = 'async';
    preview.dataset.imageId = image.id;
    preview.dataset.previewKind = 'clipboard';
    preview.dataset.previewKey = `clipboard:${image.id}`;
    preview.dataset.previewState = 'waiting';
    square.appendChild(preview);

    const check = document.createElement('span');
    check.className = 'tile-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    square.appendChild(check);

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = `${image.width || 0}x${image.height || 0}`;
    tile.append(square, label);
    tile.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || multiSelectActive) {
        if (!multiSelectActive) setMultiSelectMode(true);
        toggleItemSelection(itemKey, { kind: 'image', id: image.id }, tile);
      } else {
        tile.setAttribute('aria-busy', 'true');
        sendToHost({ type: 'CIP_PICK_IMAGE', imageId: image.id });
      }
    });

    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'hide-action';
    hideButton.title = isHidden ? 'Restore to recent gallery' : 'Protect image';
    hideButton.setAttribute('aria-label', hideButton.title);
    hideButton.textContent = isHidden ? '\u21a9' : '\u25c9';
    hideButton.addEventListener('click', async (event) => {
      if (!event.isTrusted || hideButton.disabled) return;
      hideButton.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ action: 'TOGGLE_HIDE_IMAGE', id: image.id });
        if (!response?.success) throw new Error(response?.error || 'Could not update this image.');
        requestImageList();
      } catch (error) {
        hideButton.disabled = false;
        showToast(error.message || 'Could not update this image.');
      }
    });

    wrapper.append(tile, hideButton);
    return wrapper;
  }

  function renderDownloads() {
    renderGeneration++;
    resetPreviewWork();
    document.getElementById('downloads-count').textContent = String(downloads.length);
    document.getElementById('downloads-tab-count').textContent = String(downloads.length);
    downloadsGrid.replaceChildren();
    if (downloads.length === 0) {
      renderGridState(downloadsGrid, 'No recent downloads.');
      return;
    }

    downloads.slice(0, 12).forEach((download) => {
      const itemKey = `download:${download.id}`;
      const isSelected = selectedItems.has(itemKey);

      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = `tile${isSelected ? ' is-selected' : ''}`;
      tile.dataset.downloadId = String(download.id);
      tile.dataset.downloadName = download.name || 'download';
      tile.dataset.itemKey = itemKey;
      if (isSelected) tile.setAttribute('aria-checked', 'true');
      tile.title = `Use ${download.name || 'download'}`;
      tile.setAttribute('aria-label', `Attach ${download.name || 'download'}`);

      const square = document.createElement('span');
      square.className = 'tile-square';
      if (download.previewable && Number.isSafeInteger(download.id)) {
        const preview = document.createElement('img');
        preview.className = 'preview';
        preview.alt = '';
        preview.decoding = 'async';
        preview.dataset.downloadId = String(download.id);
        preview.dataset.previewKind = 'download';
        preview.dataset.previewKey = `download:${download.id}`;
        preview.dataset.previewFallback = getDownloadLabel(download);
        preview.dataset.previewState = 'waiting';
        square.appendChild(preview);
        if (download.previewKind === 'video') {
          const badge = document.createElement('span');
          badge.className = 'media-badge';
          badge.textContent = 'Video';
          square.appendChild(badge);
        }
      } else {
        square.appendChild(createDownloadIcon(getDownloadLabel(download)));
      }

      const check = document.createElement('span');
      check.className = 'tile-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      square.appendChild(check);

      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = download.name || 'download';
      tile.append(square, label);
      tile.addEventListener('click', (event) => {
        if (!event.isTrusted || !Number.isInteger(download.id)) return;
        if (event.shiftKey || event.ctrlKey || event.metaKey || multiSelectActive) {
          if (!multiSelectActive) setMultiSelectMode(true);
          toggleItemSelection(itemKey, {
            kind: 'download',
            id: download.id,
            name: download.name || 'download'
          }, tile);
        } else {
          tile.setAttribute('aria-busy', 'true');
          sendToHost({
            type: 'CIP_PICK_DOWNLOAD',
            downloadId: download.id,
            name: download.name || 'download'
          });
        }
      });
      downloadsGrid.appendChild(tile);
    });
    discardRemovedDownloadPreviewCache();
    observeVisiblePreviews();
  }

  function createDownloadIcon(label) {
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = label;
    return icon;
  }

  function getDownloadLabel(download) {
    const ext = typeof download.ext === 'string' ? download.ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) : '';
    if (ext) return ext;
    const category = typeof download.category === 'string' ? download.category : 'file';
    return category.replace(/[^a-z]/gi, '').slice(0, 5) || 'file';
  }

  function observeVisiblePreviews() {
    ensurePreviewObserver();
    document.querySelectorAll('img.preview[data-preview-state="waiting"]').forEach((preview) => {
      if (previewObserver) previewObserver.observe(preview);
      else enqueuePreview(preview);
    });
  }

  function ensurePreviewObserver() {
    if (previewObserver || !('IntersectionObserver' in window)) return;
    previewObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        previewObserver.unobserve(entry.target);
        enqueuePreview(entry.target);
      });
    }, { root: pickerBody, rootMargin: '120px' });
  }

  function enqueuePreview(preview) {
    if (!preview.isConnected || preview.dataset.previewState !== 'waiting') return;
    preview.dataset.previewState = 'queued';
    const previewKind = preview.dataset.previewKind === 'download' ? 'download' : 'clipboard';
    const resourceId = previewKind === 'download'
      ? Number(preview.dataset.downloadId)
      : preview.dataset.imageId;
    previewQueue.push({
      preview,
      previewKind,
      previewKey: preview.dataset.previewKey || `${previewKind}:${resourceId}`,
      resourceId,
      generation: renderGeneration
    });
    pumpPreviewQueue();
  }

  function pumpPreviewQueue() {
    while (activePreviewRequests < MAX_PREVIEW_CONCURRENCY && previewQueue.length > 0) {
      const job = previewQueue.shift();
      if (!job.preview.isConnected || job.generation !== renderGeneration) continue;
      activePreviewRequests++;
      hydratePreview(job)
        .catch(() => {})
        .finally(() => {
          activePreviewRequests--;
          pumpPreviewQueue();
        });
    }
  }

  async function hydratePreview(job) {
    const { preview, previewKey, previewKind, generation } = job;
    preview.dataset.previewState = 'loading';
    try {
      const dataUrl = await getPreviewData(job);
      if (!preview.isConnected
          || generation !== renderGeneration
          || preview.dataset.previewKey !== previewKey) return;
      preview.src = dataUrl;
      if (typeof preview.decode === 'function') await preview.decode();
      if (!preview.isConnected
          || generation !== renderGeneration
          || preview.dataset.previewKey !== previewKey) return;
      preview.classList.add('loaded');
      preview.dataset.previewState = 'loaded';
    } catch (error) {
      if (!preview.isConnected || generation !== renderGeneration) return;
      if (previewKind === 'download') {
        preview.replaceWith(createDownloadIcon(preview.dataset.previewFallback || 'file'));
        return;
      }
      preview.classList.add('error');
      preview.dataset.previewState = 'error';
    }
  }

  async function getPreviewData({ previewKey, previewKind, resourceId }) {
    if (previewCache.has(previewKey)) {
      const cached = previewCache.get(previewKey);
      previewCache.delete(previewKey);
      previewCache.set(previewKey, cached);
      return cached;
    }

    const response = previewKind === 'download'
      ? await chrome.runtime.sendMessage({ action: 'GET_DOWNLOAD_THUMBNAIL', downloadId: resourceId })
      : await chrome.runtime.sendMessage({ action: 'GET_IMAGE_THUMBNAIL', id: resourceId });
    const thumbnailDataUrl = normalizePickerThumbnailResponse(
      response,
      previewKind,
      resourceId,
      MAX_PREVIEW_DATA_URL_LENGTH
    );
    if (!thumbnailDataUrl) {
      throw new Error(response?.error || 'Preview unavailable.');
    }
    previewCache.set(previewKey, thumbnailDataUrl);
    while (previewCache.size > PREVIEW_CACHE_LIMIT) {
      previewCache.delete(previewCache.keys().next().value);
    }
    return thumbnailDataUrl;
  }

  function resetPreviewWork() {
    previewObserver?.disconnect();
    previewObserver = null;
    previewQueue.length = 0;
    document.querySelectorAll('img.preview[data-preview-state="queued"], img.preview[data-preview-state="loading"]')
      .forEach((preview) => {
        preview.dataset.previewState = 'waiting';
      });
    // In-flight jobs are allowed to settle, but generation checks prevent them
    // from populating stale DOM. New requests still respect the global cap.
  }

  function discardRemovedPreviewCache() {
    const ids = new Set(images.map((image) => image.id));
    for (const key of previewCache.keys()) {
      if (key.startsWith('clipboard:') && !ids.has(key.slice('clipboard:'.length))) {
        previewCache.delete(key);
      }
    }
  }

  function discardRemovedDownloadPreviewCache() {
    const ids = new Set(downloads.map((download) => String(download.id)));
    for (const key of previewCache.keys()) {
      if (key.startsWith('download:') && !ids.has(key.slice('download:'.length))) {
        previewCache.delete(key);
      }
    }
  }

  function renderGridState(grid, message, isError = false) {
    const state = document.createElement('div');
    state.className = `grid-state${isError ? ' error' : ''}`;
    state.textContent = message;
    grid.replaceChildren(state);
  }

  function clearBusyTiles() {
    document.querySelectorAll('.tile[aria-busy="true"]').forEach((tile) => tile.removeAttribute('aria-busy'));
    multiSelectAttachButton?.removeAttribute('aria-busy');
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  function showFatalState(message) {
    renderGridState(clipboardGrid, message, true);
    renderGridState(downloadsGrid, 'Open an upload field to use this picker.');
    document.getElementById('show-all').disabled = true;
    if (toggleHiddenButton) toggleHiddenButton.disabled = true;
  }
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizePickerThumbnailResponse };
}
