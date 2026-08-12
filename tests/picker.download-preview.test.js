const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePickerThumbnailResponse } = require('../picker.js');

const thumbnail = 'data:image/webp;base64,VEhVTUI=';

assert.equal(normalizePickerThumbnailResponse({
  success: true,
  downloadId: 12,
  thumbnailDataUrl: thumbnail
}, 'download', 12, 512 * 1024), thumbnail);

assert.equal(normalizePickerThumbnailResponse({
  success: true,
  downloadId: 99,
  thumbnailDataUrl: thumbnail
}, 'download', 12, 512 * 1024), '', 'a preview cannot populate the wrong download tile');

assert.equal(normalizePickerThumbnailResponse({
  success: true,
  downloadId: 12,
  thumbnailDataUrl: 'data:text/html;base64,PHNjcmlwdD4='
}, 'download', 12, 512 * 1024), '', 'only image previews are accepted');

assert.equal(normalizePickerThumbnailResponse({
  success: true,
  downloadId: 12,
  thumbnailDataUrl: `data:image/webp;base64,${'A'.repeat(512 * 1024)}`
}, 'download', 12, 512 * 1024), '', 'oversized runtime responses are rejected by the picker too');

const pickerSource = fs.readFileSync(path.join(__dirname, '..', 'picker.js'), 'utf8');
assert.match(pickerSource, /download\.previewable/);
assert.match(pickerSource, /action: 'GET_DOWNLOAD_THUMBNAIL'/);
assert.match(pickerSource, /preview\.dataset\.previewKind = 'download'/);
assert.match(pickerSource, /download\.previewKind === 'video'/,
  'video downloads must keep a visible media affordance after their thumbnail loads');
assert.match(pickerSource, /badge\.textContent = 'Video'/);
assert.match(pickerSource, /preview\.dataset\.previewKey = `clipboard:\$\{image\.id\}`/,
  'clipboard previews must retain a stable key after the shared preview queue is generalized');
assert.match(pickerSource, /preview\.replaceWith\(createDownloadIcon/,
  'a failed image preview must fall back to the existing file-type icon');

console.log('picker download preview regression: OK');
