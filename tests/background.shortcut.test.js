const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifestPath = path.join(__dirname, '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.ok(manifest.commands, 'Manifest must define commands object');
assert.ok(manifest.commands.OPEN_PICKER, 'Manifest must define OPEN_PICKER command');
assert.equal(manifest.commands.OPEN_PICKER.suggested_key.default, 'Ctrl+Shift+V');
assert.equal(manifest.commands.OPEN_PICKER.suggested_key.mac, 'Command+Shift+V');

console.log('Background shortcut manifest command regression: OK');
