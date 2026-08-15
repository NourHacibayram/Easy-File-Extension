const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let listener;
const delivered = [];
const challenges = [];
let activeChallenge = null;
const storage = new Map();
const chrome = {
  runtime: {
    id: 'test-extension',
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } },
    getURL(file) { return `chrome-extension://test-extension/${file}`; },
    async getContexts() { return []; },
    async sendMessage() { return { success: true }; }
  },
  storage: {
    local: {
      async setAccessLevel() {},
      async get(keys) {
        const names = typeof keys === 'string' ? [keys] : Object.keys(keys || {});
        return Object.fromEntries(names.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]));
      },
      async set(values) { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => storage.delete(key)); }
    }
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  offscreen: { async createDocument() {}, async closeDocument() {} },
  downloads: { async search() { return []; } },
  tabs: {
    async query() { return []; },
    async sendMessage(tabId, message) {
      if (message.action === 'PICKER_SESSION_CHALLENGE') {
        challenges.push({ tabId, message });
        return {
          success: !!activeChallenge
            && activeChallenge.tabId === tabId
            && activeChallenge.token === message.token
            && activeChallenge.parentOrigin === message.parentOrigin
        };
      }
      delivered.push({ tabId, message });
      return { success: true };
    }
  }
};

vm.runInContext(source, vm.createContext({
  chrome,
  console,
  crypto: globalThis.crypto,
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
  FileReader: class {}
}), { filename: 'background.js' });

function send(message, sender) {
  return new Promise((resolve) => {
    listener(message, sender, resolve);
  });
}

const token = '0123456789abcdef0123456789abcdef';
const commandId = 'abcdef0123456789abcdef0123456789';
const hostSender = {
  id: 'test-extension',
  url: 'https://example.test/upload',
  tab: { id: 17, url: 'https://example.test/upload' }
};
const pickerSender = {
  id: 'test-extension',
  url: `chrome-extension://dynamic-host/picker.html?token=${token}`,
  origin: 'chrome-extension://dynamic-host',
  tab: { id: 17, url: 'https://example.test/upload' }
};

(async () => {
  assert.equal((await send({ action: 'REGISTER_PICKER_SESSION', token }, hostSender)).success, true);

  const close = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_CLOSE', token, commandId,
    parentOrigin: 'https://example.test'
  }, pickerSender);
  assert.equal(close.success, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].tabId, 17);
  assert.equal(delivered[0].message.type, 'CIP_CLOSE');

  const duplicate = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_CLOSE', token, commandId,
    parentOrigin: 'https://example.test'
  }, pickerSender);
  assert.equal(duplicate.duplicate, true);
  assert.equal(delivered.length, 1, 'a postMessage/relay race must not execute twice');

  const image = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_PICK_IMAGE', token,
    commandId: '11111111111111111111111111111111', imageId: 'img_123',
    parentOrigin: 'https://example.test'
  }, pickerSender);
  assert.equal(image.success, true);
  assert.equal(delivered.at(-1).message.imageId, 'img_123');

  const download = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_PICK_DOWNLOAD', token,
    commandId: '22222222222222222222222222222222', downloadId: 8, name: 'photo.png',
    parentOrigin: 'https://example.test'
  }, pickerSender);
  assert.equal(download.success, true);
  assert.equal(delivered.at(-1).message.downloadId, 8);

  const batch = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_PICK_BATCH', token,
    commandId: '23232323232323232323232323232323',
    items: [{ kind: 'image', id: 'img_123' }, { kind: 'download', id: 8, name: 'photo.png' }],
    parentOrigin: 'https://example.test'
  }, pickerSender);
  assert.equal(batch.success, true);
  assert.equal(delivered.at(-1).message.type, 'CIP_PICK_BATCH');
  assert.equal(delivered.at(-1).message.items.length, 2);

  const showAll = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_SHOW_ALL', token,
    commandId: '33333333333333333333333333333333', parentOrigin: 'https://example.test'
  }, pickerSender);
  assert.equal(showAll.success, true);
  assert.equal(delivered.at(-1).message.type, 'CIP_SHOW_ALL');

  const attacker = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_CLOSE', token,
    commandId: '44444444444444444444444444444444', parentOrigin: 'https://example.test'
  }, { ...pickerSender, id: 'attacker-extension' });
  assert.equal(attacker.success, false);

  const wrongOrigin = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_CLOSE', token,
    commandId: '55555555555555555555555555555555', parentOrigin: 'https://attacker.test'
  }, pickerSender);
  assert.equal(wrongOrigin.success, false);

  // An MV3 service worker restart erases the in-memory session map. A picker
  // command must recover by challenging the live, tab-bound content script;
  // this also covers a click racing ahead of REGISTER_PICKER_SESSION.
  const restartToken = 'fedcba9876543210fedcba9876543210';
  const restartSender = {
    ...pickerSender,
    url: `chrome-extension://another-dynamic-host/picker.html?token=${restartToken}`
  };
  activeChallenge = {
    tabId: 17,
    token: restartToken,
    parentOrigin: 'https://example.test'
  };
  const deliveredBeforeRestart = delivered.length;
  const recovered = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_PICK_IMAGE', token: restartToken,
    commandId: '66666666666666666666666666666666', imageId: 'img_after_restart',
    parentOrigin: 'https://example.test'
  }, restartSender);
  assert.equal(recovered.success, true);
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0].tabId, 17);
  assert.equal(challenges[0].message.token, restartToken);
  assert.equal(delivered.length, deliveredBeforeRestart + 1);
  assert.equal(delivered.at(-1).message.imageId, 'img_after_restart');

  // The reconstructed session is reused without another challenge.
  const recoveredAgain = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_PICK_DOWNLOAD', token: restartToken,
    commandId: '77777777777777777777777777777777', downloadId: 19, name: 'restart.png',
    parentOrigin: 'https://example.test'
  }, restartSender);
  assert.equal(recoveredAgain.success, true);
  assert.equal(challenges.length, 1);
  assert.equal(delivered.at(-1).message.downloadId, 19);

  // Possessing a valid-looking token is insufficient when no active content
  // script confirms the exact token and parent origin.
  const rejectedToken = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const rejected = await send({
    action: 'RELAY_PICKER_COMMAND', type: 'CIP_CLOSE', token: rejectedToken,
    commandId: '88888888888888888888888888888888', parentOrigin: 'https://example.test'
  }, { ...restartSender, url: `chrome-extension://dynamic-host/picker.html?token=${rejectedToken}` });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'INVALID_PICKER_SESSION');
  assert.equal(challenges.length, 2);

  console.log('Picker runtime relay regression: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
