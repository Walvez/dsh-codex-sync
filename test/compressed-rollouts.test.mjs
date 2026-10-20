import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compressChecksummedFrame, decompressFrames } from '../lib/zstd-frame.mjs'
import { listCodexSessions, parseCodexSession } from '../lib/codex-reader.mjs'
import { importCodex, listImportCatalog } from '../lib/import-service.js'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'codex-compressed-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dir = join(home, 'sessions', '2026', '10', '20')
  mkdirSync(dir, { recursive: true })
  return { home, dir }
}
function body(id, text = 'Hello', extra = {}) {
  return Buffer.from([
    { type: 'session_meta', payload: { id, cwd: '/tmp/project', timestamp: '2026-10-20T00:00:00Z', ...extra } },
    { type: 'response_item', timestamp: '2026-10-20T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { type: 'response_item', timestamp: '2026-10-20T00:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n')
}
function destination() {
  const stored = new Map()
  return { stored, persistence: {
    async list() { return [...stored.values()].map(x => x.meta) },
    async create(meta) { stored.set(meta.id, { meta, events: [] }) },
    async append(id, events) { stored.get(id).events.push(...events) },
    async inspect(id) { return stored.get(id) },
  } }
}
const ctx = { get: () => undefined }

test('plain and concatenated Zstandard rollout frames parse identically', t => {
  const { dir } = fixture(t)
  const bytes = body('main', '你好 🌏')
  const plain = join(dir, 'rollout-main.jsonl')
  const compressed = plain + '.zst'
  writeFileSync(plain, bytes)
  const split = bytes.indexOf(10) + 1
  writeFileSync(compressed, Buffer.concat([
    compressChecksummedFrame(bytes.subarray(0, split)),
    compressChecksummedFrame(bytes.subarray(split)),
  ]))
  writeFileSync(join(dir, 'rollout-ignored.jsonl.zst.bak'), bytes)
  writeFileSync(join(dir, 'unrelated.jsonl.zst'), bytes)
  assert.deepEqual(parseCodexSession(compressed), parseCodexSession(plain))
  assert.deepEqual(listCodexSessions(dir), [plain])
  rmSync(plain)
  assert.deepEqual(listCodexSessions(dir), [compressed])
})

test('decoded limit covers the sum of frames and later-frame checksums are verified', () => {
  const first = compressChecksummedFrame(Buffer.from('a'.repeat(1024)))
  const second = compressChecksummedFrame(Buffer.from('b'.repeat(1024)))
  const frames = Buffer.concat([first, second])
  assert.equal(decompressFrames(frames, 2048).length, 2048)
  assert.throws(() => decompressFrames(frames, 1500), error =>
    error.code === 'ERR_BUFFER_TOO_LARGE' || error.code === 'ENOBUFS')
  second[second.length - 1] ^= 1
  assert.throws(() => decompressFrames(Buffer.concat([first, second]), 2048))
})

test('catalog and import include compressed history; dual copies do not duplicate messages', async t => {
  const { home, dir } = fixture(t)
  const bytes = body('main')
  writeFileSync(join(dir, 'rollout-main.jsonl'), bytes)
  writeFileSync(join(dir, 'rollout-main.jsonl.zst'), compressChecksummedFrame(bytes))
  writeFileSync(join(dir, 'rollout-other.jsonl.zst'), compressChecksummedFrame(body('other')))
  writeFileSync(join(dir, 'rollout-sub.jsonl.zst'), compressChecksummedFrame(body('sub', 'Child', { parent_thread_id: 'main' })))
  const { persistence, stored } = destination()
  const catalog = await listImportCatalog(persistence, {}, home)
  assert.equal(catalog.projects[0].sessions.length, 2)
  const first = await importCodex(ctx, persistence, {}, home)
  assert.equal(stored.size, 2)
  assert.match(first.join('\n'), /subagent-skipped 1/)
  assert.equal(stored.get('codex-main').events.filter(x => x.type === 'user/message').length, 1)
  const second = await importCodex(ctx, persistence, {}, home)
  assert.match(second.join('\n'), /imported 0, updated 0, skipped 2/)
})

test('compressed continuation segments remain separate and merge in chronological order', async t => {
  const { home, dir } = fixture(t)
  writeFileSync(join(dir, 'rollout-01.jsonl.zst'), compressChecksummedFrame(body('main', 'First')))
  writeFileSync(join(dir, 'rollout-02.jsonl.zst'), compressChecksummedFrame(body('main', 'Second')))
  assert.equal(listCodexSessions(dir).length, 2)
  const { persistence, stored } = destination()
  await importCodex(ctx, persistence, {}, home)
  assert.equal(stored.size, 1)
  const users = stored.get('codex-main').events.filter(x => x.type === 'user/message')
  assert.equal(users.length, 2)
  assert.match(JSON.stringify(users[0]), /First/)
  assert.match(JSON.stringify(users[1]), /Second/)
})

test('decoded size limit counts as oversized while corrupt frames count as unreadable', async t => {
  const { home, dir } = fixture(t)
  const large = join(dir, 'rollout-large.jsonl.zst')
  writeFileSync(large, compressChecksummedFrame(body('large', 'x'.repeat(32000))))
  const corrupt = compressChecksummedFrame(body('bad'))
  corrupt[corrupt.length - 1] ^= 1
  writeFileSync(join(dir, 'rollout-bad.jsonl.zst'), corrupt)
  writeFileSync(join(dir, 'rollout-good.jsonl.zst'), compressChecksummedFrame(body('good')))
  assert.throws(() => parseCodexSession(large, { maxSessionBytes: 1024 }), { code: 'CODEX_SESSION_TOO_LARGE' })
  const { persistence, stored } = destination()
  const catalog = await listImportCatalog(persistence, { maxSessionBytes: 1024 }, home)
  assert.equal(catalog.skippedBig, 1)
  assert.equal(catalog.unreadable, 1)
  assert.equal(catalog.projects[0].sessions.length, 1)
  const lines = await importCodex(ctx, persistence, { maxSessionBytes: 1024 }, home)
  assert.match(lines.join('\n'), /oversized-skipped 1, unreadable 1/)
  assert.deepEqual([...stored.keys()], ['codex-good'])
})
