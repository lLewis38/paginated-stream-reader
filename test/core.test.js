import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { PaginatedStreamReader } from '../src/index.js';

const TMP = join(os.tmpdir(), `paginated-stream-reader-${process.pid}`);

function setupFixtures() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const fixturePath = join(TMP, 'data.bin');

  // 256 bytes where byte i has value i % 256. Makes offset assertions
  // self-explanatory: readRange(10, 4) yields [10, 11, 12, 13].
  const content = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 256));
  writeFileSync(fixturePath, content);

  const emptyPath = join(TMP, 'empty.bin');
  writeFileSync(emptyPath, Buffer.alloc(0));

  return { fixturePath, emptyPath };
}

describe('PaginatedStreamReader', () => {
  let fixtures;

  it('constructs with a path', () => {
    const r = new PaginatedStreamReader({ path: '/tmp/whatever' });
    assert.equal(typeof r.readRange, 'function');
  });

  it('rejects an empty path', () => {
    assert.throws(
      () => new PaginatedStreamReader({ path: '' }),
      /opts\.path must be a non-empty string/
    );
  });

  it('rejects a non-string path', () => {
    assert.throws(
      () => new PaginatedStreamReader({ path: 42 }),
      /opts\.path must be a non-empty string/
    );
  });

  it('rejects a non-positive chunkSize', () => {
    assert.throws(
      () => new PaginatedStreamReader({ path: '/tmp/x', chunkSize: 0 }),
      /opts\.chunkSize must be a positive integer/
    );
    assert.throws(
      () => new PaginatedStreamReader({ path: '/tmp/x', chunkSize: -1 }),
      /opts\.chunkSize must be a positive integer/
    );
  });

  it('reads a happy-path range', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const buf = await reader.readRange(10, 5);
    assert.equal(buf.length, 5);
    assert.deepEqual(Array.from(buf), [10, 11, 12, 13, 14]);
  });

  it('reads from offset 0', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const buf = await reader.readRange(0, 4);
    assert.deepEqual(Array.from(buf), [0, 1, 2, 3]);
  });

  it('reads the entire file', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const buf = await reader.readRange(0, 256);
    assert.equal(buf.length, 256);
    assert.equal(buf[0], 0);
    assert.equal(buf[255], 255);
  });

  it('honours chunkSize without affecting output (full read)', async () => {
    fixtures = setupFixtures();
    // chunkSize=1 forces the read loop through 256 iterations.
    const reader = new PaginatedStreamReader({
      path: fixtures.fixturePath,
      chunkSize: 1,
    });
    const buf = await reader.readRange(0, 256);
    assert.equal(buf.length, 256);
    assert.deepEqual(Array.from(buf.slice(0, 4)), [0, 1, 2, 3]);
  });

  it('honours chunkSize without affecting output (partial read)', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({
      path: fixtures.fixturePath,
      chunkSize: 3,
    });
    // 10 bytes / chunkSize 3 -> 4 read calls (3,3,3,1). Verifies the loop.
    const buf = await reader.readRange(0, 10);
    assert.deepEqual(Array.from(buf), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns an empty buffer for zero length', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const buf = await reader.readRange(10, 0);
    assert.equal(buf.length, 0);
  });

  it('returns an empty buffer when offset is exactly at EOF', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const buf = await reader.readRange(256, 10);
    assert.equal(buf.length, 0);
  });

  it('returns an empty buffer when offset is beyond EOF', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const buf = await reader.readRange(1000, 10);
    assert.equal(buf.length, 0);
  });

  it('truncates a range that overshoots EOF', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    // 250..256 is 6 bytes; request 20 -> expect 6.
    const buf = await reader.readRange(250, 20);
    assert.equal(buf.length, 6);
    assert.deepEqual(Array.from(buf), [250, 251, 252, 253, 254, 255]);
  });

  it('reads the last single byte', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const buf = await reader.readRange(255, 1);
    assert.deepEqual(Array.from(buf), [255]);
  });

  it('behaves on an empty file: offset 0 length 0', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.emptyPath });
    const buf = await reader.readRange(0, 0);
    assert.equal(buf.length, 0);
  });

  it('behaves on an empty file: offset 0 length 1', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.emptyPath });
    const buf = await reader.readRange(0, 1);
    assert.equal(buf.length, 0);
  });

  it('rejects a negative offset', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    await assert.rejects(() => reader.readRange(-1, 10), RangeError);
  });

  it('rejects a negative length', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    await assert.rejects(() => reader.readRange(0, -1), RangeError);
  });

  it('rejects a non-integer offset', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    await assert.rejects(() => reader.readRange(1.5, 10), RangeError);
  });

  it('rejects a non-integer length', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    await assert.rejects(() => reader.readRange(0, 1.5), RangeError);
  });

  it('throws a filesystem error for a missing file', async () => {
    const reader = new PaginatedStreamReader({ path: join(TMP, 'does-not-exist.bin') });
    await assert.rejects(() => reader.readRange(0, 10), /ENOENT/);
  });

  it('can read multiple sequential ranges from one reader instance', async () => {
    fixtures = setupFixtures();
    const reader = new PaginatedStreamReader({ path: fixtures.fixturePath });
    const a = await reader.readRange(0, 4);
    const b = await reader.readRange(4, 4);
    const c = await reader.readRange(8, 4);
    assert.deepEqual(Array.from(a), [0, 1, 2, 3]);
    assert.deepEqual(Array.from(b), [4, 5, 6, 7]);
    assert.deepEqual(Array.from(c), [8, 9, 10, 11]);
  });
});
