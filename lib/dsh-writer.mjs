/**
 * DSH session-store writer: encodes a session as the same on-disk artifact the
 * JSONL persistence backend produces, so `dsh` can list and resume it.
 *
 * The artifact layout mirrors dsh-session-persistence-jsonl/src/format.ts and
 * zstd.ts exactly:
 *   <root>/<projectKey(cwd)>/session-<encodeSegment(id)>/session.jsonl.zstd
 * The zstd file is a concatenation of independent checksummed Zstandard
 * frames: one frame with only the header line, then one frame per append
 * batch (the import writes one batch with every event).
 */

import { constants, zstdCompressSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Encode an arbitrary string as one safe path segment (format.ts encodeSegment). */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/** Build the readable directory key for a project path (format.ts projectKey). */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** One zstd-compressed frame with the backend's checksum flag. */
function zstdFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/**
 * Write one session artifact.
 * @param root - the session store root (e.g. ~/.dsh/sessions).
 * @param header - { id, createdAt, cwd } (id must be a stable import id).
 * @param events - the complete event list (balanced, contiguous seq from 0).
 * @returns the absolute artifact path written.
 */
export function writeSession(root, header, events) {
  const headerLine = {
    type: 'session',
    version: 0,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    delegationDepth: 0,
  }
  const lines = [JSON.stringify(headerLine)]
  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq]
    lines.push(JSON.stringify({ type: event.type, seq, time: event.time, data: event.data, ...(event.surfaceOp ? { surfaceOp: event.surfaceOp } : {}) }))
  }
  const dir = join(root, header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd), encodeSegment(header.id))
  const path = join(dir, 'session.jsonl.zstd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, Buffer.concat([
    zstdFrame(`${lines[0]}\n`),
    zstdFrame(`${lines.slice(1).join('\n')}\n`),
  ]))
  return path
}

/** Whether a session id already has an artifact anywhere under the store root. */
export function findExistingSession(root, id) {
  const needle = encodeSegment(id)
  let projectDirs
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue
    const sessionDir = join(root, entry.name, needle)
    if (existsSync(sessionDir)) return sessionDir
  }
  return false
}
