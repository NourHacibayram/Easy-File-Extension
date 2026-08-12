(function () {
  const query = new URLSearchParams(location.search);
  const token = query.get('token') || '';
  const expectedParentOrigin = parseParentOrigin(query.get('parentOrigin'));
  const clipboardGrid = document.getElementById('clipboard-grid');
  const downloadsGrid = document.getElementById('downloads-grid');
  const hiddenGrid = document.getElementById('hidden-grid');
  const hiddenSection = document.getElementById('hidden-section');
  const toggleHiddenButton = document.getElementById('toggle-hidden');
  const migrationStatus = document.getElementById('migration-status');
  const pickerBody = document.getElementById('picker-body');

  const MAX_PREVIEW_CONCURRENCY = 2;
  const PREVIEW_CACHE_LIMIT = 16;
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
  const previewQueue = [];
  const previewCache = new Map();

  if (!/^[a-f0-9]{32}$/.test(token) || window.parent === window) {
    showFatalState('This picker must be opened from an upload field.');
    return;
  }

  document.getElementById('show-all').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    sendToHost({ type: 'CIP_SHOW_ALL' });
  });

  document.getElementById('close-picker').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    sendToHost({ type: 'CIP_CLOSE' });
  });

  toggleHiddenButton.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    hiddenVisible = !hiddenVisible;
    toggleHiddenButton.setAttribute('aria-expanded', String(hiddenVisible));
    toggleHiddenButton.title = hiddenVisible ? 'Hide hidden images' : 'Show hidden images';
    hiddenSection.hidden = !hiddenVisible;
    if (hiddenVisible) renderHiddenImages(false);
    else hiddenGrid.replaceChildren();
  });

  window.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'Escape') sendToHost({ type: 'CIP_CLOSE' });
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
    window.parent.postMessage({ ...message, token, parentOrigin: expectedParentOrigin }, expectedParentOrigin || '*');
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
      const response = await chrome.runtime.sendMessage({ action: 'GET_IMAGE_LIST', limit: 50 });
      if (!response?.success) throw new Error(response?.error || 'Could not load clipboard images.');
      images = Array.isArray(response.images) ? response.images : [];
      discardRemovedPreviewCache();
      renderImageSections();
      updateMigrationStatus(response.migration);

      if (response.migration && response.migration.complete === false) {
        listRetryTimer = setTimeout(() => requestImageList(), 150);
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
      renderGridState(hiddenGrid, 'No hidden images.');
    } else {
      hiddenImages.forEach((image) => hiddenGrid.appendChild(createImageTile(image, true)));
    }
    observeVisiblePreviews();
  }

  function createImageTile(image, isHidden) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tile-wrap';

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.imageId = image.id;
    tile.title = `Use ${image.width || 0} by ${image.height || 0} image`;

    const square = document.createElement('span');
    square.className = 'tile-square';
    const preview = document.createElement('img');
    preview.className = 'preview';
    preview.alt = '';
    preview.decoding = 'async';
    preview.dataset.imageId = image.id;
    preview.dataset.previewState = 'waiting';
    square.appendChild(preview);

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = `${image.width || 0}x${image.height || 0}`;
    tile.append(square, label);
    tile.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      tile.setAttribute('aria-busy', 'true');
      sendToHost({ type: 'CIP_PICK_IMAGE', imageId: image.id });
    });

    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'hide-action';
    hideButton.title = isHidden ? 'Restore image' : 'Hide image';
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
    document.getElementById('downloads-count').textContent = String(downloads.length);
    downloadsGrid.replaceChildren();
    if (downloads.length === 0) {
      renderGridState(downloadsGrid, 'No recent downloads.');
      return;
    }

    downloads.slice(0, 12).forEach((download) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.title = `Use ${download.name || 'download'}`;

      const square = document.createElement('span');
      square.className = 'tile-square';
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = getDownloadLabel(download);
      square.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = download.name || 'download';
      tile.append(square, label);
      tile.addEventListener('click', (event) => {
        if (!event.isTrusted || !Number.isInteger(download.id)) return;
        tile.setAttribute('aria-busy', 'true');
        sendToHost({
          type: 'CIP_PICK_DOWNLOAD',
          downloadId: download.id,
          name: download.name || 'download'
        });
      });
      downloadsGrid.appendChild(tile);
    });
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
    previewQueue.push({
      preview,
      imageId: preview.dataset.imageId,
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
    const { preview, imageId, generation } = job;
    preview.dataset.previewState = 'loading';
    try {
      const dataUrl = await getPreviewData(imageId);
      if (!preview.isConnected || generation !== renderGeneration || preview.dataset.imageId !== imageId) return;
      preview.src = dataUrl;
      preview.classList.add('loaded');
      preview.dataset.previewState = 'loaded';
    } catch (error) {
      if (!preview.isConnected || generation !== renderGeneration) return;
      preview.classList.add('error');
      preview.dataset.previewState = 'error';
    }
  }

  async function getPreviewData(imageId) {
    if (previewCache.has(imageId)) {
      const cached = previewCache.get(imageId);
      previewCache.delete(imageId);
      previewCache.set(imageId, cached);
      return cached;
    }

    const response = await chrome.runtime.sendMessage({ action: 'GET_IMAGE_THUMBNAIL', id: imageId });
    if (!response?.success || response.id !== imageId || typeof response.thumbnailDataUrl !== 'string') {
      throw new Error(response?.error || 'Preview unavailable.');
    }
    previewCache.set(imageId, response.thumbnailDataUrl);
    while (previewCache.size > PREVIEW_CACHE_LIMIT) {
      previewCache.delete(previewCache.keys().next().value);
    }
    return response.thumbnailDataUrl;
  }

  function resetPreviewWork() {
    previewObserver?.disconnect();
    previewObserver = null;
    previewQueue.length = 0;
    // In-flight jobs are allowed to settle, but generation checks prevent them
    // from populating stale DOM. New requests still respect the global cap.
  }

  function discardRemovedPreviewCache() {
    const ids = new Set(images.map((image) => image.id));
    for (const imageId of previewCache.keys()) {
      if (!ids.has(imageId)) previewCache.delete(imageId);
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
    toggleHiddenButton.disabled = true;
  }
})();
