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
