import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { compressChecksummedFrame } from '../lib/zstd-frame.mjs'

test('checksummed Zstandard frames round-trip independently and when concatenated', () => {
  const first = Buffer.from('{"type":"session","version":4}\n')
  const second = Buffer.from('{"type":"turn/start","seq":0}\n')
  const frames = [compressChecksummedFrame(first), compressChecksummedFrame(second)]
  const decode = input => execFileSync('zstd', ['--quiet', '--decompress', '--stdout'], { input })
  assert.deepEqual(decode(frames[0]), first)
  assert.deepEqual(decode(Buffer.concat(frames)), Buffer.concat([first, second]))
  const corrupt = Buffer.from(frames[1])
  corrupt[corrupt.length - 1] ^= 1
  assert.throws(() => decode(corrupt), 'a corrupted checksum must fail')
})
