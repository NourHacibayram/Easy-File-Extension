function isExpectedPickerMessageEvent(event, session) {
  if (!event || !session) return false;

  // A web-accessible resource using `use_dynamic_url` can be loaded from a
  // per-session host while Chromium reports the installed extension origin on
  // the MessageEvent. Both values identify this extension and are bound to the
  // unguessable picker capability below.
  const expectedOrigins = new Set(
    [session.origin, session.extensionOrigin].filter((origin) => typeof origin === 'string' && origin)
  );
  if (!expectedOrigins.has(event.origin)) return false;

  // Chromium deliberately reports `source` as null for some messages sent by
  // extension documents. When it is available, still require the exact picker
  // window; when it is not, the dynamic extension origin and 128-bit session
  // capability below remain the authentication boundary.
  if (event.source !== null && event.source !== session.contentWindow) return false;

  const message = event.data;
  return !!message
    && typeof message === 'object'
    && message.token === session.token
    && message.parentOrigin === session.parentOrigin
    && typeof message.type === 'string';
}

function normalizePickerCommand(message) {
  if (!message || typeof message !== 'object') return null;
  if (!/^[a-f0-9]{32}$/.test(message.token || '')) return null;
  if (!/^[a-f0-9]{24,64}$/.test(message.commandId || '')) return null;

  const command = {
    type: message.type,
    token: message.token,
    commandId: message.commandId,
    parentOrigin: typeof message.parentOrigin === 'string' ? message.parentOrigin : ''
  };

  if (message.type === 'CIP_CLOSE' || message.type === 'CIP_SHOW_ALL') return command;
  if (message.type === 'CIP_PICK_IMAGE') {
    if (typeof message.imageId !== 'string' || message.imageId.length < 1 || message.imageId.length > 160) return null;
    command.imageId = message.imageId;
    return command;
  }
  if (message.type === 'CIP_USE_RECIPE') {
    if (!/^recipe_[a-f0-9]{32}$/.test(message.recipeId || '')) return null;
    command.recipeId = message.recipeId;
    if (Number.isFinite(message.clickedAt)) command.clickedAt = message.clickedAt;
    return command;
  }
  if (message.type === 'CIP_PICK_DOWNLOAD') {
    if (!Number.isSafeInteger(message.downloadId) || message.downloadId < 0) return null;
    command.downloadId = message.downloadId;
    command.name = typeof message.name === 'string' ? message.name.slice(0, 255) : 'download';
    return command;
  }
  if (message.type === 'CIP_PICK_BATCH') {
    if (!Array.isArray(message.items) || message.items.length === 0 || message.items.length > 50) return null;
    const validItems = [];
    for (const item of message.items) {
      if (!item || typeof item !== 'object') return null;
      if (item.kind === 'image') {
        if (typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 160) return null;
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
    return command;
  }
  return null;
}

function routePickerCommand(rawMessage, session, handledCommandIds, handlers) {
  const message = normalizePickerCommand(rawMessage);
  if (!message || !session?.active || message.token !== session.token || message.parentOrigin !== session.parentOrigin) {
    return { success: false, code: 'INVALID_PICKER_COMMAND' };
  }
  if (handledCommandIds.has(message.commandId)) return { success: true, duplicate: true };
  if ((message.type === 'CIP_PICK_IMAGE' || message.type === 'CIP_PICK_DOWNLOAD' || message.type === 'CIP_PICK_BATCH' || message.type === 'CIP_USE_RECIPE')
      && handlers.selectionInProgress()) {
    return { success: false, code: 'SELECTION_IN_PROGRESS' };
  }

  handledCommandIds.add(message.commandId);
  while (handledCommandIds.size > 64) {
    handledCommandIds.delete(handledCommandIds.values().next().value);
  }

  if (message.type === 'CIP_PICK_IMAGE') handlers.pickImage(message);
  else if (message.type === 'CIP_PICK_DOWNLOAD') handlers.pickDownload(message);
  else if (message.type === 'CIP_PICK_BATCH') handlers.pickBatch(message);
  else if (message.type === 'CIP_USE_RECIPE') handlers.useRecipe(message);
  else if (message.type === 'CIP_SHOW_ALL') handlers.showAll();
  else handlers.close();
  return { success: true };
}

function isTrustedPickerEscape(event) {
  return !!event?.isTrusted && event.key === 'Escape';
}

function isTrustedPickerBackdrop(event, host) {
  return !!event?.isTrusted && event.target === host;
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  (function () {
  let targetInput = null;
  let targetInputIsExact = false;
  let pickerUsesPaste = false;
  let pasteTarget = null;
  let pasteSelection = null;
  let recipeImagesApplied = '';
  let recipePromptApplied = '';
  let activeModal = null;
  let pickerFrame = null;
  let pickerToken = '';
  let pickerParentOrigin = '';
  let pickerMessageOrigin = '';
  let pickerExtensionOrigin = '';
  let selectionInProgress = false;
  let isBypassing = false;
  // Interception stays disabled until the background confirms this site's
  // state. That avoids opening the picker during extension startup/reload.
  let domainDisabled = true;
  let trustedPageActions = [];
  let lastTrustedPageActionTime = -Infinity;
  let lastBackgroundSyncTime = 0;
  let originalClickTrigger = null;
  let focusBeforePicker = null;
  const handledPickerCommandIds = new Set();

  const MAX_CAPTURE_BYTES = 6 * 1024 * 1024;

  chrome.runtime.sendMessage({ action: 'GET_DOMAIN_STATE' })
    .then((response) => {
      domainDisabled = !response?.success || !!response.disabled;
    })
    .catch(() => {
      domainDisabled = true;
    });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === 'TOGGLE_PICKER' || message?.action === 'OPEN_PICKER') {
      if (domainDisabled) {
        sendResponse?.({ success: false, reason: 'DOMAIN_DISABLED' });
        return false;
      }
      if (activeModal) {
        closeClipboardPickerModal();
      } else {
        // The keyboard picker is a paste action, not a continuation of an old
        // upload input that may still exist elsewhere on the page.
        targetInput = null;
        targetInputIsExact = false;
        openClipboardPickerModal({ paste: true });
      }
      sendResponse?.({ success: true });
      return false;
    }
    if (message?.action === 'DOMAIN_STATE_CHANGED') {
      domainDisabled = !!message.disabled;
      if (domainDisabled) closeClipboardPickerModal();
    }
    if (message?.action === 'IMAGES_CHANGED' && activeModal) {
      postToPicker({ type: 'CIP_HOST_REFRESH' });
    }
    if (message?.action === 'PICKER_SESSION_CHALLENGE') {
      const trustedRelay = sender?.id === chrome.runtime.id && !sender?.tab;
      const matchesActivePicker = trustedRelay
        && !!activeModal?.isConnected
        && !domainDisabled
        && /^[a-f0-9]{32}$/.test(message.token || '')
        && message.token === pickerToken
        && message.parentOrigin === pickerParentOrigin;
      sendResponse?.({ success: matchesActivePicker });
      return false;
    }
    if (message?.action === 'PICKER_COMMAND') {
      const trustedRelay = sender?.id === chrome.runtime.id && !sender?.tab;
      const result = trustedRelay
        ? dispatchPickerCommand(message)
        : { success: false, code: 'UNTRUSTED_RELAY' };
      sendResponse?.(result);
      return false;
    }
    return false;
  });

  window.addEventListener('message', handlePickerMessage);
  window.addEventListener('paste', handleGlobalPaste, true);
  document.addEventListener('click', rememberTrustedPageAction, true);
  document.addEventListener('pointerdown', rememberTrustedPageAction, true);
  document.addEventListener('keydown', (event) => {
    if (event.isTrusted && !activeModal && (event.key === 'Enter' || event.key === ' ')) {
      lastTrustedPageActionTime = performance.now();
    }
  }, true);
  document.addEventListener('cip-file-picker-request', handlePageFilePickerRequest, true);
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
    targetInputIsExact = false;
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

    const input = findEventFileInput(event);
    if (!input) return;

    if (!isImageInput(input) || input.dataset.cipBypass === 'true' || isBypassing) {
      delete input.dataset.cipBypass;
      return;
    }

    event.preventDefault();
    targetInput = input;
    targetInputIsExact = true;
    originalClickTrigger = trustedPageActions[trustedPageActions.length - 1] || event.target;
    openClipboardPickerModal();
  }

  function findEventFileInput(event) {
    return (event.composedPath?.() || [event.target]).find((node) =>
      node instanceof HTMLInputElement && node.type === 'file'
    ) || null;
  }

  function handlePageFilePickerRequest(event) {
    // MAIN-world events are page-visible and untrusted. They can only open the
    // picker after a real, recent user action; they cannot select gallery data.
    if (isDomainDisabled() || isBypassing || activeModal
        || !navigator.userActivation?.isActive
        || performance.now() - lastTrustedPageActionTime >= 1000) return;
    const input = findEventFileInput(event);
    if (!input || input.disabled || !isImageInput(input)
        || input.dataset.cipBypass === 'true' || input.dataset.cipTemporary === 'true') return;
    targetInput = input;
    targetInputIsExact = true;
    originalClickTrigger = trustedPageActions[trustedPageActions.length - 1] || input;
    openClipboardPickerModal();
    if (activeModal?.isConnected) event.preventDefault();
  }

  function triggerNativeFileInput() {
    isBypassing = true;
    const useGeminiFileBridge = isGeminiSite();
    if (!pickerUsesPaste && !targetInputIsExact && useGeminiFileBridge && replayGeminiUploadAction()) {
      setTimeout(() => {
        isBypassing = false;
      }, 1500);
      return;
    }

    let pageInput = !pickerUsesPaste && (!useGeminiFileBridge || targetInputIsExact) && targetInput && !targetInput.disabled ? targetInput : null;
    if (!pageInput && !useGeminiFileBridge && !pickerUsesPaste) {
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

  function deliverFilesToEditor(target, dataTransfer) {
    // Preserve paste-first delivery. Some upload zones cancel drop events
    // without actually attaching files, so cancellation alone is insufficient
    // to prefer a site's drop zone over its working clipboard handler.
    if (!target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, composed: true, clipboardData: dataTransfer
    }))) return true;
    return !target.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, composed: true, dataTransfer
    }));
  }

  function attachFilesToInput(files) {
    files = Array.from(files || []).filter(Boolean);
    if (files.length === 0) return;
    const useGeminiBridge = isGeminiSite();
    const dataTransfer = new DataTransfer();
    files.forEach((file) => dataTransfer.items.add(file));

    if (pickerUsesPaste) {
      const target = pasteTarget?.isConnected ? pasteTarget : findPasteTarget();
      if (!target) {
        selectionInProgress = false;
        postToPicker({ type: 'CIP_HOST_ERROR', message: 'Click the message field before opening the picker.' });
        return;
      }
      target.focus({ preventScroll: true });
      if (deliverFilesToEditor(target, dataTransfer)) {
        closeClipboardPickerModal();
      } else {
        selectionInProgress = false;
        postToPicker({ type: 'CIP_HOST_ERROR', message: 'This field did not accept the file. Try its upload button.' });
      }
      return;
    }

    let input = targetInput;
    // Keep the precise intercepted input, even when the site created it off
    // DOM or removed it while our picker was open. Its change callback belongs
    // to that upload action; an unrelated visible input is not a replacement.
    if (!input) input = document.querySelector('input[type="file"]');

    let deliveredToInput = false;
    if (input && !input.disabled) {
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

    if (deliveredToInput && (!useGeminiBridge || targetInputIsExact)) {
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
    if (!pickerFrame?.contentWindow || !pickerToken || !pickerMessageOrigin) return;
    pickerFrame.contentWindow.postMessage({ ...message, token: pickerToken }, pickerMessageOrigin);
  }

  function handlePickerMessage(event) {
    if (!activeModal || !pickerFrame || !isExpectedPickerMessageEvent(event, {
      contentWindow: pickerFrame.contentWindow,
      origin: pickerMessageOrigin,
      extensionOrigin: pickerExtensionOrigin,
      token: pickerToken,
      parentOrigin: pickerParentOrigin
    })) return;
    dispatchPickerCommand(event.data);
  }

  function dispatchPickerCommand(rawMessage) {
    return routePickerCommand(rawMessage, {
      active: !!activeModal,
      token: pickerToken,
      parentOrigin: pickerParentOrigin
    }, handledPickerCommandIds, {
      selectionInProgress: () => selectionInProgress,
      pickImage: (message) => {
        selectionInProgress = true;
        selectClipboardImage(message.imageId, pickerToken);
      },
      pickDownload: (message) => {
        selectionInProgress = true;
        selectDownloadedFile({ id: message.downloadId, name: sanitizeFilename(message.name) }, pickerToken);
      },
      pickBatch: (message) => {
        selectionInProgress = true;
        selectBatchFiles(message.items, pickerToken);
      },
      useRecipe: (message) => {
        selectionInProgress = true;
        applyRecipe(message.recipeId, pickerToken, message.clickedAt);
      },
      showAll: () => {
        triggerNativeFileInput();
        closeClipboardPickerModal();
      },
      close: closeClipboardPickerModal
    });
  }

  function findPasteTarget() {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement
      ? active.closest('[contenteditable="true"], [contenteditable="plaintext-only"], textarea') : null;
    if (focused && !focused.disabled && !focused.readOnly) return focused;
    return document.querySelector('flow-prompt-box [contenteditable="true"]')
      || document.querySelector('[contenteditable="true"], [contenteditable="plaintext-only"], textarea:not(:disabled):not([readonly])');
  }

  function openClipboardPickerModal({ paste = false } = {}) {
    if (isDomainDisabled()) return;
    closeClipboardPickerModal();
    pickerUsesPaste = paste;
    pasteTarget = paste ? findPasteTarget() : null;
    pasteSelection = null;
    if (pasteTarget instanceof HTMLTextAreaElement) {
      pasteSelection = { start: pasteTarget.selectionStart, end: pasteTarget.selectionEnd };
    } else if (pasteTarget) {
      const selection = window.getSelection();
      if (selection?.rangeCount && pasteTarget.contains(selection.getRangeAt(0).commonAncestorContainer)) {
        pasteSelection = selection.getRangeAt(0).cloneRange();
      }
    }
    recipeImagesApplied = '';
    recipePromptApplied = '';

    let currentPickerUrl = '';
    try {
      if (!chrome?.runtime?.id) throw new Error('Extension context invalidated');
      currentPickerUrl = chrome.runtime.getURL('picker.html');
      pickerExtensionOrigin = new URL(chrome.runtime.getURL('')).origin;
    } catch (error) {
      triggerNativeFileInput();
      return;
    }

    pickerToken = createPickerToken();
    pickerParentOrigin = window.location.origin === 'null' ? '' : window.location.origin;
    focusBeforePicker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    handledPickerCommandIds.clear();
    const host = document.createElement('div');
    host.id = 'cip-modal-host';
    host.setAttribute('role', 'presentation');
    // A closed shadow root prevents the website from reading the iframe URL's
    // per-open capability token or altering the extension-owned picker DOM.
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    host.addEventListener('click', (event) => {
      if (isTrustedPickerBackdrop(event, host)) closeClipboardPickerModal();
    });

    const dialog = document.createElement('div');
    // Events from the dialog (including Chromium's iframe click events) are
    // retargeted to the host outside this closed shadow root. Keep them here
    // so they cannot be mistaken for a click on the dimmed backdrop and cancel
    // an image selection while its runtime request is still in flight.
    dialog.addEventListener('click', (event) => event.stopPropagation());
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Clipboard and downloads picker');
    dialog.style.cssText = [
      'position:relative',
      'display:block',
      'width:min(820px, 94vw)',
      'height:min(540px, 88vh)',
      'margin:0',
      'padding:0'
    ].join(';');

    const frame = document.createElement('iframe');
    frame.title = 'Clipboard and downloads picker';
    const pickerParams = new URLSearchParams({ token: pickerToken, parentOrigin: pickerParentOrigin, intent: paste ? 'paste' : 'upload' });
    frame.src = `${currentPickerUrl}?${pickerParams}`;
    pickerMessageOrigin = new URL(frame.src).origin;
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = [
      'display:block',
      'box-sizing:border-box',
      'width:100%',
      'height:100%',
      'margin:0',
      'padding:0',
      'overflow:hidden',
      'background:#191c19',
      'border:1px solid #3b4237',
      'border-radius:10px',
      'box-shadow:0 20px 64px rgba(0,0,0,.45)',
      'color-scheme:dark'
    ].join(';');

    // This button is owned by the content script rather than the iframe. It
    // therefore remains a direct, dependency-free escape hatch even if an
    // iframe message is delayed or rejected by Chromium's origin boundary.
    const directCloseButton = document.createElement('button');
    directCloseButton.type = 'button';
    directCloseButton.setAttribute('aria-label', 'Close picker');
    directCloseButton.title = 'Close';
    directCloseButton.textContent = '\u00d7';
    directCloseButton.style.cssText = [
      'position:absolute',
      'z-index:3',
      'top:22px',
      'right:16px',
      'display:grid',
      'place-items:center',
      'width:34px',
      'height:34px',
      'padding:0',
      'border:0',
      'border-radius:4px',
      'background:transparent',
      'color:#a1a99b',
      'font:400 24px/1 system-ui,sans-serif',
      'cursor:pointer',
      'transition:background-color .15s ease,color .15s ease,border-color .15s ease,transform .15s ease'
    ].join(';');
    directCloseButton.addEventListener('pointerenter', () => {
      directCloseButton.style.background = '#2d322c';
      directCloseButton.style.color = '#ebeee6';
    });
    directCloseButton.addEventListener('pointerleave', () => {
      directCloseButton.style.background = 'transparent';
      directCloseButton.style.color = '#a1a99b';
    });
    directCloseButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeClipboardPickerModal();
    });

    dialog.append(frame, directCloseButton);
    shadowRoot.appendChild(dialog);
    document.documentElement.appendChild(host);

    // Flow's prompt attachment menu uses a native popover in the browser's
    // top layer. No z-index can place a normal page element above that layer:
    // clicks would hit Flow's backdrop and destroy its pending uploader. Put
    // our picker in the same layer, above the existing menu, without closing it.
    // Older browsers retain the regular positioned-overlay fallback.
    if (typeof host.showPopover === 'function') {
      host.setAttribute('popover', 'manual');
      try {
        host.showPopover();
      } catch (error) {
        host.removeAttribute('popover');
      }
    }

    activeModal = host;
    pickerFrame = frame;
    selectionInProgress = false;
    requestAnimationFrame(() => host.classList.add('cip-visible'));
    window.addEventListener('keydown', handleEscKey);
    directCloseButton.focus({ preventScroll: true });
    chrome.runtime.sendMessage({
      action: 'REGISTER_PICKER_SESSION',
      token: pickerToken,
      parentOrigin: pickerParentOrigin
    }).then((registration) => {
      if (registration?.success && activeModal === host && pickerToken) {
        schedulePickerClipboardSync(host, pickerToken);
      }
    }).catch(() => {});
  }

  function handleEscKey(event) {
    if (isTrustedPickerEscape(event)) closeClipboardPickerModal();
  }

  function closeClipboardPickerModal() {
    window.removeEventListener('keydown', handleEscKey);
    selectionInProgress = false;
    const closingToken = pickerToken;
    pickerFrame = null;
    pickerToken = '';
    pickerParentOrigin = '';
    pickerMessageOrigin = '';
    pickerExtensionOrigin = '';
    handledPickerCommandIds.clear();
    if (closingToken) {
      chrome.runtime.sendMessage({ action: 'UNREGISTER_PICKER_SESSION', token: closingToken }).catch(() => {});
    }
    if (!activeModal) return;

    const modalToClose = activeModal;
    activeModal = null;
    modalToClose.style.pointerEvents = 'none';
    modalToClose.setAttribute('aria-hidden', 'true');
    modalToClose.classList.remove('cip-visible');
    setTimeout(() => modalToClose.remove(), 200);
    const restoreTarget = focusBeforePicker;
    focusBeforePicker = null;
    if (restoreTarget?.isConnected) {
      queueMicrotask(() => restoreTarget.focus({ preventScroll: true }));
    }
  }

  async function applyRecipe(recipeId, selectionSession, clickedAt) {
    const now = () => performance.timeOrigin + performance.now();
    const receivedAt = now();
    const startedAt = Number.isFinite(clickedAt) && clickedAt <= receivedAt && receivedAt - clickedAt < 600000 ? clickedAt : receivedAt;
    let preparedAt = null;
    let totalBytes = 0;
    let fileMs = 0;
    let promptMs = 0;
    let focusMs = 0;
    let promptMethod = 'retry';
    const isCurrent = () => activeModal?.isConnected && pickerToken === selectionSession && !isDomainDisabled();
    try {
      if (!pickerUsesPaste) throw new Error('Click the message field and open Ctrl+Shift+V to use a recipe.');
      const response = await chrome.runtime.sendMessage({ action: 'GET_RECIPE_FOR_USE', recipeId, token: selectionSession });
      const recipe = response?.recipe;
      if (!response?.success || recipe?.id !== recipeId) throw new Error(response?.error || 'Could not load recipe.');
      let target = pasteTarget?.isConnected ? pasteTarget : findPasteTarget();
      if (!target) throw new Error('Click the message field before opening the picker.');
      let transfer = null;
      if (recipe.images.length && recipeImagesApplied !== recipeId) {
        transfer = new DataTransfer();
        const files = new Array(recipe.images.length);
        let next = 0;
        // Bound original-image transfers to two at a time. Keep results by
        // their saved position even if storage reads finish out of order.
        await Promise.all([0, 1].map(async () => {
          while (next < recipe.images.length && isCurrent()) {
            const index = next++;
            const reference = recipe.images[index];
            const result = await chrome.runtime.sendMessage({ action: 'GET_RECIPE_IMAGE_DATA', recipeId,
              imageId: reference.id, token: selectionSession });
            if (!isCurrent()) return;
            if (!result?.success || result.image?.id !== reference.id) throw new Error(result?.error || 'Could not load reference image.');
            const ext = result.image.mimeType?.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'png';
            files[index] = dataURLtoFile(result.image.dataUrl, `reference_${index + 1}.${ext}`);
          }
        }));
        if (!isCurrent()) return;
        totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        files.forEach(file => transfer.items.add(file));
      }
      if (!isCurrent()) return;
      preparedAt = now();
      const promptFirst = isGeminiSite() && recipe.images.length > 0;
      const deliverReferences = () => {
        if (!transfer) return;
        const partial = recipePromptApplied === recipeId ? 'Prompt inserted, but ' : '';
        target = target.isConnected ? target : findPasteTarget();
        if (!target) throw new Error(`${partial}the message editor was closed. Open it and try again.`);
        const focusStartedAt = now();
        target.focus({ preventScroll: true });
        focusMs += now() - focusStartedAt;
        const fileStartedAt = now();
        const filesAccepted = deliverFilesToEditor(target, transfer);
        fileMs = now() - fileStartedAt;
        if (!filesAccepted) throw new Error(`${partial}this editor did not accept the reference images. Try the site’s upload button.`);
        recipeImagesApplied = recipeId;
      };
      const insertPrompt = () => {
        if (recipePromptApplied === recipeId) return;
        target = target.isConnected ? target : findPasteTarget();
        const partial = recipeImagesApplied === recipeId ? 'References sent, but ' : '';
        if (!target) throw new Error(`${partial}the message field closed before the prompt was inserted.`);
        const focusStartedAt = now();
        target.focus({ preventScroll: true });
        if (target === pasteTarget && pasteSelection) {
          if (target instanceof HTMLTextAreaElement) {
            target.setSelectionRange(pasteSelection.start, pasteSelection.end);
          } else if (pasteSelection instanceof Range && target.contains(pasteSelection.commonAncestorContainer)) {
            const selection = window.getSelection();
            selection.removeAllRanges(); selection.addRange(pasteSelection);
          }
        }
        focusMs += now() - focusStartedAt;
        const promptStartedAt = now();
        const text = new DataTransfer();
        text.setData('text/plain', recipe.prompt);
        let accepted = false;
        // Live measurements isolate Gemini's delay to text paste after image
        // delivery. Its Quill editor observes native edits, so use the existing
        // native insertion path first here, retaining caret, undo and input
        // notifications. Keep image delivery and other editors unchanged.
        if (recipe.images.length && isGeminiSite() && target.isContentEditable
            && target.matches('.ql-editor') && target.closest('rich-textarea')
            && target.getAttribute('aria-readonly') !== 'true') {
          try { accepted = document.execCommand('insertText', false, recipe.prompt); }
          catch (error) { /* Fall back to the working paste path if unavailable. */ }
          if (accepted) promptMethod = 'native';
        }
        if (!accepted) {
          accepted = !target.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, composed: true, clipboardData: text
          }));
          if (accepted) promptMethod = 'paste';
        }
        if (!accepted && target instanceof HTMLTextAreaElement && !target.disabled && !target.readOnly) {
          const start = target.selectionStart; const end = target.selectionEnd;
          const value = target.value.slice(0, start) + recipe.prompt + target.value.slice(end);
          if (target.maxLength >= 0 && value.length > target.maxLength) throw new Error(`${partial}this prompt exceeds the message field’s limit.`);
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(target, value);
          target.setSelectionRange(start + recipe.prompt.length, start + recipe.prompt.length);
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: recipe.prompt }));
          accepted = true;
          promptMethod = 'textarea';
        }
        // Synthetic paste has no browser default insertion. For a plain rich
        // editor, use its native editing operation to preserve undo and input
        // notifications, rather than replacing the editor's entire contents.
        if (!accepted && target.isContentEditable && target.getAttribute('aria-readonly') !== 'true') {
          accepted = document.execCommand('insertText', false, recipe.prompt);
          if (accepted) promptMethod = 'native';
        }
        if (!accepted) throw new Error(`${partial}this editor did not accept the prompt. Copy the prompt from Recipes.`);
        promptMs = now() - promptStartedAt;
        recipePromptApplied = recipeId;
      };
      // On Gemini, prompt-only insertion is fast while insertion immediately
      // after a new image is slow. Complete the text edit before dispatching
      // files. Track each accepted part so a retry cannot duplicate it.
      if (promptFirst) {
        insertPrompt();
        if (!isCurrent()) return;
        deliverReferences();
      } else {
        deliverReferences();
        if (!isCurrent()) return;
        insertPrompt();
      }
      const finishedAt = now();
      // Store timings and fixed delivery labels only, never the prompt, image
      // data, recipe name or website. Reporting follows successful insertion.
      chrome.runtime.sendMessage({ action: 'REPORT_RECIPE_TIMING', recipeId, token: selectionSession,
        timing: { relayMs: receivedAt - startedAt, prepareMs: preparedAt - receivedAt,
          editorMs: finishedAt - preparedAt, totalMs: finishedAt - startedAt,
          fileMs, promptMs, focusMs,
          promptMethod, promptFirst,
          imageCount: recipe.images.length, bytes: totalBytes } }).catch(() => {});
      closeClipboardPickerModal();
    } catch (error) {
      if (!isCurrent()) return;
      selectionInProgress = false;
      postToPicker({ type: 'CIP_HOST_ERROR', message: error.message || 'Could not apply recipe.' });
    }
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

  async function selectBatchFiles(items, selectionSession) {
    try {
      if (!Array.isArray(items) || items.length === 0) throw new Error('No files selected.');
      const filePromises = items.map(async (item, index) => {
        if (item.kind === 'image') {
          const response = await chrome.runtime.sendMessage({ action: 'GET_IMAGE_DATA', id: item.id });
          if (!response?.success || response.image?.id !== item.id || typeof response.image.dataUrl !== 'string') {
            throw new Error(response?.error || 'Could not load saved image.');
          }
          const subtype = response.image.mimeType?.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'png';
          const filename = `image_${Date.now()}_${index}_${Math.floor(Math.random() * 10000)}.${subtype}`;
          return dataURLtoFile(response.image.dataUrl, filename);
        } else if (item.kind === 'download') {
          const response = await chrome.runtime.sendMessage({
            action: 'FETCH_DOWNLOAD_DATA',
            downloadId: item.id
          });
          if (!response?.success || typeof response.dataUrl !== 'string') {
            throw new Error(response?.error || 'Could not access downloaded file.');
          }
          return dataURLtoFile(response.dataUrl, item.name || 'download');
        }
        throw new Error('Unknown item type.');
      });

      const results = await Promise.allSettled(filePromises);
      const successfulFiles = results
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value);

      if (successfulFiles.length === 0) {
        const firstError = results.find((r) => r.status === 'rejected')?.reason;
        throw new Error(firstError?.message || 'Could not load selected files.');
      }

      if (!activeModal?.isConnected || pickerToken !== selectionSession || isDomainDisabled()) return;
      attachFilesToInput(successfulFiles);
    } catch (error) {
      selectionInProgress = false;
      postToPicker({ type: 'CIP_HOST_ERROR', message: error.message || 'Could not attach selected files.' });
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

    // Newer Chromium builds can decode directly into bytes, avoiding a large
    // temporary binary string and a JavaScript loop on the site's UI thread.
    let bytes;
    if (typeof Uint8Array.fromBase64 === 'function') bytes = Uint8Array.fromBase64(parts[1]);
    else {
      const binary = atob(parts[1]);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    }
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
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isExpectedPickerMessageEvent,
    normalizePickerCommand,
    routePickerCommand,
    isTrustedPickerEscape,
    isTrustedPickerBackdrop
  };
}
