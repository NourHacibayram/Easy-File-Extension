// Real unpacked-extension recipe tests, isolated from the user's browser/data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const temporaryRoot = path.join(root, 'tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'extension-recipes-'));
const output = path.join(temporaryRoot, 'ui-preview');
fs.mkdirSync(output, { recursive: true });
const fixture = `<button id="upload">Upload</button>
<section class="conversation"><div id="composer" contenteditable="true">Existing text. </div></section>
<textarea id="textarea">Before [] after</textarea>
<script>
window.imagePastes = []; window.textPastes = []; window.imageTimes = [];
window.measureOnly = false; window.acceptImages = true; window.filePasteCount = 0; window.editorDelay = 0;
window.acceptText = true; window.handleText = true; window.promptDelay = 0;
window.deliverySequence = []; window.delayOnlyAfterFiles = false;
const composer = document.querySelector('#composer');
window.receiveFiles = files => {
  window.deliverySequence.push('files');
  window.imageTimes.push(performance.now());
  return Promise.all(files.map(async file => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return window.measureOnly ? { size: bytes.length,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('') }
      : { name: file.name, type: file.type, bytes: Array.from(bytes) };
  })).then(files => window.imagePastes.push(files));
};
composer.addEventListener('paste', event => {
  const files = Array.from(event.clipboardData.files);
  if (files.length) {
    window.filePasteCount++;
    if (!window.acceptImages) return;
    event.preventDefault();
    const end = performance.now() + window.editorDelay;
    while (performance.now() < end) {}
    window.receiveFiles(files);
  } else if (window.acceptText && window.handleText) {
    const end = performance.now() + ((!window.delayOnlyAfterFiles || window.deliverySequence.at(-1) === 'files') ? window.promptDelay : 0);
    while (performance.now() < end) {}
    event.preventDefault(); const text = event.clipboardData.getData('text/plain');
    window.deliverySequence.push('prompt');
    window.textPastes.push(text); composer.append(document.createTextNode(text));
  }
});
document.querySelector('#upload').onclick = () => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
  document.body.append(input); input.click();
};
</script>`;

(async () => {
  let context;
  try {
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    context = await chromium.launchPersistentContext(profile, {
      headless: true, ...(executablePath ? { executablePath } : {}),
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
    });
    context.setDefaultTimeout(15000);
    const browser = await context.browser().newBrowserCDPSession();
    const { id } = await browser.send('Extensions.loadUnpacked', { path: root });
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/recipes.html`);
    const errors = [];
    manager.on('pageerror', error => errors.push(error.message));
    async function request(message) {
      const result = await manager.evaluate(message => Promise.race([
        chrome.runtime.sendMessage(message),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`No response: ${message.action}`)), 10000))
      ]), message);
      assert.equal(result.success, true, result.error); return result;
    }
    const originals = await manager.evaluate(async () => {
      const originals = {};
      for (const [id, color] of [['reference_a', '#7c9279'], ['reference_b', '#d4b891']]) {
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
        const paint = canvas.getContext('2d'); paint.fillStyle = color; paint.fillRect(0, 0, 512, 512);
        paint.fillStyle = '#191c19'; paint.fillRect(128, 100, 256, 312);
        paint.fillStyle = '#ebe9df'; paint.font = '120px sans-serif'; paint.fillText(id.endsWith('a') ? 'A' : 'B', 214, 300);
        const dataUrl = canvas.toDataURL(); originals[id] = dataUrl;
        const saved = await chrome.runtime.sendMessage({ action: 'SAVE_IMAGE', image: {
          id, dataUrl, width: 512, height: 512, mimeType: 'image/png', timestamp: Date.now()
        } });
        if (!saved.success) throw new Error(saved.error);
      }
      return originals;
    });
    await manager.reload();
    await manager.locator('.reference-choice input').nth(1).waitFor();
    await manager.locator('#recipe-name').fill('Writing assistant');
    const plainPrompt = '  اكتب وصفاً مختصراً\nKeep the original details.  ';
    await manager.locator('#recipe-prompt').fill(plainPrompt);
    await manager.locator('#save-recipe').click();
    await manager.locator('#recipe-status').filter({ hasText: 'Saved.' }).waitFor();
    let recipes = (await request({ action: 'GET_RECIPES' })).recipes;
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].images.length, 0, 'UI saves prompts without requiring images');
    assert.equal(await manager.locator('.saved-recipe span').textContent(), 'Prompt only');
    await manager.locator('#new-recipe').click();
    await manager.locator('#recipe-name').fill('Product campaign');
    const imagePrompt = 'Use these references in their listed order.\nSoft light, dark background.';
    await manager.locator('#recipe-prompt').fill(imagePrompt);
    await manager.locator('.reference-choice input').nth(0).check();
    await manager.locator('.reference-choice input').nth(1).check();
    await manager.getByRole('button', { name: 'Move reference 2 earlier', exact: true }).click();
    await manager.locator('#save-recipe').click();
    await manager.locator('#recipe-status').filter({ hasText: 'Saved.' }).waitFor();
    recipes = (await request({ action: 'GET_RECIPES' })).recipes;
    const imageRecipe = recipes.find(recipe => recipe.name === 'Product campaign');
    assert.deepEqual(imageRecipe.images.map(image => image.id), ['reference_a', 'reference_b']);
    await request({ action: 'CLEAR_ALL' });
    await manager.reload();
    await manager.locator('.saved-recipe').filter({ hasText: 'Product campaign' }).click();
    assert.equal(await manager.locator('.reference-choice input:checked').count(), 2,
      'saved reference images stay editable after gallery cleanup');
    await manager.waitForFunction(() => [...document.querySelectorAll('.reference-choice img')].every(img => img.complete && img.naturalWidth));
    await manager.setViewportSize({ width: 1280, height: 900 });
    await manager.screenshot({ path: path.join(output, 'recipes-desktop.png'), fullPage: true });
    await manager.setViewportSize({ width: 360, height: 800 });
    assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await manager.screenshot({ path: path.join(output, 'recipes-compact.png'), fullPage: true });

    await context.route('https://recipes.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    const page = await context.newPage();
    await page.goto('https://recipes.test/');
    async function openPicker(selector = '#composer') {
      await page.locator(selector).focus();
      await requestShortcut();
      await page.waitForSelector('#cip-modal-host.cip-visible');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#cip-modal-host')).opacity === '1');
      const frame = page.frames().find(frame => frame.url().includes('/picker.html'))
        || await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/picker.html') });
      await frame.locator('#source-recipes').click();
      await frame.locator('.recipe-row').nth(1).waitFor();
      return frame;
    }
    async function requestShortcut() {
      const result = await manager.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'https://recipes.test/*' });
        return chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_PICKER' });
      });
      assert.equal(result.success, true);
    }
    async function useRecipe(frame, name) {
      await frame.locator('.recipe-row').filter({ hasText: name }).getByRole('button', { name: 'Use recipe' }).click();
    }
    let frame = await openPicker();
    assert.equal(await frame.locator('.recipe-row').filter({ hasText: 'Writing assistant' }).locator('.recipe-cover').textContent(), 'Aa');
    await useRecipe(frame, 'Writing assistant');
    await page.waitForFunction(() => window.textPastes.length === 1);
    assert.equal(await page.locator('#composer').textContent(), 'Existing text. ' + plainPrompt);
    assert.equal(await page.evaluate(() => window.imagePastes.length), 0, 'text-only recipes dispatch no image/drop event');
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));

    frame = await openPicker();
    const selectedAt = await page.evaluate(() => performance.now());
    await useRecipe(frame, 'Product campaign');
    await page.waitForFunction(() => window.imagePastes.length === 1 && window.textPastes.length === 2);
    const files = await page.evaluate(() => window.imagePastes[0]);
    assert.equal(files.length, 2);
    files.forEach((file, index) => {
      assert.equal(file.type, 'image/png');
      assert.deepEqual(file.bytes, [...Buffer.from(originals[imageRecipe.images[index].id].split(',')[1], 'base64')]);
    });
    assert.equal(await page.locator('#composer').textContent(), 'Existing text. ' + plainPrompt + imagePrompt);
    assert.deepEqual(await page.evaluate(() => window.deliverySequence.slice(-2)), ['files', 'prompt'], 'other sites retain files-first delivery');
    console.log(`Recipe selection to image handler: ${Math.round(await page.evaluate(() => window.imageTimes[0]) - selectedAt)} ms (2 references, includes test click).`);
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));

    // Plain contenteditable uses native text editing, retaining text and caret.
    await page.evaluate(() => {
      window.handleText = false;
      const editor = document.querySelector('#composer'); editor.textContent = 'Before [] after';
      editor.focus(); const range = document.createRange(); range.setStart(editor.firstChild, 8); range.collapse(true);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    frame = await openPicker(); await useRecipe(frame, 'Writing assistant');
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    assert.equal(await page.locator('#composer').evaluate(editor => editor.innerText.replace(/\u00a0/g, ' ')), 'Before [' + plainPrompt + '] after');
    // A textarea has no synthetic-paste default, so its native setter and
    // input notification must insert at the remembered caret as well.
    await page.locator('#textarea').focus();
    await page.locator('#textarea').evaluate(editor => editor.setSelectionRange(8, 8));
    frame = await openPicker('#textarea'); await useRecipe(frame, 'Writing assistant');
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    assert.equal(await page.locator('#textarea').inputValue(), 'Before [' + plainPrompt + '] after');

    // A rejected prompt after accepted images leaves an error and allows a
    // retry without attaching the same reference images twice.
    await page.evaluate(() => { window.acceptText = false; window.handleText = true; });
    frame = await openPicker();
    await page.locator('#composer').evaluate(editor => editor.contentEditable = 'false');
    await useRecipe(frame, 'Product campaign');
    await frame.locator('.toast.visible').filter({ hasText: 'References sent' }).waitFor();
    await page.waitForFunction(() => window.imagePastes.length === 2);
    await page.evaluate(() => { window.acceptText = true; document.querySelector('#composer').contentEditable = 'true'; });
    await useRecipe(frame, 'Product campaign');
    await page.waitForFunction(() => window.textPastes.length === 3);
    assert.equal(await page.evaluate(() => window.imagePastes.length), 2, 'retry after partial success must not duplicate images');
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));

    await page.click('#upload');
    await page.waitForSelector('#cip-modal-host.cip-visible');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#cip-modal-host')).opacity === '1');
    frame = page.frames().find(frame => frame.url().includes('/picker.html'))
      || await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/picker.html') });
    await frame.locator('#source-recipes').click();
    await frame.locator('.recipe-use').first().waitFor();
    assert.equal(await frame.locator('.recipe-use:enabled').count(), 0, 'file inputs cannot receive recipe prompts');
    await page.mouse.click(2, 2);
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    frame = await openPicker();
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.screenshot({ path: path.join(output, 'recipe-picker.png') });
    await frame.waitForFunction(() => [...document.querySelectorAll('img.recipe-cover')].every(img => img.complete && img.naturalWidth));
    const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.js'));
    await worker.evaluate(() => {
      const original = chrome.storage.local.get.bind(chrome.storage.local);
      globalThis.recipeReadProbe = { active: 0, maximum: 0, original };
      chrome.storage.local.get = async keys => {
        if (typeof keys !== 'string' || !keys.startsWith('recipeImageV1:')) return original(keys);
        const probe = globalThis.recipeReadProbe;
        probe.maximum = Math.max(probe.maximum, ++probe.active);
        try {
          // Force the first saved reference to finish last.
          await new Promise(resolve => setTimeout(resolve, keys.endsWith('reference_a') ? 80 : 10));
          return await original(keys);
        } finally { probe.active--; }
      };
    });
    await useRecipe(frame, 'Product campaign');
    await page.waitForFunction(() => window.imagePastes.length === 3);
    const parallelism = await worker.evaluate(() => {
      const probe = globalThis.recipeReadProbe;
      chrome.storage.local.get = probe.original;
      return probe.maximum;
    });
    assert.equal(parallelism, 2, 'selected recipe reads overlap with a bounded two-image concurrency');
    const reordered = await page.evaluate(() => window.imagePastes[2]);
    assert.deepEqual(reordered[0].bytes, [...Buffer.from(originals.reference_a.split(',')[1], 'base64')]);
    assert.deepEqual(reordered[1].bytes, [...Buffer.from(originals.reference_b.split(',')[1], 'base64')]);
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    await worker.evaluate(() => {
      const original = chrome.storage.local.get.bind(chrome.storage.local);
      globalThis.recipeCoverProbe = { original, originalsRead: 0 };
      chrome.storage.local.get = keys => {
        if (typeof keys === 'string' && keys.startsWith('recipeImageV1:')) globalThis.recipeCoverProbe.originalsRead++;
        return original(keys);
      };
    });
    frame = await openPicker();
    await frame.waitForFunction(() => [...document.querySelectorAll('img.recipe-cover')].every(img => img.complete && img.naturalWidth));
    assert.equal(await worker.evaluate(() => {
      const probe = globalThis.recipeCoverProbe; chrome.storage.local.get = probe.original; return probe.originalsRead;
    }), 0, 'opening cached recipe covers must not load full original records');
    await page.mouse.click(2, 2);
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));

    // Exercise actual multi-megabyte images, not only tiny fixture thumbnails.
    const large = await manager.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1000;
      const paint = canvas.getContext('2d'); const pixels = paint.createImageData(canvas.width, canvas.height);
      for (let offset = 0; offset < pixels.data.length; offset += 65536) {
        crypto.getRandomValues(pixels.data.subarray(offset, Math.min(offset + 65536, pixels.data.length)));
      }
      for (let offset = 3; offset < pixels.data.length; offset += 4) pixels.data[offset] = 255;
      paint.putImageData(pixels, 0, 0);
      const dataUrl = canvas.toDataURL();
      const saved = await chrome.runtime.sendMessage({ action: 'SAVE_IMAGE', image: {
        id: 'large_reference', dataUrl, width: canvas.width, height: canvas.height, mimeType: 'image/png', timestamp: Date.now()
      } });
      if (!saved.success) throw new Error(saved.error);
      await chrome.runtime.sendMessage({ action: 'GET_IMAGE_THUMBNAIL', id: 'large_reference' });
      const result = await chrome.runtime.sendMessage({ action: 'SAVE_RECIPE', recipe: {
        name: 'Large reference', prompt: 'Keep the detail.', imageIds: ['large_reference']
      } });
      if (!result.success) throw new Error(result.error);
      const bytes = await (await fetch(dataUrl)).arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      return { bytes: bytes.byteLength, sha256 };
    });
    assert.ok(large.bytes > 4 * 1024 * 1024, 'performance fixture must exceed 4 MiB');
    await page.evaluate(() => window.measureOnly = true);
    frame = await openPicker();
    await frame.locator('.recipe-row').filter({ hasText: 'Large reference' }).waitFor();
    const largeStart = await page.evaluate(() => performance.now());
    await useRecipe(frame, 'Large reference');
    await page.waitForFunction(() => window.imagePastes.length === 4);
    const largeTime = await page.evaluate(() => window.imageTimes[3]);
    assert.equal(await page.evaluate(() => window.imagePastes[3][0].size), large.bytes, 'large-image optimization must preserve original file size');
    assert.equal(await page.evaluate(() => window.imagePastes[3][0].sha256), large.sha256, 'large-image optimization must preserve every original byte');
    console.log(`Large recipe: ${(large.bytes / 1024 / 1024).toFixed(1)} MiB delivered in ${Math.round(largeTime - largeStart)} ms (local editor, includes test click).`);

    // Offline fixture uses the dedicated drop-zone ancestor observed on live
    // Gemini. No authenticated account or Gemini network request is involved.
    const geminiFixture = fixture.replace('class="conversation"', 'class="xap-uploader-dropzone"')
      .replace('<div id="composer" contenteditable="true">Existing text. </div>',
        '<rich-textarea><div id="composer" class="ql-editor" style="white-space:pre-wrap" contenteditable="true">Existing text. </div></rich-textarea>') + `<script>
      window.acceptDrop = true; window.deliverDrop = false; window.dropCount = 0;
      window.nativePrompts = [];
      let pendingNative = null;
      document.querySelector('#composer').addEventListener('input', event => {
        if (event.inputType === 'insertText') {
          if (pendingNative === null) {
            const end = performance.now() + (window.delayOnlyAfterFiles && window.deliverySequence.at(-1) === 'files' ? window.promptDelay : 0);
            while (performance.now() < end) {}
            window.deliverySequence.push('prompt');
            pendingNative = [];
            queueMicrotask(() => {
              const text = pendingNative.join(''); pendingNative = null;
              window.nativePrompts.push(text); window.textPastes.push(text);
            });
          }
          pendingNative.push(event.data === null ? '\\n' : event.data);
        }
      });
      document.querySelector('.xap-uploader-dropzone').addEventListener('drop', event => {
        window.dropCount++;
        if (!window.acceptDrop) return;
        event.preventDefault();
        if (window.deliverDrop) window.receiveFiles(Array.from(event.dataTransfer.files));
      });
    </script>`;
    await context.route('https://gemini.google.com/**', route => route.fulfill({ contentType: 'text/html', body: geminiFixture }));
    const gemini = await context.newPage();
    await gemini.goto('https://gemini.google.com/app');
    async function openGeminiPicker() {
      await gemini.bringToFront();
      await gemini.evaluate(() => window.deliverySequence = []);
      await gemini.locator('#composer').focus();
      await manager.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_PICKER' });
      });
      await gemini.waitForSelector('#cip-modal-host.cip-visible');
      await gemini.waitForFunction(() => getComputedStyle(document.querySelector('#cip-modal-host')).opacity === '1');
      const picker = gemini.frames().find(frame => frame.url().includes('/picker.html'))
        || await gemini.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/picker.html') });
      await picker.locator('#source-recipes').click();
      await picker.waitForFunction(() => document.querySelector('#source-recipes').getAttribute('aria-selected') === 'true');
      await picker.locator('.recipe-row').nth(1).waitFor();
      return picker;
    }
    await gemini.evaluate(() => {
      window.editorDelay = 65;
      const editor = document.querySelector('#composer'); editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    frame = await openGeminiPicker(); await useRecipe(frame, 'Product campaign');
    await gemini.waitForFunction(() => window.imagePastes.length === 1 && !document.querySelector('#cip-modal-host'));
    assert.equal(await gemini.evaluate(() => window.dropCount), 0, 'working paste must bypass even a drop zone that cancels without attaching');
    assert.equal(await gemini.evaluate(() => window.filePasteCount), 1, 'Gemini retains the working image clipboard delivery');
    assert.equal(await gemini.locator('#composer').innerText(), 'Existing text. ' + imagePrompt);
    assert.deepEqual(await gemini.evaluate(() => window.nativePrompts), [imagePrompt]);
    assert.deepEqual(await gemini.evaluate(() => window.deliverySequence), ['prompt', 'files'], 'Gemini receives text before new image delivery');
    const geminiFiles = await gemini.evaluate(() => window.imagePastes[0]);
    assert.deepEqual(geminiFiles.map(file => file.bytes), files.map(file => file.bytes));
    await manager.waitForFunction(async () => {
      const { lastRecipeTimingV1: timing } = await chrome.storage.local.get('lastRecipeTimingV1');
      return timing?.imageCount === 2 && timing.editorMs >= 60;
    });
    const timing = await manager.evaluate(async () => (await chrome.storage.local.get('lastRecipeTimingV1')).lastRecipeTimingV1);
    assert.equal(timing.bytes, geminiFiles.reduce((sum, file) => sum + file.bytes.length, 0));
    assert.ok(timing.fileMs >= 60, 'slow image handler is attributed to Files');
    assert.ok(timing.promptMs < timing.fileMs, 'prompt handler is measured separately');
    assert.ok(timing.focusMs >= 0);
    assert.ok(Math.abs(timing.totalMs - timing.relayMs - timing.prepareMs - timing.editorMs) < 1);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.locator('#insertion-timing-summary').click();
    assert.match(await popup.locator('#insertion-timing-detail').textContent(), /Connect .*Prepare .*Editor .*2 images/);
    assert.match(await popup.locator('#insertion-timing-detail').textContent(), /Files .*Prompt .*Focus /);
    await popup.screenshot({ path: path.join(output, 'popup-timing.png') });

    await gemini.evaluate(() => { window.acceptImages = false; window.deliverDrop = true; window.editorDelay = 0; });
    frame = await openGeminiPicker(); await useRecipe(frame, 'Product campaign');
    await gemini.waitForFunction(() => window.imagePastes.length === 2 && !document.querySelector('#cip-modal-host'));
    assert.equal(await gemini.evaluate(() => window.dropCount), 1, 'rejected paste falls back to one bubbled drop');
    assert.equal(await gemini.evaluate(() => window.filePasteCount), 2);
    assert.equal(await gemini.evaluate(() => window.textPastes.length), 2, 'prompt is inserted once per recipe');

    await gemini.evaluate(() => window.acceptDrop = false);
    frame = await openGeminiPicker(); await useRecipe(frame, 'Product campaign');
    await frame.locator('.toast.visible').filter({ hasText: 'did not accept the reference images' }).waitFor();
    assert.equal(await gemini.evaluate(() => window.imagePastes.length), 2, 'rejected files leave the picker open');
    assert.equal(await gemini.evaluate(() => window.textPastes.length), 3, 'Gemini reports the prompt already inserted before failed files');
    await gemini.evaluate(() => window.acceptImages = true);
    await useRecipe(frame, 'Product campaign');
    await gemini.waitForFunction(() => window.imagePastes.length === 3 && !document.querySelector('#cip-modal-host'));
    assert.equal(await gemini.evaluate(() => window.filePasteCount), 4);
    assert.equal(await gemini.evaluate(() => window.textPastes.length), 3, 'retry after rejected images does not repeat the prompt');
    assert.equal(await gemini.evaluate(() => window.dropCount), 2, 'retry accepted by paste never dispatches a duplicate drop');

    // Native prompt insertion bypasses a costly image-aware paste importer,
    // preserving existing text, a selected replacement range and undo.
    const lastTiming = await manager.evaluate(async () => (await chrome.storage.local.get('lastRecipeTimingV1')).lastRecipeTimingV1.timestamp);
    await gemini.evaluate(() => { window.promptDelay = 65; window.delayOnlyAfterFiles = true; window.editorDelay = 0; });
    frame = await openGeminiPicker(); await useRecipe(frame, 'Product campaign');
    await gemini.waitForFunction(() => window.imagePastes.length === 4 && !document.querySelector('#cip-modal-host'));
    await manager.waitForFunction(async timestamp => {
      const { lastRecipeTimingV1: timing } = await chrome.storage.local.get('lastRecipeTimingV1');
      return timing.timestamp > timestamp;
    }, lastTiming);
    const fastPrompt = await manager.evaluate(async () => (await chrome.storage.local.get('lastRecipeTimingV1')).lastRecipeTimingV1);
    assert.equal(await gemini.evaluate(() => window.nativePrompts.length), 4, 'image recipes bypass the text paste handler');
    assert.deepEqual(await gemini.evaluate(() => window.deliverySequence), ['prompt', 'files']);
    assert.equal(fastPrompt.promptFirst, true);
    assert.equal(fastPrompt.promptMethod, 'native');
    console.log(`Gemini native prompt: ${Math.round(fastPrompt.promptMs)} ms; slow paste importer bypassed.`);
    await gemini.evaluate(() => {
      window.promptDelay = 0;
      const editor = document.querySelector('#composer'); editor.textContent = 'Before [replace] after'; editor.focus();
      const range = document.createRange(); range.setStart(editor.firstChild, 8); range.setEnd(editor.firstChild, 15);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    frame = await openGeminiPicker(); await useRecipe(frame, 'Product campaign');
    await gemini.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    assert.equal(await gemini.locator('#composer').innerText(), 'Before [' + imagePrompt + '] after');
    await gemini.locator('#composer').press('Control+z');
    assert.equal(await gemini.locator('#composer').innerText(), 'Before [replace] after', 'native prompt insertion retains undo');

    // If the native operation is unavailable, retain the paste fallback.
    const geminiSession = await context.newCDPSession(gemini);
    const executionContexts = [];
    geminiSession.on('Runtime.executionContextCreated', ({ context }) => executionContexts.push(context));
    await geminiSession.send('Runtime.enable');
    const contentWorld = executionContexts.find(context => context.origin === `chrome-extension://${id}` && !context.auxData?.isDefault);
    assert.ok(contentWorld, 'locate the actual content-script world in this disposable profile');
    await geminiSession.send('Runtime.evaluate', { contextId: contentWorld.id, expression: 'document.execCommand = () => false' });
    await gemini.evaluate(() => {
      document.querySelector('#composer').textContent = 'Fallback. ';
      window.promptDelay = 65;
    });
    frame = await openGeminiPicker(); await useRecipe(frame, 'Product campaign');
    await gemini.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    assert.equal(await gemini.locator('#composer').textContent(), 'Fallback. ' + imagePrompt);
    assert.equal(await gemini.evaluate(() => window.nativePrompts.length), 5);
    assert.deepEqual(await gemini.evaluate(() => window.deliverySequence), ['prompt', 'files'], 'paste fallback also completes before image handling');

    const filesBeforeRejection = await gemini.evaluate(() => window.imagePastes.length);
    frame = await openGeminiPicker();
    await gemini.evaluate(() => {
      window.acceptText = false; document.querySelector('#composer').contentEditable = 'false';
    });
    await useRecipe(frame, 'Product campaign');
    await frame.locator('.toast.visible').filter({ hasText: 'did not accept the prompt' }).waitFor();
    assert.equal(await gemini.evaluate(() => window.imagePastes.length), filesBeforeRejection, 'a failed Gemini prompt does not dispatch pending images');
    await gemini.evaluate(() => {
      window.acceptText = true; document.querySelector('#composer').contentEditable = 'true';
    });
    await useRecipe(frame, 'Product campaign');
    await gemini.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    assert.equal(await gemini.evaluate(() => window.imagePastes.length), filesBeforeRejection + 1);
    assert.deepEqual(await gemini.evaluate(() => window.deliverySequence), ['prompt', 'files']);
    console.log('Gemini fixture: paste-first delivery despite misleading drop cancellation, exact references, drop fallback, rejected-file retry and local stage timings passed.');
    assert.deepEqual(errors, []);
    console.log('Full extension recipes: create, prompt-only, snapshots, exact file order, rich editor/textarea caret, safe retry, upload mode and bounded parallel reads passed.');
  } finally {
    await context?.close();
    const resolved = path.resolve(profile);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('extension-recipes-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
