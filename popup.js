document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('image-grid');
  const skeletonGrid = document.getElementById('skeleton-grid');
  const emptyState = document.getElementById('empty-state');
  const emptyTitle = document.getElementById('empty-title');
  const emptyDescription = document.getElementById('empty-description');
  const emptySyncButton = document.getElementById('empty-sync-btn');
  const countSpan = document.getElementById('storage-count');
  const clearButton = document.getElementById('clear-all-btn');
  const syncButton = document.getElementById('sync-clipboard-btn');
  const syncLabel = document.getElementById('sync-label');
  const syncHint = document.getElementById('sync-hint');
  const syncSpinner = document.getElementById('sync-spinner');
  const testButton = document.getElementById('open-test-page');
  const siteButton = document.getElementById('toggle-site-btn');
  const siteToggleLabel = document.getElementById('site-toggle-label');
  const siteStatus = document.getElementById('site-status');
  const activeTabButton = document.getElementById('active-tab-btn');
  const hiddenTabButton = document.getElementById('toggle-vault-btn');
  const activeCount = document.getElementById('active-count');
  const hiddenCount = document.getElementById('hidden-count');
  const gallerySpinner = document.getElementById('gallery-spinner');
  const content = document.querySelector('.content');
  const statusBanner = document.getElementById('status-banner');
  const statusTitle = document.getElementById('status-title');
  const statusDetail = document.getElementById('status-detail');
  const migrationProgress = document.getElementById('migration-progress');
  const migrationProgressBar = document.getElementById('migration-progress-bar');
  const retryButton = document.getElementById('retry-load-btn');

  let currentDomain = '';
  let currentTabId = null;
  let currentView = 'active';
  let cachedImages = [];
  let galleryTotal = 0;
  let loadRevision = 0;
  let migrationTimer = null;
  let galleryMigrating = false;
  let hasCompletedInitialLoad = false;
  let previewObserver = null;
  let previewGeneration = 0;
  let activePreviewRequests = 0;
  let clearConfirmationTimer = null;

  const previewQueue = [];
  const previewCache = new Map();
  const MAX_PREVIEW_CONCURRENCY = 2;
  const PREVIEW_CACHE_LIMIT = 50;

  initializeDomainState();
  renderSkeletons(4);
  loadImages();

  async function initializeDomainState() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      currentTabId = Number.isInteger(tab?.id) ? tab.id : null;
      currentDomain = tab?.url ? new URL(tab.url).hostname.toLowerCase() : '';
      await updateDomainState();
    } catch (error) {
      siteStatus.textContent = 'Unavailable on this page';
      siteToggleLabel.textContent = 'Site control unavailable';
      siteButton.disabled = true;
    }
  }

  async function updateDomainState() {
    if (!currentDomain) {
      siteStatus.textContent = 'Unavailable on this browser page';
      siteToggleLabel.textContent = 'Extension ready';
      siteButton.disabled = true;
      return;
    }

    const data = await chrome.storage.local.get('disabledDomains');
    const list = Array.isArray(data.disabledDomains) ? data.disabledDomains : [];
    const disabled = list.includes(currentDomain);
    siteButton.classList.toggle('is-disabled', disabled);
    siteButton.setAttribute('aria-pressed', String(!disabled));
    siteToggleLabel.textContent = disabled ? 'Disabled on this site' : 'Enabled on this site';
    siteStatus.textContent = currentDomain;
  }

  siteButton.addEventListener('click', async () => {
    if (!currentDomain || siteButton.disabled) return;
    siteButton.disabled = true;
    try {
      const data = await chrome.storage.local.get('disabledDomains');
      const list = Array.isArray(data.disabledDomains) ? data.disabledDomains : [];
      const wasDisabled = list.includes(currentDomain);
      const updated = wasDisabled
        ? list.filter((domain) => domain !== currentDomain)
        : [...list, currentDomain];
      await chrome.storage.local.set({ disabledDomains: updated });
      await updateDomainState();
      if (currentTabId !== null) {
        chrome.tabs.sendMessage(currentTabId, {
          action: 'DOMAIN_STATE_CHANGED',
          disabled: !wasDisabled
        }).catch(() => {});
      }
    } catch (error) {
      showToast(error.message || 'Could not update this site.');
    } finally {
      siteButton.disabled = false;
    }
  });

  activeTabButton.addEventListener('click', () => switchView('active'));
  hiddenTabButton.addEventListener('click', () => switchView('hidden'));

  function switchView(view) {
    if (currentView === view) return;
    currentView = view;
    activeTabButton.classList.toggle('is-active', view === 'active');
    hiddenTabButton.classList.toggle('is-active', view === 'hidden');
    activeTabButton.setAttribute('aria-selected', String(view === 'active'));
    hiddenTabButton.setAttribute('aria-selected', String(view === 'hidden'));
    renderGallery();
    content.scrollTop = 0;
  }

  async function loadImages({ quiet = false } = {}) {
    const revision = ++loadRevision;
    setGalleryRefreshing(true);
    if (!quiet && !hasCompletedInitialLoad && cachedImages.length === 0) renderSkeletons(4);

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'GET_IMAGE_LIST',
        limit: 50
      });
      if (revision !== loadRevision) return;
      if (!response?.success) throw new Error(response?.error || 'Could not load saved images.');

      cachedImages = Array.isArray(response.images) ? response.images : [];
      galleryTotal = Math.max(cachedImages.length, Number(response.total) || 0);
      hasCompletedInitialLoad = true;
      updateCounts();
      renderGallery();

      if (response.migration?.complete === false) {
        galleryMigrating = true;
        const processed = Math.max(0, Number(response.migration.processed) || 0);
        const total = Math.max(processed, Number(response.migration.total) || 0);
        galleryTotal = Math.max(galleryTotal, total);
        updateCounts();
        showMigrationBanner(processed, total);
        renderMigrationSkeletons(total - processed);
        setSyncAvailability();
        clearTimeout(migrationTimer);
        migrationTimer = setTimeout(() => loadImages({ quiet: true }), 380);
      } else {
        galleryMigrating = false;
        clearTimeout(migrationTimer);
        hideStatusBanner();
        hideSkeletons();
        setSyncAvailability();
      }
    } catch (error) {
      if (revision !== loadRevision) return;
      galleryMigrating = false;
      hideSkeletons();
      showErrorBanner(
        /context invalidated/i.test(error.message || '')
          ? 'Extension was updated'
          : 'Gallery could not load',
        /context invalidated/i.test(error.message || '')
          ? 'Refresh this popup and any open website tabs.'
          : 'Your saved images are still on this device.'
      );
      if (cachedImages.length === 0) {
        showEmptyState(
          'Your images are safe',
          'Try loading the gallery again. Nothing has been deleted.',
          'Retry',
          'retry'
        );
      }
      setSyncAvailability();
    } finally {
      if (revision === loadRevision) setGalleryRefreshing(galleryMigrating);
    }
  }

  function updateCounts() {
    const activeImages = cachedImages.filter((image) => !image.hidden);
    const hiddenImages = cachedImages.filter((image) => image.hidden);
    activeCount.textContent = String(activeImages.length);
    hiddenCount.textContent = String(hiddenImages.length);
    countSpan.textContent = `${galleryTotal} image${galleryTotal === 1 ? '' : 's'} saved locally`;
    clearButton.disabled = galleryTotal === 0;
  }

  function renderGallery() {
    const visibleImages = cachedImages.filter((image) => currentView === 'hidden' ? image.hidden : !image.hidden);
    updateCounts();

    if (visibleImages.length === 0) {
      grid.hidden = true;
      grid.replaceChildren();
      if (!galleryMigrating) {
        showEmptyState(
          currentView === 'hidden' ? 'Nothing hidden yet' : 'Your gallery is ready',
          currentView === 'hidden'
            ? 'Hide an image from the Gallery view and it will appear here.'
            : 'Copy an image, then add it from your clipboard.',
          currentView === 'hidden' ? 'Back to gallery' : 'Add first image',
          currentView === 'hidden' ? 'gallery' : 'sync'
        );
      } else {
        emptyState.hidden = true;
      }
      disconnectPreviews();
      return;
    }

    emptyState.hidden = true;
    grid.hidden = false;
    reconcileCards(visibleImages);
  }

  function reconcileCards(images) {
    const existingCards = new Map(
      Array.from(grid.querySelectorAll('.card[data-image-id]')).map((card) => [card.dataset.imageId, card])
    );
    const desiredIds = new Set(images.map((image) => image.id));
    let cursor = grid.firstElementChild;

    for (const image of images) {
      let card = existingCards.get(image.id);
      if (!card) card = createCard(image);
      updateCardMetadata(card, image);
      if (card !== cursor) grid.insertBefore(card, cursor);
      else cursor = cursor.nextElementSibling;
      if (!card.querySelector('.card-preview')?.classList.contains('is-ready')) observeCardPreview(card);
    }

    Array.from(grid.querySelectorAll('.card[data-image-id]')).forEach((card) => {
      if (!desiredIds.has(card.dataset.imageId)) card.remove();
    });
  }

  function createCard(image) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.imageId = image.id;

    const previewContainer = document.createElement('div');
    previewContainer.className = 'card-img';

    const preview = document.createElement('img');
    preview.className = 'card-preview';
    preview.alt = 'Saved clipboard image';
    preview.decoding = 'async';
    preview.dataset.imageId = image.id;

    const errorMark = document.createElement('span');
    errorMark.className = 'preview-error-mark';
    errorMark.textContent = '↻';
    errorMark.title = 'Preview unavailable';

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const hideButton = document.createElement('button');
    hideButton.className = 'card-action card-hide';
    hideButton.type = 'button';
    hideButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.7"/></svg>';
    hideButton.addEventListener('click', () => toggleHidden(card));

    const deleteButton = document.createElement('button');
    deleteButton.className = 'card-action card-delete';
    deleteButton.type = 'button';
    deleteButton.title = 'Delete image';
    deleteButton.setAttribute('aria-label', 'Delete image');
    deleteButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V4.75A.75.75 0 0 1 9.75 4h4.5a.75.75 0 0 1 .75.75V7m-8.5 0 .75 12h9.5l.75-12M10 11v4.5M14 11v4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    deleteButton.addEventListener('click', () => deleteImage(card));

    actions.append(hideButton, deleteButton);
    previewContainer.append(preview, errorMark, actions);

    const metadata = document.createElement('div');
    metadata.className = 'card-meta';
    const dimensions = document.createElement('span');
    dimensions.className = 'card-dimensions';
    const timestamp = document.createElement('span');
    timestamp.className = 'card-time';
    metadata.append(dimensions, timestamp);
    card.append(previewContainer, metadata);
    return card;
  }

  function updateCardMetadata(card, image) {
    card.dataset.imageId = image.id;
    card.dataset.hidden = String(!!image.hidden);
    card.querySelector('.card-dimensions').textContent = image.width && image.height
      ? `${image.width} × ${image.height}`
      : 'Saved image';
    card.querySelector('.card-time').textContent = formatTimeAgo(image.timestamp);
    const hideButton = card.querySelector('.card-hide');
    const hideLabel = image.hidden ? 'Restore image to gallery' : 'Hide image';
    hideButton.title = hideLabel;
    hideButton.setAttribute('aria-label', hideLabel);
  }

  async function toggleHidden(card) {
    const imageId = card.dataset.imageId;
    const button = card.querySelector('.card-hide');
    if (!imageId || button.disabled) return;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'TOGGLE_HIDE_IMAGE', id: imageId });
      if (!response?.success) throw new Error(response?.error || 'Could not update image.');
      const image = cachedImages.find((item) => item.id === imageId);
      if (image) image.hidden = !image.hidden;
      renderGallery();
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not update image.');
    }
  }

  async function deleteImage(card) {
    const imageId = card.dataset.imageId;
    const button = card.querySelector('.card-delete');
    if (!imageId || button.disabled) return;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'DELETE_IMAGE', id: imageId });
      if (!response?.success) throw new Error(response?.error || 'Could not delete image.');
      cachedImages = cachedImages.filter((item) => item.id !== imageId);
      galleryTotal = Math.max(0, galleryTotal - 1);
      previewCache.delete(imageId);
      card.remove();
      renderGallery();
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not delete image.');
    }
  }

  function ensurePreviewObserver() {
    if (previewObserver || !('IntersectionObserver' in window)) return;
    previewObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        previewObserver?.unobserve(entry.target);
        enqueuePreview(entry.target);
      });
    }, { root: content, rootMargin: '100px' });
  }

  function observeCardPreview(card) {
    const preview = card.querySelector('.card-preview');
    if (!preview || preview.dataset.previewQueued === 'true') return;
    ensurePreviewObserver();
    if (previewObserver) previewObserver.observe(preview);
    else enqueuePreview(preview);
  }

  function enqueuePreview(preview) {
    if (!preview?.isConnected || preview.dataset.previewQueued === 'true') return;
    preview.dataset.previewQueued = 'true';
    previewQueue.push({ preview, generation: previewGeneration });
    pumpPreviewQueue();
  }

  function pumpPreviewQueue() {
    while (activePreviewRequests < MAX_PREVIEW_CONCURRENCY && previewQueue.length > 0) {
      const job = previewQueue.shift();
      if (!job.preview.isConnected) continue;
      activePreviewRequests++;
      hydratePreview(job.preview, job.generation)
        .catch(() => {})
        .finally(() => {
          activePreviewRequests--;
          pumpPreviewQueue();
        });
    }
  }

  async function getPreviewData(imageId) {
    if (previewCache.has(imageId)) {
      const cached = previewCache.get(imageId);
      previewCache.delete(imageId);
      previewCache.set(imageId, cached);
      return cached;
    }

    const request = chrome.runtime.sendMessage({ action: 'GET_IMAGE_THUMBNAIL', id: imageId })
      .then((response) => {
        if (!response?.success || response.id !== imageId || typeof response.thumbnailDataUrl !== 'string') {
          throw new Error(response?.error || 'Preview unavailable.');
        }
        return response.thumbnailDataUrl;
      })
      .catch((error) => {
        previewCache.delete(imageId);
        throw error;
      });

    previewCache.set(imageId, request);
    while (previewCache.size > PREVIEW_CACHE_LIMIT) previewCache.delete(previewCache.keys().next().value);
    return request;
  }

  async function hydratePreview(preview, generation) {
    const imageId = preview?.dataset.imageId;
    const container = preview?.closest('.card-img');
    if (!imageId || !preview.isConnected || !container) return;

    try {
      const dataUrl = await getPreviewData(imageId);
      if (!preview.isConnected || preview.dataset.imageId !== imageId) return;
      preview.src = dataUrl;
      try {
        await preview.decode();
      } catch (error) {
        if (!preview.complete || !preview.naturalWidth) throw error;
      }
      if (!preview.isConnected || preview.dataset.imageId !== imageId || generation !== previewGeneration) return;
      preview.classList.add('is-ready');
      container.classList.add('is-ready');
      container.classList.remove('is-error');
    } catch (error) {
      if (!preview.isConnected || generation !== previewGeneration) return;
      container.classList.add('is-error');
    }
  }

  function disconnectPreviews() {
    previewObserver?.disconnect();
    previewObserver = null;
    previewGeneration++;
    previewQueue.length = 0;
  }

  function renderSkeletons(count) {
    skeletonGrid.replaceChildren();
    for (let index = 0; index < count; index++) skeletonGrid.appendChild(createSkeletonCard());
    skeletonGrid.hidden = false;
    grid.hidden = true;
    emptyState.hidden = true;
  }

  function renderMigrationSkeletons(remaining) {
    if (remaining <= 0 || cachedImages.length >= 4) {
      hideSkeletons();
      return;
    }
    const count = Math.min(4 - cachedImages.length, Math.max(1, remaining));
    skeletonGrid.replaceChildren();
    for (let index = 0; index < count; index++) skeletonGrid.appendChild(createSkeletonCard());
    skeletonGrid.hidden = false;
  }

  function createSkeletonCard() {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML = '<div class="skeleton-image"></div><div class="skeleton-meta"><span class="skeleton-line"></span><span class="skeleton-line short"></span></div>';
    return card;
  }

  function hideSkeletons() {
    skeletonGrid.hidden = true;
    skeletonGrid.replaceChildren();
  }

  function showEmptyState(title, description, actionLabel, actionMode) {
    emptyTitle.textContent = title;
    emptyDescription.textContent = description;
    emptySyncButton.textContent = actionLabel;
    emptySyncButton.dataset.mode = actionMode;
    emptyState.hidden = false;
    grid.hidden = true;
  }

  emptySyncButton.addEventListener('click', () => {
    const mode = emptySyncButton.dataset.mode;
    if (mode === 'gallery') switchView('active');
    else if (mode === 'retry') loadImages();
    else syncButton.click();
  });

  function showMigrationBanner(processed, total) {
    const percentage = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 12;
    statusBanner.dataset.kind = 'migration';
    statusTitle.textContent = 'Optimizing your gallery';
    statusDetail.textContent = total > 0
      ? `${processed} of ${total} images prepared — keep this popup open.`
      : 'Preparing existing images for faster loading.';
    migrationProgress.hidden = false;
    migrationProgressBar.style.width = `${percentage}%`;
    retryButton.hidden = true;
    statusBanner.hidden = false;
  }

  function showErrorBanner(title, detail) {
    statusBanner.dataset.kind = 'error';
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
    migrationProgress.hidden = true;
    retryButton.hidden = false;
    statusBanner.hidden = false;
  }

  function hideStatusBanner() {
    statusBanner.hidden = true;
    statusBanner.removeAttribute('data-kind');
    migrationProgress.hidden = true;
    retryButton.hidden = true;
  }

  retryButton.addEventListener('click', () => loadImages());

  function setGalleryRefreshing(refreshing) {
    gallerySpinner.hidden = !refreshing;
  }

  function setSyncAvailability() {
    syncButton.disabled = galleryMigrating;
    if (galleryMigrating) {
      syncLabel.textContent = 'Finishing gallery setup';
      syncHint.textContent = 'Clipboard import will be ready shortly';
    } else {
      syncLabel.textContent = 'Add from clipboard';
      syncHint.textContent = 'Save the image you copied';
    }
  }

  syncButton.addEventListener('click', async () => {
    if (syncButton.disabled) return;
    syncButton.disabled = true;
    syncButton.classList.add('is-loading');
    syncButton.setAttribute('aria-busy', 'true');
    syncSpinner.hidden = false;
    syncLabel.textContent = 'Reading clipboard…';
    syncHint.textContent = 'Looking for a copied image';

    try {
      const response = await chrome.runtime.sendMessage({ action: 'FETCH_SYSTEM_CLIPBOARD' });
      if (!response?.success) throw new Error(response?.error || 'Could not access clipboard.');
      if (!response.found) {
        showToast('No image found. Copy an image first, then try again.');
        return;
      }
      if (response.saved) showToast('Image added to your gallery.');
      else showToast('That image is already your most recent item.');
      await loadImages({ quiet: true });
    } catch (error) {
      showToast(error.message || 'Could not access clipboard.');
    } finally {
      syncButton.classList.remove('is-loading');
      syncButton.removeAttribute('aria-busy');
      syncSpinner.hidden = true;
      setSyncAvailability();
    }
  });

  clearButton.addEventListener('click', async () => {
    if (clearButton.disabled) return;
    if (!clearButton.classList.contains('is-confirming')) {
      clearButton.classList.add('is-confirming');
      clearButton.title = 'Click again to clear all images';
      showToast('Click the trash button again to clear the entire gallery.');
      clearTimeout(clearConfirmationTimer);
      clearConfirmationTimer = setTimeout(resetClearConfirmation, 3500);
      return;
    }

    resetClearConfirmation();
    clearButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'CLEAR_ALL' });
      if (!response?.success) throw new Error(response?.error || 'Could not clear images.');
      cachedImages = [];
      galleryTotal = 0;
      previewCache.clear();
      hideStatusBanner();
      renderGallery();
      showToast('Gallery cleared.');
    } catch (error) {
      showToast(error.message || 'Could not clear images.');
    } finally {
      updateCounts();
    }
  });

  function resetClearConfirmation() {
    clearTimeout(clearConfirmationTimer);
    clearButton.classList.remove('is-confirming');
    clearButton.title = 'Clear all saved images';
  }

  function showToast(text) {
    let toast = document.querySelector('.popup-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'popup-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('visible');
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  testButton.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('test.html') });
  });

  function formatTimeAgo(timestamp) {
    if (!timestamp) return 'Recently';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
});
