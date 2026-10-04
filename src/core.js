/**
 * Paginated byte-range reader for seek-style access to large files.
 *
 * Design decisions:
 * - Read strategy is PRELOAD: every requested range is fully buffered into a
 *   Buffer before the Result is returned. This keeps the API trivial to reason
 *   about (no back-pressure, no stream lifetime to manage) at the cost of peak
 *   memory equal to the largest requested range. The whole point of this
 *   library is to read SLICES of a large file, so that trade is acceptable.
 * - We open the file for every call rather than holding a long-lived handle.
 *   Long-lived handles leak in long-running processes if a reader is abandoned;
 *   short-lived handles are closed by fs/promises before the promise resolves.
 * - The chunkSize only governs the read loop's internal Buffer allocation. With
 *   PRELOAD the caller's memory is set by the range size, so chunkSize is a
 *   tuning knob, not a correctness boundary. It defaults to 64 KiB which is a
 *   reasonable balance between syscall count and per-call overhead.
 */

import { open } from 'node:fs/promises';

/**
 * Read arbitrary byte ranges from a large file by offset and length.
 */
export class PaginatedStreamReader {
  #filePath;
  #chunkSize;

  /**
   * @param {object} opts
   * @param {string} opts.path      Absolute or relative file path to read.
   * @param {number} [opts.chunkSize] Internal read-loop allocation size, in bytes.
   *        Purely a tuning knob; correctness does not depend on it. Default 64KiB.
   */
  constructor({ path, chunkSize = 64 * 1024 }) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('opts.path must be a non-empty string');
    }
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new TypeError('opts.chunkSize must be a positive integer');
    }
    this.#filePath = path;
    this.#chunkSize = chunkSize;
  }

  /**
   * Read `length` bytes starting at byte `offset`.
   *
   * Edge cases handled here, and ONLY here:
   *  - length 0 -> empty Buffer, no stat, no read (fast no-op).
   *  - offset beyond EOF -> empty Buffer (treated as "range past end").
   *  - range partially past EOF -> truncated Buffer of the bytes available.
   *  - negative offset or length -> throws RangeError. Negative seeking is
   *    nonsensical and we refuse to silently coerce it.
   *
   * @param {number} offset  Byte offset to start reading at. Must be >= 0.
   * @param {number} length  Number of bytes to read. Must be >= 0.
   * @returns {Promise<Buffer>}
   */
  async readRange(offset, length) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError('offset must be a non-negative integer');
    }
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError('length must be a non-negative integer');
    }

    // Fast path: zero-length read is a no-op that must not touch the disk.
    // Doing a stat() here would make empty reads observably slower and could
    // surface ENOENT for what is logically a trivial request.
    if (length === 0) return Buffer.alloc(0);

    let handle;
    try {
      handle = await open(this.#filePath, 'r');

      const stat = await handle.stat();
      const size = stat.size;

      // If the start of the range is at or beyond EOF, there is nothing to
      // return. We treat this as "empty result" rather than an error so that
      // callers iterating over a file in fixed chunks can stop cleanly when
      // their next offset overshoots.
      if (offset >= size) return Buffer.alloc(0);

      const available = size - offset;
      const toRead = Math.min(length, available);

      return await this.#readAt(handle, offset, toRead);
    } finally {
      // Always release the handle, even if an intermediate step threw.
      // Forgetting this on the error path leaks fds in long-running callers.
      if (handle !== undefined) {
        await handle.close().catch(() => {
          // Swallow close errors: we cannot recover from a failed close, and
          // surfacing it would mask the original cause from readAt/stat above.
        });
      }
    }
  }

  /**
   * Read exactly `length` bytes from `handle` at `offset`.
   *
   * We never expose the partial-read case to the caller: if the underlying
   * read returns fewer bytes than requested we loop until the buffer is full
   * or the file is exhausted. This is the "no short reads" guarantee that
   * lets callers skip bounds-checking on every chunk.
   *
   * @param {import('node:fs/promises').FileHandle} handle
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Buffer>}
   */
  async #readAt(handle, offset, length) {
    const out = Buffer.alloc(length);
    let filled = 0;

    while (filled < length) {
      const want = Math.min(this.#chunkSize, length - filled);
      // Buffer.slice returns a view sharing memory with `out`, so handle.read
      // writes directly into the final buffer with no extra copy.
      const { bytesRead } = await handle.read(
        out.slice(filled, filled + want),
        0,
        want,
        offset + filled
      );

      if (bytesRead === 0) {
        // Genuine short read at EOF despite the stat above. Truncate to what
        // we actually got. This only happens if the file is truncated between
        // stat() and read(), which is rare but not impossible.
        return out.slice(0, filled);
      }
      filled += bytesRead;
    }

    return out;
  }
}
