import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRolloutJsonl, dshEventsToCodexMessages, exportToCodex, listExportCatalog, titleOf } from '../lib/export-codex.js'

test('dshEventsToCodexMessages keeps user and assistant text', () => {
  const msgs = dshEventsToCodexMessages([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
  ])
  assert.deepEqual(msgs.map((m) => m.role + ':' + m.text), ['user:hello', 'assistant:hi'])
})

test('exportToCodex dry-run writes nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cx-export-'))
  const persistence = {
    async list() { return [{ id: 'sess-1', cwd: '/tmp/p', createdAt: Date.parse('2026-08-21T00:00:00Z') }] },
    async inspect() {
      return {
        events: [
          { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'ping' }] } },
          { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'pong' }] } } },
        ],
      }
    },
  }
  const lines = await exportToCodex(persistence, { dryRun: true, ids: ['sess-1'] }, home)
  assert.match(lines.join('\n'), /would-export 1/)
  assert.equal(readdirSync(home).length, 0)
})

test('exportToCodex writes a session_meta + response_item jsonl', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cx-export-'))
  const persistence = {
    async list() { return [{ id: 'sess-1', cwd: '/tmp/proj', createdAt: Date.parse('2026-01-02T03:04:05Z') }] },
    async inspect() {
      return {
        events: [
          { type: 'user/message', time: Date.parse('2026-01-02T03:04:06Z'), data: { content: [{ type: 'text', text: 'hi' }] } },
        ],
      }
    },
  }
  const lines = await exportToCodex(persistence, { ids: ['sess-1'] }, home)
  assert.match(lines.join('\n'), /exported 1/)
  const files = []
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name)
      if (name.isDirectory()) walk(p)
      else if (name.name.startsWith('rollout-') && name.name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(home)
  assert.equal(files.length, 1)
  const body = readFileSync(files[0], 'utf8')
  const rows = body.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows[0].type, 'session_meta')
  assert.equal(rows[0].payload.source, 'vscode')
  assert.equal(rows[0].payload.thread_source, 'user')
  assert.equal(rows[0].payload.history_mode, 'legacy')
  const kinds = rows.map((r) => r.type + ':' + (r.payload.type || r.payload.role || ''))
  assert.ok(kinds.includes('event_msg:task_started'))
  assert.ok(kinds.includes('event_msg:user_message'))
  const userItem = rows.find((r) => r.payload?.type === 'user_message')
  assert.equal(userItem.payload.message, 'hi')
})

test('buildRolloutJsonl is parseable JSONL', () => {
  const text = buildRolloutJsonl({
    uuid: '11111111-1111-1111-1111-111111111111',
    cwd: '/tmp',
    createdAt: Date.parse('2026-01-01T00:00:00Z'),
    messages: [
      { role: 'user', text: 'a', time: 1 },
      { role: 'assistant', text: 'b', time: 2 },
    ],
  })
  const rows = text.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows[0].type, 'session_meta')
  assert.equal(rows[0].payload.history_mode, 'legacy')
  assert.equal(rows[1].payload.type, 'task_started')
  const user = rows.find((r) => r.payload?.type === 'user_message')
  assert.equal(user.payload.message, 'a')
  const agent = rows.find((r) => r.payload?.type === 'agent_message')
  assert.equal(agent.payload.message, 'b')
  assert.equal(agent.payload.phase, 'final_answer')
  assert.equal(agent.payload.memory_citation, null)
})

test('titleOf: latest session/title wins; fallbacks work properly', () => {
  const withTitles = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'first msg' }] } },
    { type: 'session/title', data: { title: 'First title' } },
    { type: 'session/title', data: { title: '[codex] Latest title' } },
  ]
  assert.equal(titleOf(withTitles, 'fallback-id'), 'Latest title')

  const noTitleWithSystem = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>sys prompt</system-reminder>' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'What is deepseek harness?' }] } },
  ]
  assert.equal(titleOf(noTitleWithSystem, 'fallback-id'), 'What is deepseek harness?')

  const emptyEvents = []
  assert.equal(titleOf(emptyEvents, 'fallback-id'), 'fallback-id')
})

test('listExportCatalog: excludes codex-* sessions by default, inspects non-codex sessions for title and messageCount, filters empty sessions', async () => {
  const inspected = []
  const persistence = {
    async list() {
      return [
        { id: 'codex-old-thread', cwd: '/tmp/proj', createdAt: 100 },
        { id: 'sess-native-1', cwd: '/tmp/proj', createdAt: 200 },
        { id: 'sess-native-2', cwd: '/tmp/proj2', createdAt: 300 },
        { id: 'sess-empty-3', cwd: '/tmp/proj2', createdAt: 400 },
      ]
    },
    async inspect(id) {
      inspected.push(id)
      if (id === 'sess-native-1') {
        return {
          events: [
            { type: 'user/message', data: { content: [{ type: 'text', text: 'start task' }] } },
            { type: 'assistant/message', data: { content: [{ type: 'text', text: 'doing task' }] } },
            { type: 'session/title', data: { title: 'Initial Title' } },
            { type: 'session/title', data: { title: 'Updated Real Title' } },
          ],
        }
      }
      if (id === 'sess-empty-3') {
        return { events: [{ type: 'permission/preset', data: { preset: 'workspace-write' } }] }
      }
      return {
        events: [
          { type: 'user/message', data: { content: [{ type: 'text', text: 'simple prompt' }] } },
          { type: 'assistant/message', data: { content: [{ type: 'text', text: 'response' }] } },
        ],
      }
    },
  }

  const catalog = await listExportCatalog(persistence)
  assert.deepEqual(inspected, ['sess-native-1', 'sess-native-2', 'sess-empty-3'], 'Must inspect non-codex sessions')

  const allSessions = catalog.projects.flatMap((p) => p.sessions)
  assert.equal(allSessions.length, 2, 'Empty sessions (0 messages) must be filtered out')
  assert.ok(!allSessions.some((s) => s.id === 'sess-empty-3'), 'sess-empty-3 must be omitted')
  assert.ok(!allSessions.some((s) => s.id.startsWith('codex-')), 'Catalog must exclude codex-* sessions')

  const s1 = allSessions.find((s) => s.id === 'sess-native-1')
  assert.equal(s1.title, 'Updated Real Title')
  assert.equal(s1.messageCount, 2)
  assert.equal(s1.alreadyCodex, false)

  const s2 = allSessions.find((s) => s.id === 'sess-native-2')
  assert.equal(s2.title, 'simple prompt')
  assert.equal(s2.messageCount, 2)
})

test('listExportCatalog & exportToCodex: handle unchanged, updated, and missing source for codex sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cx-export-source-'))
  // Setup temp codexHome structure
  mkdirSync(join(home, 'sessions', '2026', '08', '21'), { recursive: true })
  mkdirSync(join(home, 'archived_sessions'), { recursive: true })

  // Write an original codex session rollout
  const originalCodexMessages = [
    { role: 'user', text: 'initial prompt' },
    { role: 'assistant', text: 'initial answer' },
  ]
  const originalJsonl = buildRolloutJsonl({
    uuid: 'codex-uuid-1',
    cwd: '/tmp/proj',
    createdAt: Date.parse('2026-08-21T00:00:00Z'),
    messages: originalCodexMessages,
  })
  writeFileSync(join(home, 'sessions', '2026', '08', '21', 'rollout-2026-08-21T00-00-00-codex-uuid-1.jsonl'), originalJsonl)

  // Write an archived subagent codex session rollout
  const subagentJsonl = JSON.stringify({
    timestamp: '2026-08-21T00:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      id: 'codex-sub-1',
      parent_thread_id: 'codex-uuid-1',
      cwd: '/tmp/proj',
      timestamp: '2026-08-21T00:00:00.000Z',
    },
  }) + '\n' + JSON.stringify({
    timestamp: '2026-08-21T00:00:01.000Z',
    ordinal: 1,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'sub task' }],
    },
  }) + '\n'
  writeFileSync(join(home, 'archived_sessions', 'rollout-archived-codex-sub-1.jsonl'), subagentJsonl)

  const persistence = {
    async list() {
      return [
        { id: 'codex-codex-uuid-1', cwd: '/tmp/proj', createdAt: 100 },
        { id: 'codex-codex-sub-1', cwd: '/tmp/proj', createdAt: 101 },
        { id: 'codex-missing-thread', cwd: '/tmp/proj', createdAt: 102 },
        { id: 'sess-native-root', cwd: '/tmp/proj', createdAt: 200 },
        { id: 'sess-native-child', cwd: '/tmp/proj', createdAt: 201, origin: 'subagent', parentSession: 'sess-native-root', delegationDepth: 1 },
      ]
    },
    async inspect(id) {
      if (id === 'codex-codex-uuid-1') {
        // DSH updated with a follow-up turn
        return {
          events: [
            { type: 'user/message', data: { content: [{ type: 'text', text: 'initial prompt' }] } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'initial answer' }] } } },
            { type: 'user/message', data: { content: [{ type: 'text', text: 'followup prompt in dsh' }] } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'followup answer in dsh' }] } } },
            { type: 'session/title', data: { title: 'DSH Continued Thread' } },
          ],
        }
      }
      if (id === 'codex-codex-sub-1') {
        // Untouched in DSH
        return {
          events: [
            { type: 'user/message', data: { content: [{ type: 'text', text: 'sub task' }] } },
          ],
        }
      }
      if (id === 'codex-missing-thread') {
        // Missing source
        return {
          events: [
            { type: 'user/message', data: { content: [{ type: 'text', text: 'orphan message' }] } },
          ],
        }
      }
      if (id === 'sess-native-root') {
        return {
          events: [
            { type: 'user/message', data: { content: [{ type: 'text', text: 'native root prompt' }] } },
          ],
        }
      }
      if (id === 'sess-native-child') {
        return {
          events: [
            { type: 'user/message', data: { content: [{ type: 'text', text: 'native subagent prompt' }] } },
          ],
        }
      }
      return { events: [] }
    },
  }

  // 1. Default list: excludes codex-* and subagents
  const defaultCat = await listExportCatalog(persistence, {}, home)
  const defaultSessions = defaultCat.projects.flatMap((p) => p.sessions)
  assert.deepEqual(defaultSessions.map((s) => s.id), ['sess-native-root'])
  assert.equal(defaultSessions[0].children.length, 0)

  // 2. includeSubagents: true -> native subagent nested under sess-native-root
  const subagentCat = await listExportCatalog(persistence, { includeSubagents: true }, home)
  const subProjects = subagentCat.projects.flatMap((p) => p.sessions)
  const nativeRoot = subProjects.find((s) => s.id === 'sess-native-root')
  assert.ok(nativeRoot)
  assert.equal(nativeRoot.children.length, 1)
  assert.equal(nativeRoot.children[0].id, 'sess-native-child')
  assert.equal(nativeRoot.children[0].isSubagent, true)
  assert.equal(nativeRoot.children[0].parentId, 'sess-native-root')

  // 3. includeCodex: true, includeSubagents: true -> inspections and comparisons
  const fullCat = await listExportCatalog(persistence, { includeCodex: true, includeSubagents: true }, home)
  const rootSessions = fullCat.projects.flatMap((p) => p.sessions)

  const codexMain = rootSessions.find((s) => s.id === 'codex-codex-uuid-1')
  assert.ok(codexMain)
  assert.equal(codexMain.fromCodex, true)
  assert.equal(codexMain.alreadyCodex, true)
  assert.equal(codexMain.dshUpdated, true)
  assert.equal(codexMain.sourceMissing, false)
  assert.equal(codexMain.dshAddedCount, 2)
  assert.equal(codexMain.title, 'DSH Continued Thread')
  assert.equal(codexMain.children.length, 1)

  const codexSub = codexMain.children[0]
  assert.equal(codexSub.id, 'codex-codex-sub-1')
  assert.equal(codexSub.isSubagent, true)
  assert.equal(codexSub.parentId, 'codex-codex-uuid-1')
  assert.equal(codexSub.fromCodex, true)
  assert.equal(codexSub.alreadyCodex, true)
  assert.equal(codexSub.dshUpdated, false)
  assert.equal(codexSub.sourceMissing, false)
  assert.equal(codexSub.dshAddedCount, 0)

  const missingSess = rootSessions.find((s) => s.id === 'codex-missing-thread')
  assert.ok(missingSess)
  assert.equal(missingSess.fromCodex, true)
  assert.equal(missingSess.alreadyCodex, true)
  assert.equal(missingSess.sourceMissing, true)
  assert.equal(missingSess.dshUpdated, false)
  assert.equal(missingSess.dshAddedCount, 0)

  // 4. exportToCodex tests:
  // (a) Untouched or missing source codex-* sessions skipped even if in ids
  const skipLines = await exportToCodex(persistence, { ids: ['codex-codex-sub-1', 'codex-missing-thread'] }, home)
  assert.match(skipLines.join('\n'), /\[skip-source\] codex-codex-sub-1/)
  assert.match(skipLines.join('\n'), /\[skip-source\] codex-missing-thread/)
  assert.match(skipLines.join('\n'), /exported 0, skipped 2, empty 0/)

  // (b) Exporting all without ids filter skips all codex-* sessions
  const exportAllLines = await exportToCodex(persistence, {}, home)
  assert.match(exportAllLines.join('\n'), /\[skip-source\] codex-codex-uuid-1/)
  assert.match(exportAllLines.join('\n'), /\[exported\] sess-native-root/)
  assert.match(exportAllLines.join('\n'), /\[exported\] sess-native-child/)

  // (c) Explicit options.ids with dshUpdated codex session is allowed and writes new copy with log note
  const updatedLines = await exportToCodex(persistence, { ids: ['codex-codex-uuid-1'] }, home)
  assert.match(updatedLines.join('\n'), /\[exported\] codex-codex-uuid-1  4 messages -> .* \(new copy; original Codex thread not overwritten\)/)
  assert.match(updatedLines.join('\n'), /exported 1, skipped 0, empty 0/)

  // Dry-run mode for updated codex session
  const dryLines = await exportToCodex(persistence, { ids: ['codex-codex-uuid-1'], dryRun: true }, home)
  assert.match(dryLines.join('\n'), /\[would-export\] codex-codex-uuid-1  4 messages -> .* \(new copy; original Codex thread not overwritten\)/)
  assert.match(dryLines.join('\n'), /would-export 1, skipped 0, empty 0/)
})
