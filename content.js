(function () {
  let targetInput = null;
  let activeModal = null;
  let isBypassing = false;
  let disabledDomains = [];
  let systemDirHandle = null;
  let trustedPageActions = [];

  // Load disabled domains
  chrome.storage.local.get(['disabledDomains'], (data) => {
    disabledDomains = data.disabledDomains || [];
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.disabledDomains) {
      disabledDomains = changes.disabledDomains.newValue || [];
    }
  });

  // Global Listeners for continuous auto-capture
  window.addEventListener('paste', handleGlobalPaste, true);
  window.addEventListener('focus', tryReadClipboardDirectly, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tryReadClipboardDirectly();
  });
  window.addEventListener('copy', () => {
    setTimeout(tryReadClipboardDirectly, 100);
  }, true);
  document.addEventListener('click', rememberTrustedPageAction, true);
  document.addEventListener('click', handleFileInputClick, true);
  document.addEventListener('click', () => {
    tryReadClipboardDirectly();
  }, true);

  // Auto update open modal whenever clipboard storage changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.clipboardImages && activeModal) {
      refreshModalData();
    }
  });

  // IndexedDB helper to store DirectoryHandle for system Downloads folder
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('CIP_Storage', 1);
      request.onupgradeneeded = (e) => {
        e.target.result.createObjectStore('handles');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getStoredDownloadsHandle() {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('handles', 'readonly');
        const store = tx.objectStore('handles');
        const req = store.get('downloadsDir');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function saveDownloadsHandle(handle) {
    try {
      const db = await openDB();
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'downloadsDir');
    } catch (e) {
      console.warn('Could not save downloads handle:', e);
    }
  }

  async function scanSystemDownloadsFolder(dirHandle) {
    if (!dirHandle) return [];
    try {
      const options = { mode: 'read' };
      if ((await dirHandle.queryPermission(options)) !== 'granted') {
        if ((await dirHandle.requestPermission(options)) !== 'granted') {
          return [];
        }
      }

      const files = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
          try {
            const file = await entry.getFile();
            const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
            files.push({
              id: 'sys_' + file.lastModified + '_' + Math.random().toString(36).substr(2, 4),
              name: file.name,
              size: file.size,
              type: file.type,
              lastModified: file.lastModified,
              fileObject: file,
              ext: ext,
              category: getFileTypeCategory(ext, file.type)
            });
          } catch (e) {}
        }
      }

      files.sort((a, b) => b.lastModified - a.lastModified);
      return files.slice(0, 15);
    } catch (e) {
      console.warn('Error scanning system downloads folder:', e);
      return [];
    }
  }

  function getFileTypeCategory(ext, mime) {
    ext = (ext || '').toLowerCase();
    mime = (mime || '').toLowerCase();

    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext) || mime.startsWith('image/')) return 'image';
    if (['pdf'].includes(ext) || mime.includes('pdf')) return 'pdf';
    if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext) || mime.startsWith('video/')) return 'video';
    if (['mp3', 'wav', 'ogg', 'flac'].includes(ext) || mime.startsWith('audio/')) return 'audio';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || mime.includes('zip')) return 'archive';
    if (['exe', 'msi', 'bat', 'cmd'].includes(ext)) return 'exe';
    if (['svg'].includes(ext)) return 'svg';
    return 'file';
  }

  function isImageInput(input) {
    if (!input) return false;
    const accept = (input.getAttribute('accept') || '').toLowerCase().trim();
    if (!accept || accept === '*' || accept.includes('image') || accept.includes('.png') || accept.includes('.jpg') || accept.includes('.jpeg') || accept.includes('.webp') || accept.includes('.gif') || accept.includes('.svg') || accept.includes('.bmp')) {
      return true;
    }
    return false;
  }

  function isDomainDisabled() {
    const currentHost = window.location.hostname.toLowerCase();
    return disabledDomains.some(domain => currentHost.includes(domain.toLowerCase()));
  }

  function handleGlobalPaste(e) {
    if (!e.clipboardData || !e.clipboardData.items) return;
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          blobToDataURL(blob).then(dataUrl => {
            getImageDimensions(dataUrl).then(meta => {
              const imageObj = {
                id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                dataUrl: dataUrl,
                mimeType: item.type,
                width: meta.width,
                height: meta.height,
                size: blob.size,
                timestamp: Date.now()
              };
              chrome.runtime.sendMessage({ action: 'SAVE_IMAGE', image: imageObj });
            });
          });
        }
      }
    }
  }

  let originalClickTrigger = null;

  function rememberTrustedPageAction(e) {
    if (!e.isTrusted || activeModal?.contains(e.target)) return;
    const action = e.target.closest?.('button, [role="button"], [role="menuitem"], label, a') || e.target;
    if (!action || action.matches?.('input[type="file"]')) return;

    trustedPageActions = trustedPageActions.filter(item => item !== action);
    trustedPageActions.push(action);
    if (trustedPageActions.length > 8) trustedPageActions.shift();
  }

  function isGeminiSite() {
    return window.location.hostname === 'gemini.google.com';
  }

  function findGeminiFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter(input => !input.disabled && input.dataset.cipTemporary !== 'true');
    return inputs.find(input => isImageInput(input)) || inputs[0] || null;
  }

  function handleGeminiUploadMenuClick(e) {
    if (!isGeminiSite() || !e.isTrusted || isBypassing || activeModal?.contains(e.target)) return;

    const action = e.target.closest?.('button, [role="button"], [role="menuitem"], [role="option"]');
    if (!action) return;

    const descriptor = getActionDescriptor(action);
    const label = `${descriptor.text} ${descriptor.ariaLabel} ${descriptor.title}`;
    if (!/(upload|attach|choose)\s+(a\s+)?files?/.test(label)) return;

    // Stop Gemini before it starts (and later abandons) its internal picker
    // lifecycle. Show All can now replay this same action from a clean state.
    e.preventDefault();
    e.stopImmediatePropagation();
    originalClickTrigger = action;
    targetInput = findGeminiFileInput();
    openClipboardPickerModal();
  }

  function getActionDescriptor(element) {
    if (!element) return null;
    return {
      text: (element.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase(),
      ariaLabel: (element.getAttribute?.('aria-label') || '').trim().toLowerCase(),
      title: (element.getAttribute?.('title') || '').trim().toLowerCase()
    };
  }

  function findMatchingPageAction(descriptor) {
    if (!descriptor) return null;
    const candidates = document.querySelectorAll('button, [role="button"], [role="menuitem"], label, a');
    return Array.from(candidates).find(candidate => {
      if (activeModal?.contains(candidate)) return false;
      const current = getActionDescriptor(candidate);
      return (descriptor.ariaLabel && current.ariaLabel === descriptor.ariaLabel)
        || (descriptor.title && current.title === descriptor.title)
        || (descriptor.text && current.text === descriptor.text);
    }) || null;
  }

  function replayGeminiUploadAction() {
    if (!isGeminiSite() || !originalClickTrigger) return false;

    const originalAction = originalClickTrigger;
    const descriptor = getActionDescriptor(originalAction);
    if (document.contains(originalAction)) {
      originalAction.click();
      return true;
    }

    // Gemini may remove the upload menu after it is clicked. Re-open it using
    // the preceding user action, then activate the newly-created equivalent
    // menu item while the Show All click still has user activation.
    const launcher = [...trustedPageActions].reverse().find(action =>
      action !== originalAction && document.contains(action) && !activeModal?.contains(action)
    );
    if (!launcher) return false;

    launcher.click();
    queueMicrotask(() => {
      const replacementAction = findMatchingPageAction(descriptor);
      if (replacementAction) replacementAction.click();
    });
    return true;
  }

  function handleFileInputClick(e) {
    const input = e.target.closest('input[type="file"]');
    if (!input) return;

    if (!isImageInput(input) || isDomainDisabled() || input.dataset.cipBypass === 'true' || isBypassing) {
      delete input.dataset.cipBypass;
      return;
    }

    // Only prevent default OS picker without stopping event bubbling
    e.preventDefault();

    targetInput = input;
    originalClickTrigger = trustedPageActions[trustedPageActions.length - 1] || e.target;
    openClipboardPickerModal();
  }

  function triggerNativeFileInput() {
    isBypassing = true;
    const useGeminiFileBridge = isGeminiSite();

    if (!useGeminiFileBridge && replayGeminiUploadAction()) {
      setTimeout(() => {
        isBypassing = false;
      }, 1500);
      return;
    }

    // Prefer the page's own input. Framework-heavy uploaders such as Gemini
    // attach private state and listeners to that exact element, so selecting a
    // file through a temporary input and copying FileList back can be ignored.
    let pageInput = !useGeminiFileBridge && targetInput && document.contains(targetInput) ? targetInput : null;
    if (!pageInput && !useGeminiFileBridge) {
      const candidates = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter(input => !input.disabled && input.dataset.cipTemporary !== 'true');
      const targetAccept = (targetInput?.accept || '').toLowerCase();
      pageInput = candidates.find(input => targetAccept && input.accept.toLowerCase() === targetAccept)
        || candidates.find(input => isImageInput(input))
        || candidates[0]
        || null;
    }

    if (pageInput) {
      targetInput = pageInput;
      pageInput.dataset.cipBypass = 'true';
      try {
        // showPicker opens the native chooser without synthesizing another
        // click through the site's UI/event handlers.
        if (typeof pageInput.showPicker === 'function') {
          pageInput.showPicker();
        } else {
          pageInput.click();
        }
        setTimeout(() => {
          delete pageInput.dataset.cipBypass;
          isBypassing = false;
        }, 1000);
        return;
      } catch (e) {
        delete pageInput.dataset.cipBypass;
        console.warn('Page file input click failed; using fallback picker:', e);
      }
    }

    // Fallback for pages that removed/replaced their input while the modal was open.
    const tempInput = document.createElement('input');
    tempInput.type = 'file';
    tempInput.style.position = 'fixed';
    tempInput.style.top = '-9999px';
    tempInput.style.left = '-9999px';
    tempInput.style.opacity = '0';
    tempInput.dataset.cipTemporary = 'true';
    if (targetInput && targetInput.accept) tempInput.accept = targetInput.accept;
    if (targetInput && targetInput.multiple) tempInput.multiple = targetInput.multiple;
    tempInput.dataset.cipBypass = 'true';

    document.body.appendChild(tempInput);

    tempInput.addEventListener('change', () => {
      if (tempInput.files && tempInput.files.length > 0) {
        attachFilesToInput(Array.from(tempInput.files));
      }
      setTimeout(() => tempInput.remove(), 200);
    }, { once: true });

    try {
      tempInput.click();
    } catch (e) {
      console.warn('Native click trigger failed:', e);
      tempInput.remove();
    }

    setTimeout(() => {
      isBypassing = false;
    }, 1000);
  }

  function attachFileToInput(file) {
    if (!file) return;
    attachFilesToInput([file]);
  }

  function attachFilesToInput(files) {
    files = Array.from(files || []).filter(Boolean);
    if (files.length === 0) return;
    const useGeminiBridge = isGeminiSite();

    const dataTransfer = new DataTransfer();
    files.forEach(file => dataTransfer.items.add(file));

    // 1. Populate Target File Input if in DOM
    let input = targetInput;
    if (!input || !document.contains(input)) {
      input = document.querySelector('input[type="file"]');
    }

    let deliveredToInput = false;
    if (input && document.contains(input)) {
      const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
      if (filesSetter) {
        try {
          filesSetter.call(input, dataTransfer.files);
        } catch (e) {
          input.files = dataTransfer.files;
        }
      } else {
        input.files = dataTransfer.files;
      }

      const eventOpts = { bubbles: true, composed: true, cancelable: true };
      input.dispatchEvent(new Event('input', eventOpts));
      input.dispatchEvent(new Event('change', eventOpts));
      deliveredToInput = true;
    }

    // A normal file input is the most compatible upload path. Dispatching the
    // same file again as drop/paste makes many sites enqueue it two or more
    // times and report it as an already-uploaded duplicate.
    if (deliveredToInput && !useGeminiBridge) {
      closeClipboardPickerModal();
      return;
    }

    // Fallback for rich editors that expose no file input: deliver one drop to
    // one suitable target. Do not broadcast both drop and paste across the page.
    const promptTargets = [];
    const richTextarea = document.querySelector('rich-textarea');
    if (richTextarea) promptTargets.push(richTextarea);

    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) promptTargets.push(editable);

    const textarea = document.querySelector('textarea');
    if (textarea) promptTargets.push(textarea);

    if (document.activeElement && document.activeElement !== document.body && !promptTargets.includes(document.activeElement)) {
      promptTargets.push(document.activeElement);
    }
    if (useGeminiBridge) {
      // Preserve the original delivery sequence that Gemini accepts. Keep it
      // isolated to Gemini so the broader event fan-out cannot duplicate files
      // on other websites.
      if (!promptTargets.includes(document.body)) promptTargets.push(document.body);
      promptTargets.forEach(target => {
        try {
          target.dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer
          }));
          target.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dataTransfer
          }));
        } catch (e) {}
      });
    } else {
      const fallbackTarget = promptTargets[0] || document.body;
      try {
        const dropEvent = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: dataTransfer
        });
        fallbackTarget.dispatchEvent(dropEvent);
      } catch (e) {}
    }

    closeClipboardPickerModal();
  }

  let lastBackgroundSyncTime = 0;
  async function tryReadClipboardDirectly() {
    // 1. Try page-context direct clipboard read FIRST (while user gesture is active!)
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              const dataUrl = await blobToDataURL(blob);
              const meta = await getImageDimensions(dataUrl);
              const imageObj = {
                id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                dataUrl: dataUrl,
                mimeType: type,
                width: meta.width,
                height: meta.height,
                size: blob.size,
                timestamp: Date.now()
              };
              await chrome.runtime.sendMessage({ action: 'SAVE_IMAGE', image: imageObj });
              return imageObj;
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Content Script] Direct clipboard read failed (user gesture may have expired or not active):', err);
    }

    // 2. If direct read failed or didn't find an image, fall back to background offscreen check (throttled to once per second)
    const now = Date.now();
    if (now - lastBackgroundSyncTime < 1000) return null;
    lastBackgroundSyncTime = now;

    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'AUTO_CHECK_CLIPBOARD' }, () => resolve());
      });
    } catch (err) {}
    return null;
  }

  // SVG Icon Generators matching screenshot
  function getIconSvg(category, ext) {
    if (category === 'pdf') {
      return `<svg class="cip-icon-svg" viewBox="0 0 48 56" fill="none">
        <rect width="48" height="56" rx="4" fill="#FFFFFF"/>
        <rect x="8" y="10" width="32" height="6" fill="#1F2937"/>
        <rect x="8" y="20" width="32" height="2" fill="#9CA3AF"/>
        <rect x="8" y="26" width="32" height="2" fill="#9CA3AF"/>
        <rect x="8" y="32" width="24" height="2" fill="#9CA3AF"/>
        <rect x="8" y="38" width="28" height="2" fill="#9CA3AF"/>
      </svg>`;
    }

    if (category === 'video' || category === 'audio') {
      return `<svg class="cip-icon-svg" viewBox="0 0 48 56" fill="none">
        <rect width="48" height="56" rx="4" fill="#FFFFFF"/>
        <circle cx="24" cy="30" r="10" fill="url(#playGrad)"/>
        <path d="M22 26L28 30L22 34V26Z" fill="#FFFFFF"/>
        <defs>
          <linearGradient id="playGrad" x1="14" y1="20" x2="34" y2="40" gradientUnits="userSpaceOnUse">
            <stop stop-color="#8B5CF6"/>
            <stop offset="1" stop-color="#EC4899"/>
          </linearGradient>
        </defs>
      </svg>`;
    }

    if (category === 'archive') {
      return `<svg width="46" height="46" viewBox="0 0 48 48" fill="none">
        <rect width="48" height="38" y="5" rx="6" fill="#F59E0B"/>
        <rect x="18" y="15" width="12" height="18" rx="2" fill="#1F2937"/>
        <rect x="22" y="18" width="4" height="12" fill="#D1D5DB"/>
      </svg>`;
    }

    if (category === 'exe') {
      return `<svg width="44" height="44" viewBox="0 0 48 48" fill="none">
        <rect width="48" height="48" rx="8" fill="#1E1B4B"/>
        <path d="M14 16H34V28H28V34H20V28H14V16Z" fill="#FFFFFF"/>
        <circle cx="20" cy="22" r="2" fill="#1E1B4B"/>
        <circle cx="28" cy="22" r="2" fill="#1E1B4B"/>
      </svg>`;
    }

    if (category === 'svg') {
      return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" rx="4" fill="#EF4444"/>
        <circle cx="12" cy="12" r="4" fill="#FFFFFF"/>
      </svg>`;
    }

    return `<svg class="cip-icon-svg" viewBox="0 0 48 56" fill="none">
      <rect width="48" height="56" rx="4" fill="#FFFFFF"/>
      <rect x="10" y="16" width="28" height="3" fill="#D1D5DB"/>
      <rect x="10" y="24" width="28" height="3" fill="#D1D5DB"/>
      <rect x="10" y="32" width="20" height="3" fill="#D1D5DB"/>
    </svg>`;
  }

  function createTileElement(imgSrc, labelText, category, onClickHandler, ext) {
    const item = document.createElement('div');
    item.className = 'cip-tile-item';

    const square = document.createElement('div');
    square.className = 'cip-tile-square';

    if (imgSrc) {
      const img = document.createElement('img');
      img.src = imgSrc;
      img.alt = labelText;
      square.appendChild(img);
    } else {
      square.innerHTML = getIconSvg(category, ext);
    }

    const label = document.createElement('div');
    label.className = 'cip-tile-label';
    label.textContent = labelText || '';
    label.title = labelText || '';

    item.appendChild(square);
    item.appendChild(label);
    item.addEventListener('click', onClickHandler);

    return item;
  }

  async function refreshModalData() {
    if (!activeModal) return;
    const clipGrid = activeModal.querySelector('#cip-clip-grid');
    const dlGrid = activeModal.querySelector('#cip-dl-grid');
    if (!clipGrid || !dlGrid) return;

    // Get Clipboard Images
    const response = await chrome.runtime.sendMessage({ action: 'GET_IMAGES' });
    const clipboardImages = (response && response.images) ? response.images : [];

    // Get System Downloads
    if (!systemDirHandle) {
      systemDirHandle = await getStoredDownloadsHandle();
    }

    let downloads = [];
    if (systemDirHandle) {
      downloads = await scanSystemDownloadsFolder(systemDirHandle);
    }

    if (downloads.length === 0) {
      const dlRes = await chrome.runtime.sendMessage({ action: 'GET_RECENT_DOWNLOADS' });
      downloads = (dlRes && dlRes.downloads) ? dlRes.downloads : [];
    }

    // Render Clipboard Grid (col 1)
    clipGrid.innerHTML = '';
    if (clipboardImages.length > 0) {
      clipboardImages.slice(0, 5).forEach((clipItem) => {
        const tile = createTileElement(
          clipItem.dataUrl,
          clipItem.width + 'x' + clipItem.height,
          'image',
          () => selectClipboardImage(clipItem)
        );
        clipGrid.appendChild(tile);
      });
    } else {
      const emptyTile = document.createElement('div');
      emptyTile.className = 'cip-tile-item';
      emptyTile.innerHTML = `<div class="cip-tile-square" style="color: #64748B; font-size: 0.72rem;">No Image</div><div class="cip-tile-label">Empty</div>`;
      clipGrid.appendChild(emptyTile);
    }

    // Render Downloaded Grid (cols 2-5)
    dlGrid.innerHTML = '';
    downloads.slice(0, 5).forEach((dl) => {
      let imgSrc = '';
      if (dl.category === 'image' && dl.fileObject) {
        imgSrc = URL.createObjectURL(dl.fileObject);
      }

      const tile = createTileElement(
        imgSrc,
        dl.name,
        dl.category,
        () => selectDownloadedFile(dl),
        dl.ext
      );
      dlGrid.appendChild(tile);
    });
  }

  async function openClipboardPickerModal() {
    closeClipboardPickerModal(); // Ensure single instance

    await tryReadClipboardDirectly();

    // Create backdrop container
    const backdrop = document.createElement('div');
    backdrop.id = 'cip-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeClipboardPickerModal();
    });

    const modalCard = document.createElement('div');
    modalCard.className = 'cip-modal-card';
    modalCard.addEventListener('click', (e) => e.stopPropagation());

    // Header matching screenshot: Show all files button left, icons right
    const header = document.createElement('div');
    header.className = 'cip-header';
    header.innerHTML = `
      <button class="cip-show-all-btn" id="cip-show-all">Show all files</button>
      <div class="cip-header-controls">
        <button class="cip-ctrl-icon" id="cip-link-hdr-btn" title="Connect System Downloads Folder">📁</button>
        <button class="cip-ctrl-icon" id="cip-close-btn" title="Close">✕</button>
      </div>
    `;

    // Body matching screenshot layout
    const body = document.createElement('div');
    body.className = 'cip-body';
    body.innerHTML = `
      <div class="cip-sections-layout">
        <div class="cip-section-clip">
          <div class="cip-section-title">CLIPBOARD</div>
          <div class="cip-items-grid" id="cip-clip-grid"></div>
        </div>
        <div class="cip-section-dl">
          <div class="cip-section-title">DOWNLOADED</div>
          <div class="cip-items-grid" id="cip-dl-grid"></div>
        </div>
      </div>
    `;

    modalCard.appendChild(header);
    modalCard.appendChild(body);
    backdrop.appendChild(modalCard);

    document.body.appendChild(backdrop);
    activeModal = backdrop;

    requestAnimationFrame(() => {
      backdrop.classList.add('cip-visible');
    });

    // Event Bindings
    header.querySelector('#cip-show-all').addEventListener('click', () => {
      triggerNativeFileInput();
      closeClipboardPickerModal();
    });

    header.querySelector('#cip-close-btn').addEventListener('click', closeClipboardPickerModal);

    const handleLinkFolder = async () => {
      try {
        if ('showDirectoryPicker' in window) {
          const handle = await window.showDirectoryPicker();
          if (handle) {
            systemDirHandle = handle;
            await saveDownloadsHandle(handle);
            refreshModalData();
            showModalToast(modalCard, 'System Downloads folder linked!');
          }
        }
      } catch (err) {}
    };

    header.querySelector('#cip-link-hdr-btn').addEventListener('click', handleLinkFolder);

    // Initial Data Fetch
    refreshModalData();

    window.addEventListener('keydown', handleEscKey);
  }

  function showModalToast(modalContainer, text) {
    if (!modalContainer) return;
    let existingToast = modalContainer.querySelector('.cip-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'cip-toast';
    toast.textContent = text;
    modalContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('cip-toast-visible');
    });

    setTimeout(() => {
      toast.classList.remove('cip-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function handleEscKey(e) {
    if (e.key === 'Escape') {
      closeClipboardPickerModal();
    }
  }

  function closeClipboardPickerModal() {
    window.removeEventListener('keydown', handleEscKey);
    if (activeModal) {
      const modalToClose = activeModal;
      activeModal = null;
      modalToClose.classList.remove('cip-visible');
      setTimeout(() => {
        if (modalToClose && modalToClose.parentNode) {
          modalToClose.parentNode.removeChild(modalToClose);
        }
      }, 200);
    }
  }

  function selectClipboardImage(imgObj) {
    const ext = imgObj.mimeType ? imgObj.mimeType.split('/')[1] : 'png';
    const uniqueName = `image_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
    const file = dataURLtoFile(imgObj.dataUrl, uniqueName);
    attachFileToInput(file);
  }

  async function selectDownloadedFile(dlItem) {
    if (dlItem.fileObject) {
      attachFileToInput(dlItem.fileObject);
      return;
    }

    if (dlItem.url) {
      try {
        const res = await chrome.runtime.sendMessage({ action: 'FETCH_DOWNLOAD_DATA', url: dlItem.url });
        if (res && res.success && res.dataUrl) {
          const file = dataURLtoFile(res.dataUrl, dlItem.name);
          attachFileToInput(file);
          return;
        }
      } catch (e) {}
    }

    showModalToast(activeModal?.querySelector('.cip-modal-card'), 'Could not access file. Click "Show all files" to choose from disk.');
  }

  function dataURLtoFile(dataurl, filename) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function getImageDimensions(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = dataUrl;
    });
  }

  function formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
})();
