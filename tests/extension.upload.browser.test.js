// Full unpacked-extension smoke test in a disposable browser profile.
// Requires Playwright and a Chrome build exposing Extensions.loadUnpacked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const temporaryRoot = path.join(root, 'tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'extension-upload-'));
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const fixture = `<button id="upload">Upload image</button>
<button id="prompt">Add ingredients to the prompt box</button>
<div id="other-editor" contenteditable="true">Other editor</div>
<flow-prompt-box><div id="composer" contenteditable="true">What do you want to create?</div></flow-prompt-box>
<style>
  #ingredients { position: fixed; inset: 0; width: 100vw; height: 100vh;
    margin: 0; border: 0; padding: 0; background: rgba(0,0,0,.4); }
  #ingredients .panel { position: absolute; left: 30%; bottom: 120px;
    width: 400px; padding: 24px; background: white; }
</style>
<div id="ingredients" popover="manual"><div class="panel">
  <button id="prompt-upload">Upload media</button></div></div><script>
  window.deliveries = [];
  window.pasteDeliveries = [];
  window.dropCount = 0;
  document.querySelector('#composer').addEventListener('paste', async event => {
    const files = Array.from(event.clipboardData.items, item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    window.pasteDeliveries.push(await Promise.all(files.map(async file => ({
      type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
    }))));
  });
  document.querySelector('#composer').addEventListener('drop', () => window.dropCount++);
  const ingredients = document.querySelector('#ingredients');
  document.querySelector('#prompt').onclick = () => ingredients.showPopover();
  ingredients.onclick = event => { if (event.target === ingredients) ingredients.hidePopover(); };
  const upload = async event => {
    const fromPrompt = event.currentTarget.id === 'prompt-upload';
    // Same temporary input / Promise / change / cancel lifecycle as Flow's
    // public upload helper, inspected on 2026-10-06.
    const files = await new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.png,.jpg,.jpeg,.webp';
      input.multiple = true; input.style.display = 'none';
      input.addEventListener('change', () => {
        const files = Array.from(input.files); input.remove(); resolve(files);
      });
      input.addEventListener('cancel', () => { input.remove(); resolve([]); });
      document.body.appendChild(input); input.click();
    });
    // Flow's menu uploader checks its component lifetime after the chooser
    // resolves. Closing its menu beforehand makes the selected files unused.
    if (fromPrompt && !ingredients.matches(':popover-open')) {
      window.promptUploadCanceled = true; return;
    }
    window.deliveries.push(await Promise.all(files.map(async file => ({
      name: file.name, size: file.size, type: file.type,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer()))
    }))));
  };
  document.querySelector('#upload').onclick = upload;
  document.querySelector('#prompt-upload').onclick = upload;
</script>`;

(async () => {
  let context;
  try {
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    context = await chromium.launchPersistentContext(profile, {
      headless: true, ...(executablePath ? { executablePath } : {}),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    const browserSession = await context.browser().newBrowserCDPSession();
    const { id } = await browserSession.send('Extensions.loadUnpacked', { path: root });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const saved = await popup.evaluate(async dataUrl => chrome.runtime.sendMessage({
      action: 'SAVE_IMAGE', image: { id: 'img_upload_qa', dataUrl,
        mimeType: 'image/png', width: 1, height: 1, timestamp: Date.now() }
    }), imageData);
    assert.equal(saved.success, true);
    await context.route('http://upload.test/**', route => route.fulfill({
      contentType: 'text/html', body: fixture
    }));
    const page = await context.newPage();
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto('http://upload.test/');
      const fromPrompt = attempt > 0;
      if (fromPrompt) {
        await page.click('#prompt');
        await page.click('#prompt-upload');
      } else await page.click('#upload');
      await page.waitForSelector('#cip-modal-host.cip-visible');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#cip-modal-host')).opacity === '1');
      let frame;
      await assert.doesNotReject(async () => {
        await page.waitForFunction(() => document.querySelector('#cip-modal-host') !== null);
        frame = page.frames().find(item => item.url().includes('/picker.html'));
        if (!frame) frame = await page.waitForEvent('framenavigated', {
          predicate: item => item.url().includes('/picker.html')
        });
        await frame.locator('.tile').first().waitFor();
      });
      // A real click on the iframe border is retargeted to the closed-shadow
      // host. It must not cancel the picker before any selection is delivered.
      const dom = await page.context().newCDPSession(page);
      const { root: documentNode } = await dom.send('DOM.getDocument', { depth: -1, pierce: true });
      function findFrame(node) {
        if (node.nodeName === 'IFRAME') return node.nodeId;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
          const found = findFrame(child); if (found) return found;
        }
      }
      const { model } = await dom.send('DOM.getBoxModel', { nodeId: findFrame(documentNode) });
      await page.mouse.click(model.border[0] + 0.25, model.border[1] + 8);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#cip-modal-host.cip-visible').count(), 1,
        'clicks inside the closed-shadow dialog must not dismiss it as a backdrop');
      assert.deepEqual(await page.evaluate(() => window.deliveries), []);
      await frame.locator('.tile').first().click();
      await page.waitForFunction(() => window.deliveries.length === 1);
      const files = await page.evaluate(() => window.deliveries[0]);
      assert.equal(files.length, 1);
      assert.equal(files[0].type, 'image/png');
      assert.deepEqual(files[0].bytes, [...Buffer.from(imageData.split(',')[1], 'base64')]);
      if (fromPrompt) {
        assert.equal(await page.evaluate(() => window.promptUploadCanceled || false), false);
        assert.equal(await page.locator('#ingredients').evaluate(element => element.matches(':popover-open')), true,
          'Flow-style prompt menu must stay alive until the selected image is delivered');
      }
      await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
      assert.equal(await page.locator('input[type="file"]').count(), 0);
      await dom.detach();
    }
    // The shortcut's actual content-message path must paste into Flow's
    // composer rather than repeating the last file input upload.
    await page.locator('#composer').focus();
    const opened = await popup.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://upload.test/*' });
      return chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_PICKER' });
    });
    assert.equal(opened.success, true);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#cip-modal-host')).opacity === '1');
    const shortcutFrame = page.frames().find(frame => frame.url().includes('/picker.html'))
      || await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/picker.html') });
    await shortcutFrame.locator('.tile').first().click();
    await page.waitForFunction(() => window.pasteDeliveries.length === 1);
    const pasted = await page.evaluate(() => window.pasteDeliveries[0]);
    assert.equal(pasted[0].type, 'image/png');
    assert.deepEqual(pasted[0].bytes, [...Buffer.from(imageData.split(',')[1], 'base64')]);
    assert.equal(await page.evaluate(() => window.dropCount), 0);
    assert.equal(await page.evaluate(() => window.deliveries.length), 1);
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    // Backdrop dismissal must still work.
    await page.goto('http://upload.test/');
    await page.click('#upload');
    await page.waitForSelector('#cip-modal-host.cip-visible');
    await page.mouse.click(2, 2);
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    console.log('Full extension: Flow toolbar, prompt popover and shortcut paste, exact image bytes, dialog clicks and backdrop dismissal passed.');
  } finally {
    await context?.close();
    const resolved = path.resolve(profile);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('extension-upload-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
