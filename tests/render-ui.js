// Local UI snapshots and layout verification, using the existing visual fixtures.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.UI_OUTPUT_DIR || path.join(root, 'tmp', 'ui-preview'));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const filename = path.resolve(root, '.' + decodeURIComponent(new URL(route.request().url()).pathname));
      if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return route.fulfill({ status: 404, body: '' });
      const contentType = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }[path.extname(filename)];
      return route.fulfill({ body: fs.readFileSync(filename), contentType });
    });
    for (const [name, width, height] of [['popup', 420, 600], ['picker', 820, 540], ['picker-compact', 360, 500]]) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://ui.test/tests/${name.startsWith('picker') ? 'picker' : 'popup'}.visual.html`);
      await page.waitForFunction(() => document.documentElement.dataset.visualReady === 'true');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.screenshot({ path: path.join(output, `${name === 'popup' ? 'clipboard-gallery-popup' : name}.png`) });
      assert.deepEqual(errors, [], 'no fixture runtime errors');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no horizontal overflow`);
      if (name.startsWith('picker')) {
        await page.getByRole('tab', { name: 'Downloads' }).click();
        await page.screenshot({ path: path.join(output, `${name}-downloads.png`) });
        await page.getByRole('tab', { name: 'Protected' }).click();
        await page.screenshot({ path: path.join(output, `${name}-protected.png`) });
        await page.evaluate(() => {
          document.querySelector('#multiselect-bar').hidden = false;
          document.querySelector('#multiselect-count').textContent = '2 selected';
          document.querySelector('#multiselect-attach').disabled = false;
          document.querySelector('.picker-shell').classList.add('has-multiselect-bar', 'is-multiselect-active');
          document.querySelector('#toggle-multiselect').setAttribute('aria-pressed', 'true');
        });
        await page.screenshot({ path: path.join(output, `${name}-selection.png`) });
        assert.equal(await page.evaluate(() => {
          const rect = document.querySelector('#multiselect-attach').getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        }), true, `${name}: attach action stays visible`);
      } else {
        await page.evaluate(() => {
          document.querySelector('#image-grid').hidden = true;
          document.querySelector('#empty-state').hidden = false;
        });
        await page.screenshot({ path: path.join(output, 'popup-empty.png') });
        await page.evaluate(() => {
          document.querySelector('#empty-state').hidden = true;
          document.querySelector('#skeleton-grid').hidden = false;
          document.querySelector('#skeleton-grid').innerHTML = '<div class="skeleton-card"><div class="skeleton-image"></div><div class="skeleton-meta"><span class="skeleton-line"></span></div></div>'.repeat(4);
          const status = document.querySelector('#status-banner');
          status.hidden = false;
          status.dataset.kind = 'error';
          document.querySelector('#status-title').textContent = 'Could not load your gallery';
          document.querySelector('#status-detail').textContent = 'Try again in a moment.';
          document.querySelector('#retry-load-btn').hidden = false;
        });
        await page.screenshot({ path: path.join(output, 'popup-error.png') });
      }
      console.log(`${name}: layout and tab previews OK`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
