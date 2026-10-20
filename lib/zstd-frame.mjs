/** Native Zstandard on Node 22.15+, or the existing zstd CLI on Node 20. */
import * as zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

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

/** Bound decoded bytes before a highly compressible rollout becomes a string. */
export function decompressFrames(input, maxOutputLength) {
  if (typeof zlib.zstdDecompressSync === 'function') {
    // The synchronous Node decoder stops after one frame. Codex rollouts can
    // contain multiple frames; account for their combined decoded size.
    const chunks = []
    let offset = 0
    let length = 0
    do {
      const { buffer, engine } = zlib.zstdDecompressSync(input.subarray(offset), {
        info: true,
        maxOutputLength: Math.max(1, maxOutputLength - length),
      })
      if (engine.bytesWritten <= 0) throw new Error('Zstandard decoder made no progress')
      length += buffer.length
      if (length > maxOutputLength) {
        throw Object.assign(new RangeError('Decoded Zstandard data exceeds size limit'), {
          code: 'ERR_BUFFER_TOO_LARGE',
        })
      }
      chunks.push(buffer)
      offset += engine.bytesWritten
    } while (offset < input.length)
    return Buffer.concat(chunks, length)
  }
  return execFileSync('zstd', ['--quiet', '--decompress', '--stdout'], {
    input,
    maxBuffer: maxOutputLength,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
