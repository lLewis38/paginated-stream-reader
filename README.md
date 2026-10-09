# Paginated Stream Reader

Reads arbitrary byte ranges from large files using seek-style `offset` and `length` parameters. The module exports a single class, `PaginatedStreamReader`, from `src/index.js`.

## Usage

```js
import { writeFileSync } from 'node:fs';
import { PaginatedStreamReader } from 'paginated-stream-reader';

// Create a small file with known bytes.
writeFileSync('/tmp/big.log', Buffer.from(Array.from({ length: 256 }, (_, i) => i)));

const reader = new PaginatedStreamReader({ path: '/tmp/big.log' });

// Read 5 bytes starting at offset 10.
const chunk = await reader.readRange(10, 5);
console.log(chunk.length, chunk[0]); // 5 10

// Iterate over a file in fixed slices without loading the whole thing.
let offset = 0;
const PAGE = 64;
for (;;) {
  const page = await reader.readRange(offset, PAGE);
  if (page.length === 0) break;
  // ...do something with page...
  offset += page.length;
}
```

`readRange(offset, length)` returns a `Promise<Buffer>`. `offset` and `length` must be non-negative integers; anything else throws a `RangeError`.

## Why this exists

The Node standard library gives you either whole-file reads (`fs.readFile`) or raw streaming (`fs.createReadStream`). The former forces the entire file into memory; the latter hands you a stream you must pause, resume, and buffer yourself if you want a specific slice by offset.

This library is the boring middle: give it an offset and a length, get back a `Buffer` with exactly those bytes (or fewer, if the range overshoots EOF). One object, one method, one promise.

The trade-off is memory: every call fully materialises the requested range before resolving. If you request a 2 GiB range you will hold a 2 GiB buffer. That is deliberate — the point of this library is to read *slices*, not whole files. If you need streaming back-pressure, use `fs.createReadStream({ start, end })` directly.

The file is opened and closed on every `readRange` call rather than holding a long-lived handle. That is one extra `open` per call, but it eliminates the fd-leak class of bugs where a reader is abandoned in a long-running process.

## Edge cases you will hit

- `offset` at or beyond EOF returns an empty `Buffer`, not an error. This lets the iterate-by-page loop above terminate cleanly when its offset overshoots.
- A range that *partially* overshoots EOF returns the bytes that are available, truncated. Asking for 20 bytes at offset 250 of a 256-byte file yields a 6-byte buffer.
- `length === 0` is a true no-op: it returns an empty buffer without touching the disk, so you can call it on a path that does not exist yet without getting an error. Use a non-zero length if you want the missing-file error to surface.
- The file is reopened on every call. If you read 10 000 tiny ranges in a tight loop, you pay 10 000 `open` syscalls. For that workload, hold your own handle and use `fs/promises` `FileHandle.read` directly; this library is optimised for clarity, not for microbenchmarks.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

