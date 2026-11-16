import test from 'node:test';
import assert from 'node:assert/strict';
import { clampCaptureRect, exportFilename, sanitizeSaveFolder } from '../dist/rect.js';

test('crops CSS pixel rect into screenshot pixel dimensions', () => {
  assert.deepEqual(
    clampCaptureRect({ x: 10, y: 20, width: 100, height: 60 }, { width: 600, height: 400 }, { width: 1200, height: 800 }),
    { x: 20, y: 40, width: 200, height: 120 },
  );
});

test('clamps region to the capture viewport', () => {
  assert.deepEqual(
    clampCaptureRect({ x: -15, y: 95, width: 35, height: 30 }, { width: 100, height: 100 }, { width: 100, height: 100 }),
    { x: 0, y: 95, width: 20, height: 5 },
  );
});

test('rejects invalid and out-of-bounds rects', () => {
  assert.equal(clampCaptureRect({ x: 100, y: 100, width: 5, height: 5 }, { width: 100, height: 100 }, { width: 100, height: 100 }), null);
  assert.equal(clampCaptureRect({ x: 0, y: 0, width: Number.NaN, height: 1 }, { width: 100, height: 100 }, { width: 100, height: 100 }), null);
});

test('export filename sanitizes names and stays under capture-relay/', () => {
  assert.equal(exportFilename('../../secret', 0, 'png'), 'capture-relay/1970-01-01T00-00-00-000Z_------secret.png');
});

test('sanitizeSaveFolder normalizes custom folders and strips traversal', () => {
  assert.equal(sanitizeSaveFolder('projects/demo'), 'projects/demo');
  assert.equal(sanitizeSaveFolder('/../foo\\bar/../'), 'foo/bar');
  assert.equal(sanitizeSaveFolder('   '), 'capture-relay');
  assert.equal(exportFilename('clip', 0, 'webm', 'my-shots'), 'my-shots/1970-01-01T00-00-00-000Z_clip.webm');
});
