/**
 * codex-reader: system control blocks are stripped, empty control-only user
 * messages open no turn and never seed the title.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodexSession, isSubagentThread } from '../lib/codex-reader.mjs'
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

// ═══ v0.7.0-new-schema: custom_tool_call / custom_tool_call_output / reasoning,
// image fragments, truncated real tool results.

function rolloutOf(events, meta = { id: 'sess-new', cwd: '/tmp/proj', timestamp: '2026-08-17T10:00:00.000Z' }) {
  const lines = [
    { type: 'session_meta', payload: meta },
    ...events,
  ]
  return lines.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

const msg = (type, time, role, blocks) => ({ type: 'response_item', timestamp: time, payload: { type: 'message', id: `m-${time}`, role, content: blocks } })
const call = (time, id, name, input) => ({ type: 'response_item', timestamp: time, payload: { type: 'custom_tool_call', call_id: id, name, input } })
const out = (time, id, output, isError = false) => ({ type: 'response_item', timestamp: time, payload: { type: 'custom_tool_call_output', call_id: id, output, is_error: isError } })
const reason = (time, summary) => ({ type: 'response_item', timestamp: time, payload: { type: 'reasoning', summary } })

let n = 0
const write = (file, text) => { writeFileSync(file, text); return file }
const nextFile = (kind) => write(join(mkdtempSync(join(tmpdir(), 'cx-new-')), `${kind}-${++n}.jsonl`), '')

test('new schema: tool call + real output fold into one assistant message with real result', () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '改一下 main.js' }]),
    msg('T2', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: '我用编辑工具。' }]),
    call('T3', 'call-1', 'edit', '*** Begin Patch\ndiff --git a/main.js b/main.js\n@@ start\n-let x = 1\n+let x = 2'),
    out('T4', 'call-1', '文件已修改：main.js (+1 -1)'),
    msg('T5', '2026-08-17T10:00:09Z', 'assistant', [{ type: 'output_text', text: '改好了。' }]),
  ]
  const file = nextFile('tools'); write(file, rolloutOf(events))
  const { messages } = parseCodexSession(file)
  // user, assistant(text), assistant(tool call+result), assistant(text)
  assert.equal(messages.length, 4)
  const toolMsg = messages[2]
  assert.equal(toolMsg.role, 'assistant')
  const calls = toolMsg.blocks.filter((b) => b.type === 'tool-call')
  const results = toolMsg.blocks.filter((b) => b.type === 'tool-result')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'call-1')
  assert.equal(calls[0].name, 'edit')
  assert.match(calls[0].arguments, /Begin Patch/, 'apply_patch body kept as raw args string')
  assert.equal(results.length, 1)
  assert.equal(results[0].toolCallId, 'call-1')
  assert.equal(results[0].content[0].text, '文件已修改：main.js (+1 -1)')

  // convert: real tool/result surface event, real content, no tool-result block
  // in the written assistant message content
  const events2 = buildDshEvents(messages, { toolEvents: true })
  const toolResult = events2.find((e) => e.type === 'tool/result')
  assert.ok(toolResult, 'a tool/result event must exist')
  assert.equal(toolResult.data.message.content[0].content[0].text, '文件已修改：main.js (+1 -1)')
  const written = events2.find((e) => e.type === 'assistant/message')
  assert.ok(written.data.message.content.every((b) => b.type !== 'tool-result'), 'tool-result block must not appear in assistant content')
})

test('new schema: oversized tool output is capped with a truncation note', () => {
  const big = 'y'.repeat(9000)
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '列目录' }]),
    call('T2', 'call-9', 'list_files', '{}'),
    out('T3', 'call-9', big),
    msg('T4', '2026-08-17T10:00:09Z', 'assistant', [{ type: 'output_text', text: '太长我截断了。' }]),
  ]
  const file = nextFile('cap'); write(file, rolloutOf(events))
  const { messages } = parseCodexSession(file)
  const blocks = messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool-result')
  assert.equal(blocks.length, 1)
  const text = blocks[0].content[0].text
  assert.ok(text.length <= 4050, `capped: ${text.length}`)
  assert.match(text, /…\[截断：源输出 9000 字符\]/)
})

test('new schema: reasoning summary_text arrays flatten to a string', () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: 'hi' }]),
    reason('T2', [{ type: 'summary_text', text: 'think step one' }]),
    msg('T3', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: 'ok' }]),
  ]
  const file = nextFile('reason-arr'); write(file, rolloutOf(events))
  const { messages } = parseCodexSession(file)
  const reasoning = messages[1].blocks.filter((b) => b.type === 'reasoning')
  assert.equal(reasoning[0].text, 'think step one')
  const events2 = buildDshEvents(messages, { toolEvents: true })
  const asst = events2.find((e) => e.type === 'assistant/message' && e.data.message.content[0].type === 'reasoning')
  assert.equal(typeof asst.data.message.content[0].text, 'string')
})

test('new schema: reasoning summaries merge into the pending assistant message', () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '1+1?' }]),
    reason('T2', '先心算，1+1=2'),
    msg('T3', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: '等于 2。' }]),
  ]
  const file = nextFile('reason'); write(file, rolloutOf(events))
  const { messages } = parseCodexSession(file)
  assert.equal(messages.length, 3)
  const reasoning = messages[1].blocks.filter((b) => b.type === 'reasoning')
  assert.equal(reasoning.length, 1)
  assert.equal(reasoning[0].text, '先心算，1+1=2')
})

test('new schema: raw image fragments are stripped from user text', () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [
      { type: 'input_text', text: '# Files mentioned by the user:\n\n## 照片 1.jpg content' },
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/codex-remote-attachments/abc.jpg">' },
      { type: 'input_text', text: '</image>' },
    ]),
    msg('T2', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: '我看到了。' }]),
  ]
  const file = nextFile('img'); write(file, rolloutOf(events))
  const { messages } = parseCodexSession(file)
  assert.equal(messages.length, 2)
  const userText = messages[0].blocks.map((b) => b.text).join('\n')
  assert.doesNotMatch(userText, /<image/, 'image fragments must be stripped')
  assert.match(userText, /# Files mentioned by the user:/)
})

test('legacy schema: tool_use blocks inside message content still map to tool-calls', () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '读文件' }]),
    msg('T2', '2026-08-17T10:00:05Z', 'assistant', [
      { type: 'output_text', text: '读取中' },
      { type: 'tool_use', id: 'call-7', name: 'read_file', input: { path: '/tmp/x.txt' } },
    ]),
  ]
  const file = nextFile('legacy'); write(file, rolloutOf(events))
  const { messages } = parseCodexSession(file)
  const toolCall = messages[1].blocks.find((b) => b.type === 'tool-call')
  assert.ok(toolCall)
  assert.equal(toolCall.id, 'call-7')
  assert.equal(toolCall.name, 'read_file')
  assert.match(toolCall.arguments, /x\.txt/)
})


test('reader: parent_thread_id marks a sub-agent thread header', () => {
  const meta = { id: 'sess-sub', cwd: '/tmp', timestamp: '2026-08-17T10:00:00.000Z', parent_thread_id: 'sess-main', agent_nickname: 'Einstein' }
  const file = nextFile('subagent-marker')
  write(file, rolloutOf([{ type: 'session_meta', payload: meta }]))
  const { header } = parseCodexSession(file)
  assert.equal(header.parentThreadId, 'sess-main')
  assert.equal(header.agentNickname, 'Einstein')
  assert.equal(isSubagentThread(header), true)
  assert.equal(isSubagentThread({}), false)
})
