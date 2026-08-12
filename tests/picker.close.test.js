const assert = require('node:assert/strict');
const { isExpectedPickerMessageEvent } = require('../content.js');

const pickerWindow = {};
const session = {
  contentWindow: pickerWindow,
  origin: 'chrome-extension://4b796e3c-1a40-42af-a823-c0fa3ce59dc8',
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
assert.equal(isExpectedPickerMessageEvent(closeEvent({ origin: 'chrome-extension://installed-static-id' }), session), false);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ data: { ...closeEvent().data, token: 'wrong' } }), session), false);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ data: { ...closeEvent().data, parentOrigin: 'https://attacker.test' } }), session), false);
assert.equal(isExpectedPickerMessageEvent(closeEvent({ data: { ...closeEvent().data, type: null } }), session), false);

console.log('Picker close message guard tests passed.');
