const assert = require('node:assert/strict');
const {
  isExpectedPickerMessageEvent,
  normalizePickerCommand,
  routePickerCommand,
  isTrustedPickerEscape,
  isTrustedPickerBackdrop
} = require('../content.js');

const pickerWindow = {};
const session = {
  contentWindow: pickerWindow,
  origin: 'chrome-extension://4b796e3c-1a40-42af-a823-c0fa3ce59dc8',
  extensionOrigin: 'chrome-extension://installed-static-id',
  token: '0123456789abcdef0123456789abcdef',
  parentOrigin: 'https://example.test'
};

function closeEvent(overrides = {}) {
  return {
    source: pickerWindow,
    origin: session.origin,
    data: {
      type: 'CIP_CLOSE',
      token: session.token,
      commandId: 'abcdef0123456789abcdef0123456789',
      parentOrigin: session.parentOrigin
    },
    ...overrides
  };
}

// Chromium may intentionally conceal MessageEvent.source for messages sent by
// extension documents. A valid close must still pass the origin + capability
// checks or the on-page picker can never be dismissed with its close button.
assert.equal(isExpectedPickerMessageEvent(closeEvent({ source: null }), session), true);
assert.equal(isExpectedPickerMessageEvent(closeEvent(), session), true);

assert.equal(isExpectedPickerMessageEvent(closeEvent({ source: {} }), session), false);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ origin: 'chrome-extension://installed-static-id' }), session), true);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ origin: 'chrome-extension://another-extension' }), session), false);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ data: { ...closeEvent().data, token: 'wrong' } }), session), false);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ data: { ...closeEvent().data, parentOrigin: 'https://attacker.test' } }), session), false);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ data: { ...closeEvent().data, type: null } }), session), false);

const baseCommand = closeEvent().data;
assert.deepEqual(normalizePickerCommand(baseCommand), baseCommand);
assert.equal(normalizePickerCommand({ ...baseCommand, type: 'CIP_SHOW_ALL' }).type, 'CIP_SHOW_ALL');
assert.equal(normalizePickerCommand({ ...baseCommand, type: 'CIP_PICK_IMAGE', imageId: 'img_safe-1' }).imageId, 'img_safe-1');
assert.equal(normalizePickerCommand({
  ...baseCommand,
  type: 'CIP_PICK_DOWNLOAD',
  downloadId: 42,
  name: '../photo.png'
}).downloadId, 42);
assert.equal(normalizePickerCommand({ ...baseCommand, commandId: 'short' }), null);
assert.equal(normalizePickerCommand({ ...baseCommand, type: 'CIP_PICK_IMAGE', imageId: 'x'.repeat(161) }), null);
assert.equal(normalizePickerCommand({ ...baseCommand, type: 'CIP_PICK_DOWNLOAD', downloadId: -1 }), null);
assert.equal(normalizePickerCommand({ ...baseCommand, type: 'CIP_UNKNOWN' }), null);

const routed = [];
const commandIds = new Set();
let selectionBusy = false;
const handlers = {
  selectionInProgress: () => selectionBusy,
  pickImage: (message) => routed.push(['image', message.imageId]),
  pickDownload: (message) => routed.push(['download', message.downloadId]),
  showAll: () => routed.push(['show-all']),
  close: () => routed.push(['close'])
};
const routeSession = { active: true, token: session.token, parentOrigin: session.parentOrigin };
assert.equal(routePickerCommand(baseCommand, routeSession, commandIds, handlers).success, true);
assert.deepEqual(routed.pop(), ['close']);
assert.equal(routePickerCommand(baseCommand, routeSession, commandIds, handlers).duplicate, true);
assert.equal(routed.length, 0, 'postMessage and runtime relay must execute a command once');

const imageCommand = {
  ...baseCommand,
  commandId: '11111111111111111111111111111111',
  type: 'CIP_PICK_IMAGE',
  imageId: 'img_1'
};
assert.equal(routePickerCommand(imageCommand, routeSession, commandIds, handlers).success, true);
assert.deepEqual(routed.pop(), ['image', 'img_1']);
selectionBusy = true;
const busyDownload = {
  ...baseCommand,
  commandId: '22222222222222222222222222222222',
  type: 'CIP_PICK_DOWNLOAD',
  downloadId: 8
};
assert.equal(routePickerCommand(busyDownload, routeSession, commandIds, handlers).code, 'SELECTION_IN_PROGRESS');
assert.equal(commandIds.has(busyDownload.commandId), false, 'a rejected command remains retryable');
selectionBusy = false;
assert.equal(routePickerCommand(busyDownload, routeSession, commandIds, handlers).success, true);
assert.deepEqual(routed.pop(), ['download', 8]);

const showAllCommand = { ...baseCommand, commandId: '33333333333333333333333333333333', type: 'CIP_SHOW_ALL' };
assert.equal(routePickerCommand(showAllCommand, routeSession, commandIds, handlers).success, true);
assert.deepEqual(routed.pop(), ['show-all']);
assert.equal(routePickerCommand({ ...baseCommand, commandId: '44444444444444444444444444444444' }, {
  ...routeSession,
  active: false
}, commandIds, handlers).success, false);

const backdrop = {};
assert.equal(isTrustedPickerBackdrop({ isTrusted: true, target: backdrop }, backdrop), true);
assert.equal(isTrustedPickerBackdrop({ isTrusted: true, target: {} }, backdrop), false);
assert.equal(isTrustedPickerBackdrop({ isTrusted: false, target: backdrop }, backdrop), false);
assert.equal(isTrustedPickerEscape({ isTrusted: true, key: 'Escape' }), true);
assert.equal(isTrustedPickerEscape({ isTrusted: true, key: 'Enter' }), false);
assert.equal(isTrustedPickerEscape({ isTrusted: false, key: 'Escape' }), false);

console.log('Picker command guard tests passed.');
