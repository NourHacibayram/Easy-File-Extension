const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storage = new Map();
let listener;
let failRecipeCommit = false;
const writes = [];
let originalReads = 0;
let generatedThumbnails = 0;
const chrome = {
  runtime: {
    id: 'test-extension',
    getURL: file => `chrome-extension://test-extension/${file}`,
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } },
    async getContexts() { return []; },
    async sendMessage(message) {
      if (message.action === 'CREATE_THUMBNAIL') generatedThumbnails++;
      return message.action === 'CREATE_THUMBNAIL'
        ? { success: true, thumbnailDataUrl: 'data:image/webp;base64,AA==' }
        : { success: true };
    }
  },
  storage: { local: {
    async setAccessLevel() {},
    async get(keys) {
      if (typeof keys === 'string' && keys.startsWith('recipeImageV1:')) originalReads++;
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      return Object.fromEntries(names.filter(key => storage.has(key)).map(key => [key, structuredClone(storage.get(key))]));
    },
    async set(values) {
      if (failRecipeCommit && Object.hasOwn(values, 'savedRecipesV1')) throw new Error('Storage full');
      writes.push(Object.keys(values));
      for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key); }
  } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  offscreen: { async createDocument() {}, async closeDocument() {} },
  downloads: { async search() { return []; } },
  tabs: { async query() { return []; }, async sendMessage() { return { success: true }; } }
};
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), vm.createContext({
  chrome, crypto: globalThis.crypto, console, URL, Blob, AbortController, setTimeout, clearTimeout, FileReader: class {}
}));
const manager = { id: chrome.runtime.id, url: chrome.runtime.getURL('recipes.html') };
const host = { id: chrome.runtime.id, url: 'https://editor.test/', tab: { id: 7, url: 'https://editor.test/' } };
const picker = { ...host, url: 'chrome-extension://dynamic-host/picker.html' };
const token = '0123456789abcdef0123456789abcdef';
const key = (recipeId, imageId) => `recipeImageV1:${recipeId}:${encodeURIComponent(imageId)}`;
const thumbKey = (recipeId, imageId) => `recipeImageThumbV1:${recipeId}:${encodeURIComponent(imageId)}`;
function send(message, sender = manager) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response: ${message.action}`)), 5000);
    listener(message, sender, result => { clearTimeout(timeout); resolve(result); });
  });
}
async function save(name, imageIds = [], id) {
  return send({ action: 'SAVE_RECIPE', recipe: { id, name, prompt: '  البرومبت\nKeep this spacing.  ', imageIds } });
}
async function select(recipeId, commandId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  await send({ action: 'REGISTER_PICKER_SESSION', token }, host);
  return send({ action: 'RELAY_PICKER_COMMAND', type: 'CIP_USE_RECIPE', token, recipeId,
    commandId, parentOrigin: 'https://editor.test' }, picker);
}
async function seed(id) {
  const dataUrl = `data:image/png;base64,${Buffer.from(id).toString('base64')}`;
  assert.equal((await send({ action: 'SAVE_IMAGE', image: { id, dataUrl, mimeType: 'image/png', width: 10, height: 10, timestamp: Date.now() } })).success, true);
  return dataUrl;
}

(async () => {
  const plain = await save('Prompt only');
  assert.equal(plain.success, true);
  assert.equal(plain.recipe.images.length, 0);
  assert.equal(plain.recipe.prompt, '  البرومبت\nKeep this spacing.  ');
  assert.equal((await select(plain.recipe.id)).success, true);
  assert.equal((await send({ action: 'GET_RECIPE_FOR_USE', token, recipeId: plain.recipe.id }, host)).success, true);
  assert.equal((await send({ action: 'GET_RECIPE_IMAGE_DATA', token, recipeId: plain.recipe.id, imageId: 'a' }, host)).success, false);

  const first = await seed('first');
  const second = await seed('second');
  const saved = await save('Two references', ['second', 'first']);
  assert.equal(saved.success, true);
  const recipe = saved.recipe;
  assert.deepEqual(Array.from(recipe.images, image => image.id), ['second', 'first']);
  assert.equal(storage.get(key(recipe.id, 'first')).dataUrl, first);
  assert.equal(storage.get(key(recipe.id, 'second')).dataUrl, second);
  const cover = await send({ action: 'GET_RECIPE_THUMBNAIL', recipeId: recipe.id, imageId: 'first' });
  assert.equal(cover.success, true, 'a cold recipe preview can be generated after snapshot commit without deadlocking saves');
  assert.equal(cover.thumbnailDataUrl, 'data:image/webp;base64,AA==');
  const readsAfterFirstCover = originalReads;
  for (let index = 0; index < 5; index++) {
    assert.equal((await send({ action: 'GET_RECIPE_THUMBNAIL', recipeId: recipe.id, imageId: 'first' })).thumbnailDataUrl, cover.thumbnailDataUrl);
  }
  assert.equal(originalReads, readsAfterFirstCover, 'warm recipe previews never read the original');
  assert.equal(Object.hasOwn(storage.get(key(recipe.id, 'first')), 'thumbnailDataUrl'), false,
    'thumbnail generation must not rewrite the full original');
  const previewsBeforeUpgrade = generatedThumbnails;
  storage.delete(thumbKey(recipe.id, 'first'));
  storage.set(key(recipe.id, 'first'), { ...storage.get(key(recipe.id, 'first')), thumbnailDataUrl: cover.thumbnailDataUrl });
  assert.equal((await send({ action: 'GET_RECIPE_THUMBNAIL', recipeId: recipe.id, imageId: 'first' })).success, true);
  assert.equal(generatedThumbnails, previewsBeforeUpgrade, '1.2.0 embedded previews migrate without re-encoding');
  assert.equal(storage.get(thumbKey(recipe.id, 'first')).thumbnailDataUrl, cover.thumbnailDataUrl);
  const upgradedReads = originalReads;
  await send({ action: 'GET_RECIPE_THUMBNAIL', recipeId: recipe.id, imageId: 'first' });
  assert.equal(originalReads, upgradedReads, 'upgraded recipes use the lightweight cache on later openings');
  assert.equal(JSON.stringify((await send({ action: 'GET_RECIPES' })).recipes).includes('data:image'), false,
    'lists contain metadata and prompts, never original image bytes');
  assert.ok(writes.filter(keys => keys.some(name => name.startsWith('recipeImageV1:'))).every(keys => keys.length === 1));

  for (const action of ['GET_RECIPES', 'SAVE_RECIPE', 'DELETE_RECIPE', 'GET_RECIPE_THUMBNAIL', 'GET_RECIPE_FOR_USE', 'GET_RECIPE_IMAGE_DATA']) {
    assert.equal((await send({ action, recipeId: recipe.id, imageId: 'first', token }, { ...host, id: 'another-extension' })).success, false);
  }
  assert.equal((await send({ action: 'GET_RECIPE_FOR_USE', recipeId: recipe.id, token }, host)).success, false,
    'an open session alone does not authorize an unselected recipe');
  await select(recipe.id);
  const detail = { action: 'GET_RECIPE_IMAGE_DATA', recipeId: recipe.id, imageId: 'first', token };
  assert.equal((await send(detail, host)).image.dataUrl, first);
  assert.equal((await send(detail, { ...host, id: 'another-extension' })).success, false);
  assert.equal((await send(detail, { ...host, tab: { id: 8 } })).success, false);
  assert.equal((await send({ ...detail, token: '0'.repeat(32) }, host)).success, false);
  assert.equal((await send({ ...detail, imageId: 'not-selected' }, host)).success, false);

  const report = { action: 'REPORT_RECIPE_TIMING', recipeId: recipe.id, token,
    timing: { relayMs: 10, prepareMs: 20, editorMs: 30, totalMs: 60, imageCount: 2, bytes: 100,
      prompt: 'Do not retain this', site: 'https://private.example/', recipeId: recipe.id } };
  for (const sender of [manager, { ...host, id: 'another-extension' }, { ...host, tab: { id: 8 } }]) {
    assert.equal((await send(report, sender)).success, false, 'timings require the selected host session');
  }
  assert.equal((await send(report, host)).success, true);
  assert.deepEqual(Object.keys(storage.get('lastRecipeTimingV1')).sort(),
    ['timestamp', 'relayMs', 'prepareMs', 'editorMs', 'totalMs', 'imageCount', 'bytes'].sort());
  for (const invalid of [{ totalMs: -1 }, { editorMs: Infinity }, { prepareMs: 600001 },
    { imageCount: 9 }, { bytes: -1 }, { bytes: 100000000 }]) {
    assert.equal((await send({ ...report, timing: { ...report.timing, ...invalid } }, host)).success, false);
  }
  assert.equal(storage.get('lastRecipeTimingV1').totalMs, 60, 'invalid reports preserve the last valid timing');
  const stages = { fileMs: 20, promptMs: 8, focusMs: 2 };
  assert.equal((await send({ ...report, timing: { ...report.timing, ...stages } }, host)).success, true);
  for (const [key, value] of Object.entries(stages)) assert.equal(storage.get('lastRecipeTimingV1')[key], value);
  for (const invalid of [{ fileMs: Infinity }, { promptMs: -1 }, { focusMs: 600001 }]) {
    assert.equal((await send({ ...report, timing: { ...report.timing, ...invalid } }, host)).success, false);
  }
  assert.equal((await send({ ...report, timing: { ...report.timing, promptMethod: 'native', promptFirst: true } }, host)).success, true);
  assert.equal(storage.get('lastRecipeTimingV1').promptMethod, 'native');
  assert.equal(storage.get('lastRecipeTimingV1').promptFirst, true);
  for (const invalid of [{ promptMethod: 'untrusted text' }, { promptFirst: 'yes' }]) {
    assert.equal((await send({ ...report, timing: { ...report.timing, ...invalid } }, host)).success, false);
  }

  await send({ action: 'DELETE_IMAGE', id: 'first' });
  assert.equal(storage.has(key(recipe.id, 'first')), true);
  assert.equal((await send({ action: 'CLEAR_ALL' })).success, true);
  assert.equal((await send({ action: 'GET_IMAGE_LIST' })).images.length, 0);
  assert.equal((await send(detail, host)).image.dataUrl, first, 'recipe references survive deletion and gallery clearing');
  const edited = await save('Reordered', ['first', 'second'], recipe.id);
  assert.equal(edited.success, true, 'editing reuses snapshots after source gallery cleanup');
  assert.deepEqual(Array.from(edited.recipe.images, image => image.id), ['first', 'second']);

  await seed('third');
  await send({ action: 'GET_IMAGE_THUMBNAIL', id: 'third' });
  const before = JSON.stringify(storage.get('savedRecipesV1'));
  failRecipeCommit = true;
  assert.equal((await save('Failed edit', ['first', 'third'], recipe.id)).success, false);
  failRecipeCommit = false;
  assert.equal(JSON.stringify(storage.get('savedRecipesV1')), before);
  assert.equal(storage.has(key(recipe.id, 'third')), false, 'failed metadata commit rolls back new snapshots');
  assert.equal(storage.has(thumbKey(recipe.id, 'third')), false, 'failed metadata commit rolls back new previews');
  assert.equal(storage.has(key(recipe.id, 'second')), true, 'failed edits preserve previous snapshots');
  assert.equal((await save('Missing image', ['third', 'missing'])).success, false);
  assert.equal([...storage.keys()].filter(name => name.startsWith('recipeImageV1:')).length, 2);

  const withoutImages = await save('Now prompt only', [], recipe.id);
  assert.equal(withoutImages.success, true);
  assert.equal(withoutImages.recipe.images.length, 0);
  assert.equal(storage.has(key(recipe.id, 'first')), false);
  assert.equal(storage.has(key(recipe.id, 'second')), false);
  assert.equal(storage.has(thumbKey(recipe.id, 'first')), false);
  for (const draft of [
    { name: '', prompt: 'text', imageIds: [] }, { name: 'Name', prompt: ' ', imageIds: [] },
    { name: 'Name', prompt: 'a'.repeat(16001), imageIds: [] },
    { name: 'Name', prompt: 'text', imageIds: Array(9).fill('third') },
    { name: 'Name', prompt: 'text', imageIds: ['third', 'third'] }
  ]) assert.equal((await send({ action: 'SAVE_RECIPE', recipe: draft })).success, false);
  for (let index = 0; index < 38; index++) assert.equal((await save(`Prompt ${index}`)).success, true);
  assert.equal((await save('Over limit')).success, false);
  assert.equal((await send({ action: 'GET_RECIPES' })).recipes.length, 40);
  await send({ action: 'DELETE_RECIPE', recipeId: recipe.id });
  assert.equal((await send({ action: 'GET_IMAGE_LIST' })).images[0].id, 'third', 'recipe deletion preserves gallery originals');
  await send({ action: 'UNREGISTER_PICKER_SESSION', token }, host);
  assert.equal((await send(report, host)).success, false, 'closed sessions cannot overwrite timing');
  assert.equal((await send({ ...detail, recipeId: plain.recipe.id }, host)).success, false);
  console.log('Recipe storage: snapshots, rollback, limits, session access, lightweight previews and 1.2.0 upgrade passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
