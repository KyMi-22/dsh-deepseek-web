/**
 * Upload robustness: parse-failure typing and the one automatic retry.
 *
 *   node test/upload.test.mjs
 */

import assert from 'node:assert';
import { DeepSeekWebApi, DeepSeekWebError } from '../src/api.js';

// ── waitForFile: FAILED becomes a typed, retryable-by-re-upload error ──────
{
  const api = new DeepSeekWebApi({ token: 't' });
  api.fetchFileStatus = async () => ({ id: 'f1', status: 'FAILED', auditResult: '', tokenUsage: null });
  await assert.rejects(
    () => api.waitForFile('f1'),
    (error) => {
      assert.equal(error instanceof DeepSeekWebError, true);
      assert.equal(error.code, 'PARSE_FAILED');
      assert.equal(error.submitted, false, 'nothing was submitted');
      assert.ok(error.message.includes('FAILED'), 'the status is named');
      assert.ok(error.message.includes('audit unknown'), 'a missing audit result is spelled out');
      return true;
    },
  );
}

{
  // SUCCESS resolves; PASS/PENDING then SUCCESS still resolves.
  const api = new DeepSeekWebApi({ token: 't' });
  const statuses = ['PENDING', 'PARSING', 'SUCCESS'];
  api.fetchFileStatus = async () => ({ id: 'f2', status: statuses.shift(), auditResult: '', tokenUsage: null });
  await api.waitForFile('f2');
}

// ── uploadFile: one automatic retry on a failed parse ─────────────────────
{
  const api = new DeepSeekWebApi({ token: 't' });
  let attempts = 0;
  api.uploadOnce = async () => {
    attempts += 1;
    if (attempts === 1) throw new DeepSeekWebError('parse failed', 'PARSE_FAILED', { submitted: false });
    return 'file-retry-ok';
  };
  const id = await api.uploadFile({ bytes: new Uint8Array([1, 2]), mediaType: 'image/png', fileName: 'shot.png' });
  assert.equal(id, 'file-retry-ok', 'the retried upload wins');
  assert.equal(attempts, 2, 'exactly one retry');
}

{
  // A retry that also fails reports the file's identity plus the failing status.
  const api = new DeepSeekWebApi({ token: 't' });
  let attempts = 0;
  api.uploadOnce = async () => {
    attempts += 1;
    throw new DeepSeekWebError('file parse did not succeed (status FAILED, audit unknown)', 'PARSE_FAILED');
  };
  await assert.rejects(
    () => api.uploadFile({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', fileName: 'a.webp' }),
    (error) => {
      assert.equal(error.code, 'PARSE_FAILED');
      assert.equal(error.submitted, false);
      assert.ok(error.message.includes('after a retry'), 'the retry is visible in the message');
      assert.ok(error.message.includes('a.webp'), 'the filename is named');
      assert.ok(error.message.includes('image/webp'), 'the media type is named');
      assert.ok(error.message.includes('3 bytes'), 'the size is named');
      assert.ok(error.message.includes('audit unknown'), 'the original status is kept');
      return true;
    },
  );
  assert.equal(attempts, 2, 'both attempts ran');
}

{
  // Any other failure is NOT retried: a rejected upload must surface at once.
  const api = new DeepSeekWebApi({ token: 't' });
  let attempts = 0;
  api.uploadOnce = async () => {
    attempts += 1;
    throw new DeepSeekWebError('file upload rejected (bad token)', 'BIZ');
  };
  await assert.rejects(
    () => api.uploadFile({ bytes: new Uint8Array([1]), mediaType: 'image/png', fileName: 'x.png' }),
    (error) => error.code === 'BIZ',
  );
  assert.equal(attempts, 1, 'no retry for a rejection');
}

console.log('upload.test.mjs: all assertions passed');
