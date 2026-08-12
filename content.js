(function () {
  let targetInput = null;
  let activeModal = null;
  let pickerFrame = null;
  let pickerToken = '';
  let pickerParentOrigin = '';
  let selectionInProgress = false;
  let isBypassing = false;
  // Interception stays disabled until the background confirms this site's
  // state. That avoids opening the picker during extension startup/reload.
  let domainDisabled = true;
  let trustedPageActions = [];
  let lastTrustedPageActionTime = 0;
  let lastBackgroundSyncTime = 0;
  let originalClickTrigger = null;

  const MAX_CAPTURE_BYTES = 6 * 1024 * 1024;
  const pickerUrl = chrome.runtime.getURL('picker.html');
  const parsedPickerUrl = new URL(pickerUrl);
  const pickerOrigin = `${parsedPickerUrl.protocol}//${parsedPickerUrl.host}`;

  chrome.runtime.sendMessage({ action: 'GET_DOMAIN_STATE' })
    .then((response) => {
      domainDisabled = !response?.success || !!response.disabled;
    })
    .catch(() => {
      domainDisabled = true;
    });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === 'DOMAIN_STATE_CHANGED') {
      domainDisabled = !!message.disabled;
      if (domainDisabled) closeClipboardPickerModal();
    }
    if (message?.action === 'IMAGES_CHANGED' && activeModal) {
      postToPicker({ type: 'CIP_HOST_REFRESH' });
    }
  });

  window.addEventListener('message', handlePickerMessage);
  window.addEventListener('paste', handleGlobalPaste, true);
  document.addEventListener('click', rememberTrustedPageAction, true);
  document.addEventListener('click', handleGeminiUploadMenuClick, true);
  document.addEventListener('click', handleFileInputClick, true);

  function isImageInput(input) {
    if (!input) return false;
    const accept = (input.getAttribute('accept') || '').toLowerCase().trim();
    return !accept
      || accept === '*'
      || accept.includes('image')
      || accept.includes('.png')
      || accept.includes('.jpg')
      || accept.includes('.jpeg')
      || accept.includes('.webp')
      || accept.includes('.gif')
      || accept.includes('.svg')
      || accept.includes('.bmp');
  }

  function isDomainDisabled() {
    return domainDisabled;
  }

  function handleGlobalPaste(event) {
    if (isDomainDisabled() || !event.isTrusted || !event.clipboardData?.items) return;
    for (const item of event.clipboardData.items) {
      if (!item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob || blob.size > MAX_CAPTURE_BYTES) continue;

      blobToDataURL(blob)
        .then((dataUrl) => getImageDimensions(dataUrl).then((meta) => ({ dataUrl, meta })))
        .then(({ dataUrl, meta }) => chrome.runtime.sendMessage({
          action: 'SAVE_IMAGE',
          image: {
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            dataUrl,
            mimeType: item.type,
            width: meta.width,
            height: meta.height,
            size: blob.size,
            timestamp: Date.now()
          }
        }))
        .then((response) => {
          if (response?.success && activeModal) postToPicker({ type: 'CIP_HOST_REFRESH' });
        })
        .catch(() => {});
    }
  }

  function rememberTrustedPageAction(event) {
    if (!event.isTrusted || activeModal?.contains(event.target)) return;
    lastTrustedPageActionTime = performance.now();
    if (!isGeminiSite()) return;

    const action = event.target.closest?.('button, [role="button"], [role="menuitem"], label, a') || event.target;
    if (!action || action.matches?.('input[type="file"]')) return;
    trustedPageActions = trustedPageActions.filter((item) => item !== action);
    trustedPageActions.push(action);
    if (trustedPageActions.length > 8) trustedPageActions.shift();
  }

  function isGeminiSite() {
    return window.location.hostname === 'gemini.google.com';
  }

  function findGeminiFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter((input) => !input.disabled && input.dataset.cipTemporary !== 'true');
    return inputs.find((input) => isImageInput(input)) || inputs[0] || null;
  }

  function handleGeminiUploadMenuClick(event) {
    if (isDomainDisabled() || !isGeminiSite() || !event.isTrusted || isBypassing || activeModal?.contains(event.target)) return;
    const action = event.target.closest?.('button, [role="button"], [role="menuitem"], [role="option"]');
    if (!action) return;

    const descriptor = getActionDescriptor(action);
    const label = `${descriptor.text} ${descriptor.ariaLabel} ${descriptor.title}`;
    if (!/(upload|attach|choose)\s+(a\s+)?files?/.test(label)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
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
    return Array.from(candidates).find((candidate) => {
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

    const launcher = [...trustedPageActions].reverse().find((action) =>
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

  function handleFileInputClick(event) {
    const followsTrustedAction = navigator.userActivation?.isActive
      && performance.now() - lastTrustedPageActionTime < 1000;
    if (!event.target || (!event.isTrusted && !followsTrustedAction) || isDomainDisabled()) return;

    const tag = event.target.tagName;
    if (!['INPUT', 'BUTTON', 'LABEL', 'A', 'SPAN', 'DIV'].includes(tag)) return;
    const input = event.target.closest('input[type="file"]');
    if (!input) return;

    if (!isImageInput(input) || input.dataset.cipBypass === 'true' || isBypassing) {
      delete input.dataset.cipBypass;
      return;
    }

    event.preventDefault();
    targetInput = input;
    originalClickTrigger = trustedPageActions[trustedPageActions.length - 1] || event.target;
    openClipboardPickerModal();
  }

  function triggerNativeFileInput() {
    isBypassing = true;
    const useGeminiFileBridge = isGeminiSite();
    if (useGeminiFileBridge && replayGeminiUploadAction()) {
      setTimeout(() => {
        isBypassing = false;
      }, 1500);
      return;
    }

    let pageInput = !useGeminiFileBridge && targetInput && document.contains(targetInput) ? targetInput : null;
    if (!pageInput && !useGeminiFileBridge) {
      const candidates = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter((input) => !input.disabled && input.dataset.cipTemporary !== 'true');
      const targetAccept = (targetInput?.accept || '').toLowerCase();
      pageInput = candidates.find((input) => targetAccept && input.accept.toLowerCase() === targetAccept)
        || candidates.find((input) => isImageInput(input))
        || candidates[0]
        || null;
    }

    if (pageInput) {
      targetInput = pageInput;
      pageInput.dataset.cipBypass = 'true';
      try {
        if (typeof pageInput.showPicker === 'function') pageInput.showPicker();
        else pageInput.click();
        setTimeout(() => {
          delete pageInput.dataset.cipBypass;
          isBypassing = false;
        }, 1000);
        return;
      } catch (error) {
        delete pageInput.dataset.cipBypass;
        console.warn('Page file input click failed; using fallback picker:', error);
      }
    }

    const tempInput = document.createElement('input');
    tempInput.type = 'file';
    tempInput.style.position = 'fixed';
    tempInput.style.top = '-9999px';
    tempInput.style.left = '-9999px';
    tempInput.style.opacity = '0';
    tempInput.dataset.cipTemporary = 'true';
    if (targetInput?.accept) tempInput.accept = targetInput.accept;
    if (targetInput?.multiple) tempInput.multiple = targetInput.multiple;
    tempInput.dataset.cipBypass = 'true';
    document.body.appendChild(tempInput);

    tempInput.addEventListener('change', () => {
      if (tempInput.files?.length) attachFilesToInput(Array.from(tempInput.files));
      setTimeout(() => tempInput.remove(), 200);
    }, { once: true });

    try {
      tempInput.click();
    } catch (error) {
      console.warn('Native click trigger failed:', error);
      tempInput.remove();
    }
    setTimeout(() => {
      isBypassing = false;
    }, 1000);
  }

  function attachFileToInput(file) {
    if (file) attachFilesToInput([file]);
  }

  function attachFilesToInput(files) {
    files = Array.from(files || []).filter(Boolean);
    if (files.length === 0) return;
    const useGeminiBridge = isGeminiSite();
    const dataTransfer = new DataTransfer();
    files.forEach((file) => dataTransfer.items.add(file));

    let input = targetInput;
    if (!input || !document.contains(input)) input = document.querySelector('input[type="file"]');

    let deliveredToInput = false;
    if (input && document.contains(input)) {
      const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
      if (filesSetter) {
        try {
          filesSetter.call(input, dataTransfer.files);
        } catch (error) {
          input.files = dataTransfer.files;
        }
      } else {
        input.files = dataTransfer.files;
      }

      const eventOptions = { bubbles: true, composed: true, cancelable: true };
      input.dispatchEvent(new Event('input', eventOptions));
      input.dispatchEvent(new Event('change', eventOptions));
      deliveredToInput = true;
    }

    if (deliveredToInput && !useGeminiBridge) {
      closeClipboardPickerModal();
      return;
    }

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
      if (!promptTargets.includes(document.body)) promptTargets.push(document.body);
      promptTargets.forEach((target) => {
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
        } catch (error) {}
      });
    } else {
      const fallbackTarget = promptTargets[0] || document.body;
      try {
        fallbackTarget.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer
        }));
      } catch (error) {}
    }

    closeClipboardPickerModal();
  }

  function createPickerToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function syncClipboardForPicker(sessionToken) {
    if (!/^[a-f0-9]{32}$/.test(sessionToken || '')) return null;
    const now = Date.now();
    if (now - lastBackgroundSyncTime < 2000) return null;
    lastBackgroundSyncTime = now;
    try {
      const registration = await chrome.runtime.sendMessage({
        action: 'REGISTER_PICKER_SESSION',
        token: sessionToken
      });
      if (!registration?.success) return null;
      const response = await chrome.runtime.sendMessage({
        action: 'AUTO_CHECK_CLIPBOARD',
        sessionToken
      });
      return response || null;
    } catch (error) {
      return null;
    }
  }

  function schedulePickerClipboardSync(host, sessionToken, attempt = 0) {
    syncClipboardForPicker(sessionToken)
      .then((result) => {
        if (activeModal !== host || pickerToken !== sessionToken) return;
        if (result?.saved) {
          postToPicker({ type: 'CIP_HOST_REFRESH' });
        } else if (result?.code === 'MIGRATION_IN_PROGRESS' && attempt < 12) {
          setTimeout(() => schedulePickerClipboardSync(host, sessionToken, attempt + 1), 2100);
        }
      })
      .catch(() => {});
  }

  function postToPicker(message) {
    if (!pickerFrame?.contentWindow || !pickerToken) return;
    pickerFrame.contentWindow.postMessage({ ...message, token: pickerToken }, pickerOrigin);
  }

  function handlePickerMessage(event) {
    if (!activeModal || !pickerFrame || event.source !== pickerFrame.contentWindow || event.origin !== pickerOrigin) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.token !== pickerToken || message.parentOrigin !== pickerParentOrigin || typeof message.type !== 'string') return;

    if (message.type === 'CIP_PICK_IMAGE') {
      if (selectionInProgress || typeof message.imageId !== 'string' || message.imageId.length > 256) return;
      selectionInProgress = true;
      selectClipboardImage(message.imageId, pickerToken);
      return;
    }

    if (message.type === 'CIP_PICK_DOWNLOAD') {
      if (selectionInProgress || !Number.isInteger(message.downloadId)) return;
      selectionInProgress = true;
      selectDownloadedFile({
        id: message.downloadId,
        name: sanitizeFilename(message.name)
      }, pickerToken);
      return;
    }

    if (message.type === 'CIP_SHOW_ALL') {
      triggerNativeFileInput();
      closeClipboardPickerModal();
      return;
    }

    if (message.type === 'CIP_CLOSE') closeClipboardPickerModal();
  }

  function openClipboardPickerModal() {
    if (isDomainDisabled()) return;
    closeClipboardPickerModal();

    pickerToken = createPickerToken();
    pickerParentOrigin = window.location.origin === 'null' ? '' : window.location.origin;
    const host = document.createElement('div');
    host.id = 'cip-modal-host';
    host.setAttribute('role', 'presentation');
    // A closed shadow root prevents the website from reading the iframe URL's
    // per-open capability token or altering the extension-owned picker DOM.
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    host.addEventListener('click', (event) => {
      if (event.isTrusted && event.target === host) closeClipboardPickerModal();
    });

    const frame = document.createElement('iframe');
    frame.title = 'Clipboard and downloads picker';
    const pickerParams = new URLSearchParams({ token: pickerToken, parentOrigin: pickerParentOrigin });
    frame.src = `${pickerUrl}?${pickerParams}`;
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = [
      'display:block',
      'box-sizing:border-box',
      'width:min(820px, 94vw)',
      'height:min(540px, 88vh)',
      'margin:0',
      'padding:0',
      'overflow:hidden',
      'background:#252736',
      'border:1px solid rgba(255,255,255,.08)',
      'border-radius:12px',
      'box-shadow:0 25px 60px rgba(0,0,0,.6)',
      'color-scheme:dark'
    ].join(';');
    shadowRoot.appendChild(frame);
    document.documentElement.appendChild(host);

    activeModal = host;
    pickerFrame = frame;
    selectionInProgress = false;
    requestAnimationFrame(() => host.classList.add('cip-visible'));
    window.addEventListener('keydown', handleEscKey);
    schedulePickerClipboardSync(host, pickerToken);
  }

  function handleEscKey(event) {
    if (event.key === 'Escape') closeClipboardPickerModal();
  }

  function closeClipboardPickerModal() {
    window.removeEventListener('keydown', handleEscKey);
    selectionInProgress = false;
    pickerFrame = null;
    pickerToken = '';
    pickerParentOrigin = '';
    if (!activeModal) return;

    const modalToClose = activeModal;
    activeModal = null;
    modalToClose.classList.remove('cip-visible');
    setTimeout(() => modalToClose.remove(), 200);
  }

  async function selectClipboardImage(imageId, selectionSession) {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'GET_IMAGE_DATA', id: imageId });
      if (!response?.success || response.image?.id !== imageId || typeof response.image.dataUrl !== 'string') {
        throw new Error(response?.error || 'Could not load this image.');
      }
      if (!activeModal?.isConnected || pickerToken !== selectionSession || isDomainDisabled()) return;
      const subtype = response.image.mimeType?.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'png';
      const filename = `image_${Date.now()}_${Math.floor(Math.random() * 10000)}.${subtype}`;
      // The host page receives only this explicitly selected file, immediately
      // before it is attached to the page's upload target.
      attachFileToInput(dataURLtoFile(response.image.dataUrl, filename));
    } catch (error) {
      selectionInProgress = false;
      postToPicker({ type: 'CIP_HOST_ERROR', message: error.message || 'Could not load this image.' });
    }
  }

  async function selectDownloadedFile(download, selectionSession) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'FETCH_DOWNLOAD_DATA',
        downloadId: download.id
      });
      if (!response?.success || typeof response.dataUrl !== 'string') {
        throw new Error(response?.error || 'Could not access this download.');
      }
      if (!activeModal?.isConnected || pickerToken !== selectionSession || isDomainDisabled()) return;
      attachFileToInput(dataURLtoFile(response.dataUrl, download.name));
    } catch (error) {
      selectionInProgress = false;
      postToPicker({ type: 'CIP_HOST_ERROR', message: error.message || 'Could not access this download.' });
    }
  }

  function sanitizeFilename(value) {
    const name = typeof value === 'string' ? value.split(/[\\/]/).pop().trim() : '';
    return (name || 'download').slice(0, 255);
  }

  function dataURLtoFile(dataUrl, filename) {
    if (typeof dataUrl !== 'string' || !/^data:[^;,]+;base64,/.test(dataUrl)) {
      throw new Error('Stored image data is invalid.');
    }
    const parts = dataUrl.split(',');
    if (parts.length !== 2) throw new Error('Stored image data is invalid.');
    const mimeMatch = parts[0].match(/:(.*?);/);
    if (!mimeMatch) throw new Error('Stored image type is invalid.');

    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], sanitizeFilename(filename), { type: mimeMatch[1] });
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
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = dataUrl;
    });
  }
})();
