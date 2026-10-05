/**
 * import-service: codex sub-agent threads are filtered by default and
 * re-included with importSubagents: true. Hermetic — stub persistence + ctx,
 * throwaway codex home. The real @deepseek-ai/dsh-session-format-* migration
 * packages are devDependencies, so the migration path is exercised without a
 * DSH install.
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

/** Write a rollout with an arbitrary message sequence: [{ role, text, time }]. */
function writeRollout(root, name, entries) {
  const dir = join(root, 'sessions', '2026', '08', '17')
  mkdirSync(dir, { recursive: true })
  const meta = {
    type: 'session_meta',
    payload: { id: `sess-${name}`, cwd: '/tmp/proj', timestamp: '2026-08-17T10:00:00.000Z', source: 'cli' },
  }
  const lines = [meta, ...entries.map((e) => rawEvent({
    type: 'message',
    id: `m-${name}-${e.role}-${e.text}`,
    role: e.role,
    content: [{ type: e.role === 'user' ? 'input_text' : 'output_text', text: e.text }],
  }))]
  writeFileSync(join(dir, `rollout-${name}.jsonl`), lines.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return `codex-sess-${name}`
}

/** Append raw response_item lines to an existing rollout file. */
function appendMessages(root, name, entries) {
  const file = join(root, 'sessions', '2026', '08', '17', `rollout-${name}.jsonl`)
  appendFileSync(file, entries.map((e) => JSON.stringify(rawEvent({
    type: 'message',
    id: `m-${name}-${e.role}-${e.text}`,
    role: e.role,
    content: [{ type: e.role === 'user' ? 'input_text' : 'output_text', text: e.text }],
  }))).join('\n') + '\n')
}

/**
 * Mirror real DSH session-persistence: `create` runs `encodeCurrentHeader`,
 * which rejects anything below the current format ("encodeCurrent requires
 * Session format v3" on 0.9.x, "…v4" on 0.10.x). A silent v0 fallback in the
 * importer therefore becomes a hard test failure here instead of passing.
 */
function assertCurrentFormatHeader(header) {
  if ((header?.version ?? 0) < 3) {
    throw new Error(`encodeCurrent requires Session format v3 (got v${header?.version ?? 'undefined'})`)
  }
}

function stubPersistence() {
  const store = new Map()
  const metas = new Map()
  return {
    store,
    metas,
    persistence: {
      async list() { return [...store.keys()].map((id) => ({ id })) },
      async create(meta) { assertCurrentFormatHeader(meta); metas.set(meta.id, meta); store.set(meta.id, []) },
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

test('import-codex: paginated rollout segments of one thread merge into a single session', async () => {
  // Codex continues a thread in NEW rollout files named
  // `rollout-<ts>-<uuid>_<fork>.jsonl` carrying the same session id and only
  // the delta turns. Each file used to be its own candidate → the second
  // segment called create() again and aborted the batch with
  // "session codex-… already exists".
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const dir = join(root, 'sessions', '2026', '08', '17')
  const segment = [
    { type: 'session_meta', payload: { id: 'sess-main', cwd: '/tmp/proj', timestamp: '2026-08-17T12:00:00.000Z', source: 'cli' } },
    rawEvent({ type: 'message', id: 'm-main-seg', role: 'user', content: [{ type: 'input_text', text: 'user-main-seg' }] }),
  ]
  writeFileSync(join(dir, 'rollout-main_fork1.jsonl'), segment.map((e) => JSON.stringify(e)).join('\n') + '\n')

  const { persistence, ctx, store } = stubPersistence()
  const lines = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(lines.join('\n'), /imported 1/, 'both segments must produce exactly ONE create')
  const users = store.get(main).filter((e) => e.type === 'user/message').map((e) => e.data.content.map((b) => b.text).join(''))
  assert.ok(users.some((t) => t.includes('user-main-1')), 'base segment messages imported')
  assert.ok(users.some((t) => t.includes('user-main-seg')), 'continuation segment messages imported in the same session')
})

test('import-codex: writes the session in the installed current format, not v0 (issue #2)', async () => {
  // DSH persistence rejects older formats on write ("encodeCurrent requires
  // Session format v4" on DSH 0.10.x), so the importer must migrate the
  // imported v0 artifact to the installed current format via session-migrate.
  // The REAL migration packages are devDependencies, so this path is REQUIRED
  // (no early return): if the chain cannot resolve, migrateToCurrent throws
  // and importCodex now fails loudly instead of writing v0.
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const { persistence, ctx, store, metas } = stubPersistence()
  const { migrateToCurrent } = await import('../lib/session-migrate.mjs')
  const probe = migrateToCurrent({ version: 0, id: 'probe', createdAt: 1, cwd: '/tmp' }, [])
  assert.ok(
    probe.header.version >= 3,
    `migration chain must resolve to the current format (got v${probe.header.version}); run npm install so the @deepseek-ai/dsh-session-format-* devDependencies are present`,
  )
  await importCodex(ctx, persistence, {}, root)
  const meta = metas.get(main)
  assert.ok(meta, 'session created')
  assert.equal(meta.version, probe.header.version, 'imported session header must be the migrated current format (not v0)')
  assert.equal(meta.isSeeded, false, 'migrated header carries isSeeded=false')
  const events = store.get(main) ?? []
  const asst = events.find((e) => e.type === 'assistant/message')
  assert.ok(asst !== undefined && Array.isArray(asst.data.stream), 'current-format assistant/message carries a stream')
  assert.ok(events.some((e) => e.type === 'system/message'), 'session carries a promoted system/message head')
})

test('import-codex: written session passes the real DSH current-format write gate', async () => {
  // The exact gate that rejected v3 writes on DSH 0.10.0 with
  // "encodeCurrent requires Session format v4": the written header and every
  // written event must encode as the installed current format, and the
  // artifact must restore through the real current-format restorer (i.e. the
  // persisted session can be reopened by DSH).
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const { persistence, ctx, store, metas } = stubPersistence()
  await importCodex(ctx, persistence, {}, root)
  const meta = metas.get(main)
  const events = store.get(main) ?? []
  const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog')
  assert.equal(meta.version, sessionFormatCatalog.currentVersion, 'written header version must equal the installed current format')
  sessionFormatCatalog.encodeCurrentHeader(meta, 0) // must not throw
  for (const event of events) sessionFormatCatalog.encodeCurrentEvent(event) // must not throw
  // Restore through the real restorer (pinned to v4 while the devDeps track
  // the 0.1.7-rc.2 packages of DSH 0.10.0).
  const { restoreReleasedV4Artifact } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  restoreReleasedV4Artifact({ header: meta, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
})

test('import-codex: writes through the DSH 0.9.0 handle-based persistence API (no persistence.append)', async () => {
  // DSH 0.9.0's sessionPersistence exposes list/create/open/delete and returns
  // per-session HANDLES — it has NO append(id,…) and NO inspect(id). The
  // plugin's facade must map its familiar calls onto open(id,'read'/'write') +
  // handle.append/read/flush/close. Regression: importer used to call
  // `persistence.append(id, events)` directly, which 0.9.0 rejects as
  // "persistence.append is not a function" (issue #2 follow-up).
  const store = new Map() // id -> { header, events }
  const ops = []
  const persistence = {
    async list() { return [...store.keys()].map((id) => ({ header: store.get(id).header, revision: 'r', sizeBytes: 0 })) },
    async create(header) {
      if ((header?.version ?? 0) < 3) throw new Error(`encodeCurrent requires Session format v3 (got v${header?.version ?? 'undefined'})`)
      store.set(header.id, { header, events: [] })
      return {
        async append(events) { ops.push('handle.append'); store.get(header.id).events.push(...events) },
        async flush() { ops.push('handle.flush') },
        async read() { return { eventState: 'current', events: store.get(header.id).events } },
        async close() { ops.push('handle.close') },
        header,
      }
    },
    async open(id, access) {
      ops.push(`open(${access})`)
      const s = store.get(id)
      if (s === undefined) throw new Error(`not found: ${id}`)
      return {
        async append(events) { ops.push('handle.append'); s.events.push(...events) },
        async flush() { ops.push('handle.flush') },
        async read() { return { eventState: 'current', events: s.events } },
        async close() { ops.push('handle.close') },
        header: s.header,
      }
    },
    async delete(id) { return store.delete(id) },
  }

  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  await importCodex({ get: () => undefined }, persistence, {}, root)

  assert.ok(store.has(main), 'session imported via create+handle.append')
  assert.ok(!ops.some((o) => String(o).startsWith('persistence.')), 'must not call a persistence.* legacy method')
  assert.ok(ops.includes('handle.append'), 'write goes through handle.append')
  // Re-import with no new turns → update path inspects via open('read') and skips.
  ops.length = 0
  await importCodex({ get: () => undefined }, persistence, {}, root)
  assert.ok(ops.includes('open(read)'), 'existing session is read via open(id,"read") not inspect()')
})

test('import-codex: same-turn assistant continuation lands in a self-consistent turn (combined restore)', async () => {
  // Old importer damage (review issue 1): re-importing [q,a,b] over a stored
  // [q,a] produced a suffix starting with turn/start(2) followed by step/end(1)
  // — old.events + suffix failed the real v4 restorer. The continuation is now
  // repacked into ONE fresh turn and the COMBINED artifact must restore.
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const { persistence, ctx, store, metas } = stubPersistence()
  await importCodex(ctx, persistence, { ids: [main] }, root)
  const { restoreReleasedV4Artifact } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  const validate = () => restoreReleasedV4Artifact(
    { header: metas.get(main), events: store.get(main), inheritedEventCount: 0 },
    KNOWN_SESSION_EVENT_TYPES,
  )
  validate() // first import restores cleanly
  const file = join(root, 'sessions', '2026', '08', '17', 'rollout-main.jsonl')
  appendFileSync(file, [
    { type: 'response_item', timestamp: '2026-08-17T11:00:00.000Z', payload: { type: 'message', id: 'm-main-b', role: 'assistant', content: [{ type: 'output_text', text: 'assistant-main-cont' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const lines = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(lines.join('\n'), /updated 1/)
  validate() // combined old + appended suffix must STILL restore cleanly
  const users = store.get(main).filter((e) => e.type === 'user/message')
  assert.equal(users.length, 1, 'no duplicated user message')
})

test('import-codex: a reply arriving after a user-only import is stored (pending-question continuation)', async () => {
  // Review round 4: the first import while the reply was still pending stored
  // [user q] only. Re-importing after the assistant answered reported
  // "updated 0, skipped 1" and the answer was silently LOST: the equal-user
  // branch of diffImportEvents incremented its assistant counter before
  // comparing, so the oldAssistants === 0 match could never fire. The stored
  // answer, the combined-artifact restore AND idempotence are all asserted.
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = writeRollout(root, 'pend', [
    { role: 'user', text: 'user-pend-q', time: '2026-08-17T10:00:01.000Z' },
  ])
  const { persistence, ctx, store, metas } = stubPersistence()
  await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.equal((store.get(main) ?? []).filter((e) => e.type === 'assistant/message').length, 0, 'precondition: imported while the reply was pending')

  const { restoreReleasedV4Artifact } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  const validate = () => restoreReleasedV4Artifact(
    { header: metas.get(main), events: store.get(main), inheritedEventCount: 0 },
    KNOWN_SESSION_EVENT_TYPES,
  )
  validate()

  appendMessages(root, 'pend', [
    { role: 'assistant', text: 'assistant-pend-answer', time: '2026-08-17T11:00:00.000Z' },
  ])
  const lines = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(lines.join('\n'), /updated 1/, 'the pending reply must be stored, not skipped')
  const events = store.get(main)
  const answers = events.filter((e) => e.type === 'assistant/message')
  assert.equal(answers.length, 1, 'exactly the one new assistant message is stored')
  assert.ok(JSON.stringify(answers[0].data.message.content).includes('assistant-pend-answer'), 'the stored answer carries the new text')
  assert.equal(events.filter((e) => e.type === 'user/message').length, 1, 'no duplicated user message')
  validate() // combined old + appended answer must restore through the real restorer

  const again = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(again.join('\n'), /updated 0, skipped 1/, 'an unchanged re-import stays idempotent')
  assert.equal(store.get(main).length, events.length, 'idempotent re-import writes nothing')
})

test('import-codex: a pending reply AND a following new turn are both stored', async () => {
  // The new content may START inside old's last turn (the reply to a still
  // pending question) and CONTINUE with complete new turns. Both parts must
  // land: the pending-turn slice repacked as one fresh turn, the new turns
  // renumbered after it — the combined artifact must restore.
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = writeRollout(root, 'mix', [
    { role: 'user', text: 'user-mix-q1', time: '2026-08-17T10:00:01.000Z' },
  ])
  const { persistence, ctx, store, metas } = stubPersistence()
  await importCodex(ctx, persistence, { ids: [main] }, root)

  appendMessages(root, 'mix', [
    { role: 'assistant', text: 'assistant-mix-a1', time: '2026-08-17T11:00:00.000Z' },
    { role: 'user', text: 'user-mix-q2', time: '2026-08-17T11:00:01.000Z' },
    { role: 'assistant', text: 'assistant-mix-a2', time: '2026-08-17T11:00:02.000Z' },
  ])
  const lines = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(lines.join('\n'), /updated 1/)
  const events = store.get(main)
  const textOf = (e) => JSON.stringify(e.data?.message?.content ?? e.data?.content ?? [])
  const assistants = events.filter((e) => e.type === 'assistant/message').map(textOf)
  assert.equal(assistants.length, 2, 'both assistant messages stored')
  assert.ok(assistants.some((t) => t.includes('assistant-mix-a1')) && assistants.some((t) => t.includes('assistant-mix-a2')))
  const users = events.filter((e) => e.type === 'user/message').map(textOf)
  assert.equal(users.length, 2, 'no duplicated user message')
  const { restoreReleasedV4Artifact } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  restoreReleasedV4Artifact({ header: metas.get(main), events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
})

test('import-codex: a reply to a turn without an assistant is stored even after earlier complete turns', async () => {
  // Same counting defect, multi-turn shape: stored [q1, a1, q2] (turn 2 still
  // pending) — the old code matched neither "the oldAssistants-th assistant"
  // (it sits in turn 1) nor the seen===match-1 guard, so a2 was dropped.
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = writeRollout(root, 'late', [
    { role: 'user', text: 'user-late-q1', time: '2026-08-17T10:00:01.000Z' },
    { role: 'assistant', text: 'assistant-late-a1', time: '2026-08-17T10:00:02.000Z' },
    { role: 'user', text: 'user-late-q2', time: '2026-08-17T10:00:03.000Z' },
  ])
  const { persistence, ctx, store, metas } = stubPersistence()
  await importCodex(ctx, persistence, { ids: [main] }, root)

  appendMessages(root, 'late', [
    { role: 'assistant', text: 'assistant-late-a2', time: '2026-08-17T11:00:00.000Z' },
  ])
  const lines = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(lines.join('\n'), /updated 1/, 'the pending reply must be stored, not skipped')
  const events = store.get(main)
  const assistants = events.filter((e) => e.type === 'assistant/message')
  assert.equal(assistants.length, 2)
  assert.ok(JSON.stringify(assistants[1].data.message.content).includes('assistant-late-a2'))
  const { restoreReleasedV4Artifact } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  restoreReleasedV4Artifact({ header: metas.get(main), events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
  const again = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(again.join('\n'), /updated 0, skipped 1/, 'idempotent on the next unchanged import')
})

test('import-codex: new-turn re-import combined artifact restores cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const { persistence, ctx, store, metas } = stubPersistence()
  await importCodex(ctx, persistence, { ids: [main] }, root)
  const file = join(root, 'sessions', '2026', '08', '17', 'rollout-main.jsonl')
  appendFileSync(file, [
    { type: 'response_item', timestamp: '2026-08-17T12:00:00.000Z', payload: { type: 'message', id: 'm-main-2', role: 'user', content: [{ type: 'input_text', text: 'user-main-2' }] } },
    { type: 'response_item', timestamp: '2026-08-17T12:00:01.000Z', payload: { type: 'message', id: 'm-main-3', role: 'assistant', content: [{ type: 'output_text', text: 'assistant-main-2' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const lines = await importCodex(ctx, persistence, { ids: [main] }, root)
  assert.match(lines.join('\n'), /updated 1/)
  // COMBINED old + appended new turn must pass the real current-format restorer.
  const { restoreReleasedV4Artifact } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  restoreReleasedV4Artifact(
    { header: metas.get(main), events: store.get(main), inheritedEventCount: 0 },
    KNOWN_SESSION_EVENT_TYPES,
  )
})

test('import-codex: a failed read skips the session instead of appending to it', async () => {
  // Review issue 3: inspect() used to swallow read errors as empty history,
  // which would append the whole source onto an existing session.
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  const main = makeSession(root, 'main')
  const appended = []
  const persistence = {
    async list() { return [{ id: main }] }, // session already exists
    async inspect() { throw new Error('simulated disk read failure') },
    async append(id, events) { appended.push([id, events]) },
    async create() { throw new Error('create must not be reached') },
  }
  const lines = await importCodex({ get: () => undefined }, persistence, {}, root)
  assert.equal(appended.length, 0, 'no append after a failed read')
  assert.match(lines.join('\n'), /skipped 1/)
})

test('import-codex: a failed flush surfaces instead of reporting success', async () => {
  // Review issue 4: createAndAppend used to swallow flush/close failures and
  // resolve successfully on a disk-full. Cleanup is still attempted, then the
  // durability error propagates.
  const root = mkdtempSync(join(tmpdir(), 'cx-sync-import-'))
  makeSession(root, 'main')
  const ops = []
  const persistence = {
    async list() { return [] },
    async create(header) {
      return {
        async append() { ops.push('append') },
        async flush() { ops.push('flush'); throw new Error('disk full') },
        async close() { ops.push('close') },
        header,
      }
    },
    async open() { throw new Error('not opened') },
  }
  await assert.rejects(
    () => importCodex({ get: () => undefined }, persistence, {}, root),
    /disk full/,
  )
  assert.deepEqual(ops, ['append', 'flush', 'close'], 'cleanup attempted before surfacing the error')
})
