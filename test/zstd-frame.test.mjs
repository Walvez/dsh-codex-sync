import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compressChecksummedFrame, decompressFrames } from '../lib/zstd-frame.mjs'

test('checksummed Zstandard frames round-trip independently and when concatenated', () => {
  const first = Buffer.from('{"type":"session","version":4}\n')
  const second = Buffer.from('{"type":"turn/start","seq":0}\n')
  const frames = [compressChecksummedFrame(first), compressChecksummedFrame(second)]
  assert.deepEqual(decompressFrames(frames[0]), first)
  // DSH's session store appends one frame per batch, so concatenation must
  // decode as the whole stream — a plain zstd decode stops after frame one.
  assert.deepEqual(decompressFrames(Buffer.concat(frames)), Buffer.concat([first, second]))
  const corrupt = Buffer.from(frames[1])
  corrupt[corrupt.length - 1] ^= 1
  assert.throws(() => decompressFrames(corrupt), 'a corrupted checksum must fail')
})
