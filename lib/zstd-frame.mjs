/** Native Zstandard on Node 22.15+, or the existing zstd CLI on Node 20. */
import * as zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

/** Zstd frame magic (`0xFD2FB528`, little-endian on disk). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function compressChecksummedFrame(input) {
  if (typeof zlib.zstdCompressSync === 'function') {
    return zlib.zstdCompressSync(input, {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    })
  }
  return execFileSync('zstd', ['--quiet', '--compress', '--stdout', '--check'], {
    input,
    maxBuffer: Math.max(1 << 20, input.length * 2),
  })
}

/**
 * Byte offsets of every Zstandard frame start in `input`.
 *
 * Files here are routinely a CONCATENATION of independent frames (DSH's session
 * store writes a header frame plus one frame per append), and node's zstd
 * decoder stops at the end of the first frame instead of stitching them. The
 * offsets let callers decode every frame.
 */
export function frameOffsets(input) {
  const offsets = []
  let at = input.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = input.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
  }
  return offsets
}

/**
 * Decompress a buffer that holds one or more concatenated Zstandard frames.
 * @param {Buffer} input
 * @returns {Buffer}
 */
export function decompressFrames(input) {
  const decode = (chunk) => (typeof zlib.zstdDecompressSync === 'function'
    ? zlib.zstdDecompressSync(chunk)
    : execFileSync('zstd', ['--quiet', '--decompress', '--stdout'], { input: chunk }))

  const offsets = frameOffsets(input)
  if (offsets.length <= 1) return decode(input)
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : input.length
    parts.push(decode(input.subarray(offsets[i], end)))
  }
  return Buffer.concat(parts)
}
