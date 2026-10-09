// Real Chromium DOM and separate MAIN/ISOLATED worlds, with a mocked extension
// transport. Run with Playwright installed (or NODE_PATH pointing to it).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.ok(Number(manifest.minimum_chrome_version) >= 111);
assert.ok(manifest.content_scripts.some(script => script.world === 'MAIN'
  && script.run_at === 'document_start' && script.js.includes('page-file-picker.js')));
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const fixture = `
  <link rel="stylesheet" href="/content.css">
  <input id="unrelated" type="file" accept="image/*">
  <button id="upload">Upload image</button>
  <div id="mount"></div>
  <script src="/fixture.js"></script>`;
const fixtureScript = `
  window.mode = 'detached-click';
  window.deliveries = [];
  window.inputEvents = 0;
  const unrelated = document.querySelector('#unrelated');
  unrelated.onchange = () => window.wrongDeliveries = (window.wrongDeliveries || 0) + 1;
  document.querySelector('#upload').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = window.mode === 'pdf' ? 'application/pdf' : 'image/*';
    input.oninput = () => window.inputEvents++;
    input.onchange = () => {
      window.deliveries.push(Array.from(input.files, file => ({ name: file.name, type: file.type, size: file.size })));
    };
    window.lastInput = input;
    if (window.mode.startsWith('attached')) document.querySelector('#mount').appendChild(input);
    if (window.mode === 'fragment-click') {
      window.fragment = document.createDocumentFragment();
      window.fragment.append(input, document.createElement('span'));
    }
    if (window.mode === 'shadow-click') {
      const host = document.createElement('div');
      document.querySelector('#mount').appendChild(host);
      host.attachShadow({ mode: 'open' }).appendChild(input);
    }
    if (window.mode.endsWith('showPicker')) input.showPicker();
    else input.click();
  };
`;

(async () => {
  const origin = 'http://upload.test';
  let browser;
  try {
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    // Serve the fixture entirely through Playwright; no external network.
    await page.context().route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      const contentType = pathname === '/fixture.js' ? 'text/javascript'
        : pathname === '/content.css' ? 'text/css' : 'text/html';
      const body = pathname === '/fixture.js' ? fixtureScript
        : pathname === '/content.css' ? fs.readFileSync(path.join(root, 'content.css'), 'utf8')
        : pathname === '/picker.html' ? '<p>Mock extension picker</p>' : fixture;
      return route.fulfill({ contentType, body, headers: {
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
      }});
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    const stub = `
      // Keep this suite on the legacy decoding path even in a new Chrome;
      // unpacked-extension tests exercise native fromBase64 when available.
      Uint8Array.fromBase64 = undefined;
      window.transport = { token: '', listener: null };
      window.chrome = { runtime: {
        id: 'upload-test-extension',
        getURL: file => ${JSON.stringify(origin + '/')} + file,
        onMessage: { addListener: listener => window.transport.listener = listener },
        sendMessage: async message => {
          if (message.action === 'GET_DOMAIN_STATE') return { success: true, disabled: false };
          if (message.action === 'REGISTER_PICKER_SESSION') window.transport.token = message.token;
          if (message.action === 'GET_IMAGE_DATA') return { success: true, image: {
            id: message.id, mimeType: 'image/png', dataUrl: ${JSON.stringify(imageData)}
          }};
          return { success: true };
        }
      }};
    `;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: stub + fs.readFileSync(path.join(root, 'content.js'), 'utf8'),
      worldName: 'upload-test-isolated'
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: fs.readFileSync(path.join(root, 'page-file-picker.js'), 'utf8')
    });
    let isolatedId;
    async function isolated(expression) {
      const result = await cdp.send('Runtime.evaluate', {
        expression, contextId: isolatedId, awaitPromise: true, returnByValue: true
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    async function reset(mode) {
      await page.goto(origin);
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const world = await cdp.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'upload-test-isolated'
      });
      isolatedId = world.executionContextId;
      assert.equal(await isolated('typeof transport.listener'), 'function');
      await page.evaluate(mode => window.mode = mode, mode);
    }
    async function command(type) {
      const message = { action: 'PICKER_COMMAND', type, parentOrigin: origin,
        commandId: randomBytes(16).toString('hex'), imageId: 'img_test' };
      return isolated(`new Promise(resolve => transport.listener({
        ...${JSON.stringify(message)}, token: transport.token
      }, { id: chrome.runtime.id }, resolve))`);
    }
    async function pickerIsOpen() {
      return page.locator('#cip-modal-host').count();
    }
    async function selectedImageArrivesOnce() {
      assert.equal(await pickerIsOpen(), 1, 'upload opens extension picker');
      assert.equal((await command('CIP_PICK_IMAGE')).success, true);
      await page.waitForFunction(() => window.deliveries.length === 1);
      const result = await page.evaluate(() => ({
        files: window.deliveries[0], inputEvents: window.inputEvents,
        wrong: window.wrongDeliveries || 0
      }));
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].type, 'image/png');
      assert.ok(result.files[0].size > 0);
      assert.equal(result.inputEvents, 1);
      assert.equal(result.wrong, 0, 'never send files to the unrelated first input');
      await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    }

    for (const mode of ['detached-click', 'detached-showPicker', 'attached-click',
      'attached-showPicker', 'fragment-click', 'shadow-click']) {
      await reset(mode);
      await page.click('#upload');
      if (mode === 'fragment-click') {
        assert.equal(await page.evaluate(() => window.lastInput.parentNode === window.fragment
          && window.fragment.firstChild === window.lastInput), true, 'restore detached parent and sibling order');
      }
      await selectedImageArrivesOnce();
      console.log(`${mode}: selected image reached original change handler once`);
    }

    // Direct native input click remains supported.
    await reset('direct');
    await page.evaluate(() => {
      window.lastInput = document.querySelector('#unrelated');
      window.lastInput.oninput = () => window.inputEvents++;
      window.lastInput.onchange = () => window.deliveries.push(Array.from(window.lastInput.files,
        file => ({ name: file.name, type: file.type, size: file.size })));
    });
    await page.click('#unrelated');
    await selectedImageArrivesOnce();

    // Some upload widgets open on pointerdown, before their click is emitted.
    await reset('detached-click');
    await page.evaluate(() => {
      const button = document.querySelector('#upload');
      button.onpointerdown = button.onclick;
      button.onclick = null;
    });
    await page.click('#upload');
    await selectedImageArrivesOnce();

    // Keyboard-activated upload buttons keep the same trusted-action path.
    await reset('detached-showPicker');
    await page.focus('#upload');
    await page.press('#upload', 'Enter');
    await selectedImageArrivesOnce();

    // The website may detach its real input while the extension is open.
    await reset('attached-click');
    await page.click('#upload');
    await page.evaluate(() => window.lastInput.remove());
    await selectedImageArrivesOnce();

    // Shortcut selection pastes into the focused composer, even after a file
    // upload captured another input and with an earlier unrelated editor.
    await reset('attached-click');
    await page.click('#upload');
    await selectedImageArrivesOnce();
    await page.evaluate(() => {
      window.pastes = [];
      window.drops = 0;
      for (const id of ['other-editor', 'message-editor']) {
        const editor = document.createElement('div');
        editor.id = id; editor.contentEditable = 'true';
        editor.textContent = 'Message';
        editor.addEventListener('paste', event => {
          const files = Array.from(event.clipboardData.items, item => item.getAsFile()).filter(Boolean);
          if (files.length) { event.preventDefault(); window.pastes.push({ id, count: files.length, type: files[0].type }); }
        });
        editor.addEventListener('drop', () => window.drops++);
        document.body.append(editor);
      }
      document.querySelector('#message-editor').focus();
    });
    await isolated("transport.listener({ action: 'TOGGLE_PICKER' }, { id: chrome.runtime.id }, () => {})");
    assert.equal((await command('CIP_PICK_IMAGE')).success, true);
    await page.waitForFunction(() => window.pastes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.pastes), [{ id: 'message-editor', count: 1, type: 'image/png' }]);
    assert.equal(await page.evaluate(() => window.deliveries.length), 1, 'shortcut must not reuse an old upload input');
    assert.equal(await page.evaluate(() => window.drops), 0, 'handled paste must not send a duplicate drop');
    await page.waitForFunction(() => !document.querySelector('#cip-modal-host'));
    console.log('Shortcut: selected image pasted into focused composer once, without stale-input delivery');

    // Browse files must use the captured, detached input as well.
    await reset('detached-click');
    await page.click('#upload');
    const nativeChooser = page.waitForEvent('filechooser');
    assert.equal((await command('CIP_SHOW_ALL')).success, true);
    const chooser = await nativeChooser;
    await chooser.setFiles({ name: 'native.png', mimeType: 'image/png', buffer: Buffer.from(imageData.split(',')[1], 'base64') });
    await page.waitForFunction(() => window.deliveries.length === 1);
    assert.equal(await page.evaluate(() => window.deliveries[0][0].name), 'native.png');
    assert.equal(await page.evaluate(() => window.wrongDeliveries || 0), 0);

    // Disabled sites and ineligible file types retain the real native picker.
    for (const mode of ['disabled-site', 'pdf']) {
      await reset(mode);
      if (mode === 'disabled-site') {
        await isolated("transport.listener({ action: 'DOMAIN_STATE_CHANGED', disabled: true }, {}, () => {})");
      }
      const nativeChooser = page.waitForEvent('filechooser');
      await page.click('#upload');
      await nativeChooser;
      assert.equal(await pickerIsOpen(), 0);
    }

    // Page-forged bridge requests without any trusted action cannot open UI.
    await reset('detached-click');
    await page.evaluate(() => document.querySelector('#unrelated').dispatchEvent(new Event(
      'cip-file-picker-request', { bubbles: true, composed: true, cancelable: true })));
    assert.equal(await pickerIsOpen(), 0);
    console.log('Native fallback, site disable, input removal, and trusted-action guards: OK');
  } finally {
    await browser?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
