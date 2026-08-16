/**
 * codex-reader: system control blocks are stripped, empty control-only user
 * messages open no turn and never seed the title.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodexSession } from '../lib/codex-reader.mjs'
import { buildDshEvents, deriveImportTitle } from '../lib/convert.mjs'

const ROLLOUT = [
  { type: 'session_meta', payload: { id: 'sess-1', cwd: '/tmp/proj', timestamp: '2026-08-13T14:53:15.031Z' } },
  {
    type: 'response_item', timestamp: '2026-08-13T14:53:19.472Z',
    payload: {
      type: 'message', id: 'm1', role: 'user',
      content: [
        { type: 'input_text', text: '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n- Notion (notion@openai-curated-remote)\n</recommended_plugins>' },
        { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# Exa usage policy\n- Use web_search_exa for lookups.\n</INSTRUCTIONS>' },
        { type: 'input_text', text: '<environment_context>\n  <cwd>/tmp/proj</cwd>\n  <current_date>2026-08-14</current_date>\n</environment_context>' },
        { type: 'input_text', text: '帮我安装 deepseek harness 到本机\n' },
      ],
    },
  },
  {
    type: 'response_item', timestamp: '2026-08-13T14:53:25.000Z',
    payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: '好的，我来安装。' }] },
  },
  {
    type: 'response_item', timestamp: '2026-08-13T14:54:00.000Z',
    payload: { type: 'message', id: 'm3', role: 'user', content: [{ type: 'input_text', text: '要不要全局安装？' }] },
  },
].map((e) => JSON.stringify(e)).join('\n') + '\n'

test('codex reader strips control blocks and keeps real text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-reader-'))
  const file = join(dir, 'rollout-test.jsonl')
  writeFileSync(file, ROLLOUT)
  const { header, messages } = parseCodexSession(file)
  assert.equal(header.id, 'sess-1')
  assert.equal(messages.length, 3)
  // first user message: only the real prompt survives
  const first = messages[0]
  assert.equal(first.role, 'user')
  assert.deepEqual(first.blocks, [{ type: 'text', text: '帮我安装 deepseek harness 到本机\n' }])
  assert.equal(messages[1].blocks[0].text, '好的，我来安装。')
  assert.equal(messages[2].blocks[0].text, '要不要全局安装？')
})

test('convert: control-only user message opens no turn and never seeds the title', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-reader-'))
  const file = join(dir, 'rollout-test.jsonl')
  writeFileSync(file, ROLLOUT)
  const { messages } = parseCodexSession(file)
  const events = buildDshEvents(messages, { toolEvents: true, titlePinned: true })
  const kinds = events.map((e) => e.type)
  // no turn/start before the first real user message
  const firstUser = events.find((e) => e.type === 'user/message')
  assert.ok(firstUser, 'a user/message exists')
  assert.equal(events.indexOf(firstUser), 1, 'first event is turn/start of the REAL first user message')
  const text = firstUser.data.content.map((b) => b.text).join('')
  assert.equal(text, '帮我安装 deepseek harness 到本机\n')

  const title = deriveImportTitle(undefined, messages, 'codex')
  assert.ok(title.startsWith('[codex] 帮我安装'), `title must come from the real prompt, got: ${title}`)
  assert.ok(!title.includes('recommended_plugins'), 'title must not contain control-block text')
  assert.ok(!title.includes('AGENTS.md'), 'title must not contain AGENTS.md text')
})
