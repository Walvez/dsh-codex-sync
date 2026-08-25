/**
 * import-service: codex sub-agent threads are filtered by default and
 * re-included with importSubagents: true. Hermetic — stub persistence + ctx,
 * throwaway codex home. No dsh install needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCodex, listImportCatalog } from '../lib/import-service.js'

// Build a raw response_item event (NOT a string) so the file body below can be
// JSON.stringify'd exactly once per line.
const rawEvent = (payload) => ({ type: 'response_item', timestamp: '2026-08-17T10:00:01.000Z', payload })

function makeSession(root, name, metaExtra = {}) {
  const dir = join(root, 'sessions', '2026', '08', '17')
  mkdirSync(dir, { recursive: true })
  const meta = {
    type: 'session_meta',
    payload: { id: `sess-${name}`, cwd: '/tmp/proj', timestamp: '2026-08-17T10:00:00.000Z', source: 'cli', ...metaExtra },
  }
  const text = (role, t) => rawEvent({
    type: 'message',
    id: `m-${name}-${t}`,
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: `${role}-${name}-${t}` }],
  })
  const body = [meta, text('user', 1), text('assistant', 1)].map((e) => JSON.stringify(e)).join('\n') + '\n'
  writeFileSync(join(dir, `rollout-${name}.jsonl`), body)
  return `codex-sess-${name}`
}

function stubPersistence() {
  const store = new Map()
  const metas = new Map()
  return {
    store,
    metas,
    persistence: {
      async list() { return [...store.keys()].map((id) => ({ id })) },
      async create(meta) { metas.set(meta.id, meta); store.set(meta.id, []) },
      async append(id, events) { store.set(id, [...(store.get(id) ?? []), ...events]) },
      async inspect(id) { return { meta: metas.get(id) ?? { id }, events: store.get(id) ?? [] } },
    },
    ctx: { get: () => undefined }, // no workspaceRegistry → attach step no-ops
  }
}

test('import-codex: sub-agent threads are filtered by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const sub = makeSession(root, 'sub', { parent_thread_id: 'sess-main', agent_nickname: 'Socrates' })
  const { persistence, ctx, store, metas } = stubPersistence()

  const lines = await importCodex(ctx, persistence, {}, root)
  const report = lines.join('\n')
  assert.match(report, /\[codex\] result: imported 1, updated 0, skipped 0, empty 0, subagent-skipped 1/)
  assert.ok(store.has(main), 'main session imported')
  assert.ok(!store.has(sub), 'sub-agent thread must NOT be imported by default')
  assert.equal(metas.get(main)?.agentPreset, 'cordis', 'imported sessions resume under the working cordis preset')
  assert.match(report, /--include-subagents/, 'report hints the opt-in flag')
})

test('catalog: nests sub-agents under parent and marks imported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const mainId = makeSession(root, 'main')
  makeSession(root, 'kid', { parent_thread_id: 'sess-main', agent_nickname: 'Socrates' })
  const { persistence, store } = stubPersistence()
  store.set(mainId, [])

  const hidden = await listImportCatalog(persistence, { importSubagents: false }, root)
  assert.equal(hidden.projects.length, 1)
  assert.equal(hidden.projects[0].label, 'proj')
  assert.equal(hidden.projects[0].sessions.length, 1)
  assert.equal(hidden.projects[0].sessions[0].id, mainId)
  assert.equal(hidden.projects[0].sessions[0].imported, true)
  assert.equal(hidden.projects[0].sessions[0].children.length, 0)

  const shown = await listImportCatalog(persistence, { importSubagents: true }, root)
  const parent = shown.projects[0].sessions[0]
  assert.equal(parent.children.length, 1)
  assert.equal(parent.children[0].isSubagent, true)
  assert.equal(parent.children[0].imported, false)
  assert.match(parent.children[0].title, /user-kid/)
})

test('import-codex: ids imports only the listed session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const other = makeSession(root, 'other')
  const { persistence, ctx, store } = stubPersistence()
  await importCodex(ctx, persistence, { ids: [other], importSubagents: true }, root)
  assert.ok(store.has(other))
  assert.ok(!store.has(main))
})

test('import-codex: dryRun lists candidates but writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  makeSession(root, 'sub', { parent_thread_id: 'sess-main', agent_nickname: 'Socrates' })
  const { persistence, ctx, store } = stubPersistence()

  const lines = await importCodex(ctx, persistence, { dryRun: true }, root)
  const report = lines.join('\n')
  assert.match(report, /\[codex\] dry-run: no sessions will be written/)
  assert.ok(report.includes(`[would-import] ${main}`), 'dry-run lists the main session')
  assert.match(report, /would-import 1, updated 0, skipped 0, empty 0, subagent-skipped 1/)
  assert.equal(store.size, 0, 'dry-run must not create sessions')
})

test('import-codex: importSubagents: true includes sub-agent threads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const sub = makeSession(root, 'sub', { parent_thread_id: 'sess-main', agent_nickname: 'Popper' })
  const { persistence, ctx, store } = stubPersistence()

  const lines = await importCodex(ctx, persistence, { importSubagents: true }, root)
  const report = lines.join('\n')
  assert.match(report, /imported 2, updated 0, .*subagent-skipped 0/)
  assert.ok(store.has(main))
  assert.ok(store.has(sub))
})

test('import-codex: re-import appends new Codex turns onto an existing session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const { persistence, ctx, store } = stubPersistence()
  await importCodex(ctx, persistence, {}, root)
  const before = store.get(main).length
  const file = join(root, 'sessions', '2026', '08', '17', 'rollout-main.jsonl')
  appendFileSync(file, [
    { type: 'response_item', timestamp: '2026-08-17T12:00:00.000Z', payload: { type: 'message', id: 'm-main-2', role: 'user', content: [{ type: 'input_text', text: 'user-main-2' }] } },
    { type: 'response_item', timestamp: '2026-08-17T12:00:01.000Z', payload: { type: 'message', id: 'm-main-3', role: 'assistant', content: [{ type: 'output_text', text: 'assistant-main-2' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const catalog = await listImportCatalog(persistence, {}, root)
  assert.equal(catalog.projects[0].sessions[0].stale, true)

  const lines = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(lines.join('\n'), /updated 1/)
  assert.ok(store.get(main).length > before)
  const users = store.get(main).filter((e) => e.type === 'user/message').map((e) => e.data.content.map((b) => b.text).join(''))
  assert.ok(users.some((t) => t.includes('user-main-2')))
})
