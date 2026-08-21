/**
 * import-service: codex sub-agent threads are filtered by default and
 * re-included with importSubagents: true. Hermetic — stub persistence + ctx,
 * throwaway codex home. No dsh install needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCodex } from '../lib/import-service.js'

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
  return {
    store,
    persistence: {
      async list() { return [...store.keys()].map((id) => ({ id })) },
      async create(meta) { store.set(meta.id, []) },
      async append(id, events) { store.set(id, events) },
    },
    ctx: { get: () => undefined }, // no workspaceRegistry → attach step no-ops
  }
}

test('import-codex: sub-agent threads are filtered by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const sub = makeSession(root, 'sub', { parent_thread_id: 'sess-main', agent_nickname: 'Socrates' })
  const { persistence, ctx, store } = stubPersistence()

  const lines = await importCodex(ctx, persistence, {}, root)
  const report = lines.join('\n')
  assert.match(report, /\[codex\] result: imported 1, skipped 0, empty 0, subagent-skipped 1/)
  assert.ok(store.has(main), 'main session imported')
  assert.ok(!store.has(sub), 'sub-agent thread must NOT be imported by default')
  assert.match(report, /--include-subagents/, 'report hints the opt-in flag')
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
  assert.match(report, /would-import 1, skipped 0, empty 0, subagent-skipped 1/)
  assert.equal(store.size, 0, 'dry-run must not create sessions')
})

test('import-codex: importSubagents: true includes sub-agent threads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const sub = makeSession(root, 'sub', { parent_thread_id: 'sess-main', agent_nickname: 'Popper' })
  const { persistence, ctx, store } = stubPersistence()

  const lines = await importCodex(ctx, persistence, { importSubagents: true }, root)
  const report = lines.join('\n')
  assert.match(report, /imported 2, .*subagent-skipped 0/)
  assert.ok(store.has(main))
  assert.ok(store.has(sub))
})
