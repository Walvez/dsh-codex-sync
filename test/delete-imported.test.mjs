/**
 * delete-imported: only `codex-*` Sessions are removable, an open one is
 * refused, and the artifact + projection cache go while the Codex original is
 * untouched. Hermetic — throwaway session store and cache.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteImportedSessions, locateSessionDir } from '../lib/delete-imported.mjs'

function store() {
  const root = mkdtempSync(join(tmpdir(), 'cx-del-store-'))
  const cache = mkdtempSync(join(tmpdir(), 'cx-del-cache-'))
  return { root, cache }
}

/** Lay out `<root>/<project key>/<id>/session.v4.jsonl.zstd` like the backend. */
function placeSession(root, projectKey, id) {
  const dir = join(root, projectKey, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'artifact')
  return dir
}

function stubPersistence(ids) {
  return { async list() { return ids.map((id) => ({ id })) } }
}

function stubCtx({ live = [], unarchived = [] } = {}) {
  return {
    get(name) {
      if (name === 'agents') return { get: (id) => (live.includes(id) ? { id } : undefined) }
      if (name === 'workspaceRegistry') return { async unarchiveSession(id) { unarchived.push(id) } }
      return undefined
    },
  }
}

test('delete: removes the artifact, the cache entry and the archive flag', async () => {
  const { root, cache } = store()
  const id = 'codex-abc'
  const dir = placeSession(root, '--D-proj--', id)
  writeFileSync(join(cache, `${id}.json`), '{}')
  const unarchived = []

  const result = await deleteImportedSessions(stubCtx({ unarchived }), stubPersistence([id]), [id], {
    sessionsRoot: root,
    projectionCache: cache,
  })

  assert.deepEqual(result.deleted, [id])
  assert.equal(existsSync(dir), false, 'session directory removed')
  assert.equal(existsSync(join(cache, `${id}.json`)), false, 'projection cache removed')
  assert.deepEqual(unarchived, [id], 'archive flag cleared before deletion')
  assert.match(result.lines.join('\n'), /\[deleted\] codex-abc/)
})

test('delete: refuses ids this plugin did not import', async () => {
  const { root, cache } = store()
  const dir = placeSession(root, '--D-proj--', 'session-mine')
  const result = await deleteImportedSessions(stubCtx(), stubPersistence(['session-mine']), ['session-mine'], {
    sessionsRoot: root,
    projectionCache: cache,
  })
  assert.deepEqual(result.deleted, [])
  assert.equal(result.refused.length, 1)
  assert.match(result.refused[0][1], /codex-/)
  assert.equal(existsSync(dir), true, 'a native session is never touched')
})

test('delete: refuses a chat that is open in DSH', async () => {
  const { root, cache } = store()
  const id = 'codex-open'
  const dir = placeSession(root, '--D-proj--', id)
  const result = await deleteImportedSessions(stubCtx({ live: [id] }), stubPersistence([id]), [id], {
    sessionsRoot: root,
    projectionCache: cache,
  })
  assert.deepEqual(result.deleted, [])
  assert.match(result.refused[0][1], /正在 DSH 中打开/)
  assert.equal(existsSync(dir), true)
})

test('delete: an unknown id is reported as missing, not as a failure', async () => {
  const { root, cache } = store()
  const result = await deleteImportedSessions(stubCtx(), stubPersistence([]), ['codex-gone'], {
    sessionsRoot: root,
    projectionCache: cache,
  })
  assert.deepEqual(result.missing, ['codex-gone'])
  assert.equal(result.refused.length, 0)
})

test('delete: dryRun reports without touching the store', async () => {
  const { root, cache } = store()
  const id = 'codex-dry'
  const dir = placeSession(root, '--D-proj--', id)
  const result = await deleteImportedSessions(stubCtx(), stubPersistence([id]), [id], {
    sessionsRoot: root,
    projectionCache: cache,
    dryRun: true,
  })
  assert.deepEqual(result.deleted, [id])
  assert.equal(existsSync(dir), true, 'dry run keeps the artifact')
})

test('locateSessionDir: finds the project folder that holds the id', async () => {
  const { root } = store()
  const dir = placeSession(root, '--D-another--', 'codex-loc')
  assert.equal(await locateSessionDir(root, 'codex-loc'), dir)
  assert.equal(await locateSessionDir(root, 'codex-nope'), undefined)
})
