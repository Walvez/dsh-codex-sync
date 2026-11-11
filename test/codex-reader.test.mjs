/**
 * codex-reader: system control blocks are stripped, empty control-only user
 * messages open no turn and never seed the title.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
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

test('codex reader strips control blocks and keeps real text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-reader-'))
  const file = join(dir, 'rollout-test.jsonl')
  writeFileSync(file, ROLLOUT)
  const { header, messages } = await parseCodexSession(file)
  assert.equal(header.id, 'sess-1')
  assert.equal(messages.length, 3)
  // first user message: only the real prompt survives
  const first = messages[0]
  assert.equal(first.role, 'user')
  assert.deepEqual(first.blocks, [{ type: 'text', text: '帮我安装 deepseek harness 到本机\n' }])
  assert.equal(messages[1].blocks[0].text, '好的，我来安装。')
  assert.equal(messages[2].blocks[0].text, '要不要全局安装？')
})

test('convert: control-only user message opens no turn and never seeds the title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-reader-'))
  const file = join(dir, 'rollout-test.jsonl')
  writeFileSync(file, ROLLOUT)
  const { messages } = await parseCodexSession(file)
  const events = buildDshEvents(messages, { toolEvents: true, titlePinned: true })
  const kinds = events.map((e) => e.type)
  // no turn/start before the first real user message
  const firstUser = events.find((e) => e.type === 'user/message')
  assert.ok(firstUser, 'a user/message exists')
  // event order is turn/start → step/start → user/message (issue #2: the first
  // surface event must follow a step/start so the format v2→v3 migration can
  // acquire its system head).
  assert.equal(events.indexOf(firstUser), 2, 'user/message follows turn/start and step/start')
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

test('new schema: tool call + real output fold into one assistant message with real result', async () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '改一下 main.js' }]),
    msg('T2', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: '我用编辑工具。' }]),
    call('T3', 'call-1', 'edit', '*** Begin Patch\ndiff --git a/main.js b/main.js\n@@ start\n-let x = 1\n+let x = 2'),
    out('T4', 'call-1', '文件已修改：main.js (+1 -1)'),
    msg('T5', '2026-08-17T10:00:09Z', 'assistant', [{ type: 'output_text', text: '改好了。' }]),
  ]
  const file = nextFile('tools'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
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

test('new schema: oversized tool output is capped with a truncation note', async () => {
  const big = 'y'.repeat(9000)
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '列目录' }]),
    call('T2', 'call-9', 'list_files', '{}'),
    out('T3', 'call-9', big),
    msg('T4', '2026-08-17T10:00:09Z', 'assistant', [{ type: 'output_text', text: '太长我截断了。' }]),
  ]
  const file = nextFile('cap'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
  const blocks = messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool-result')
  assert.equal(blocks.length, 1)
  const text = blocks[0].content[0].text
  assert.ok(text.length <= 4050, `capped: ${text.length}`)
  assert.match(text, /…\[截断：源输出 9000 字符\]/)
})

test('new schema: reasoning summary_text arrays flatten to a string', async () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: 'hi' }]),
    reason('T2', [{ type: 'summary_text', text: 'think step one' }]),
    msg('T3', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: 'ok' }]),
  ]
  const file = nextFile('reason-arr'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
  const reasoning = messages[1].blocks.filter((b) => b.type === 'reasoning')
  assert.equal(reasoning[0].text, 'think step one')
  const events2 = buildDshEvents(messages, { toolEvents: true })
  const asst = events2.find((e) => e.type === 'assistant/message' && e.data.message.content[0].type === 'reasoning')
  assert.equal(typeof asst.data.message.content[0].text, 'string')
})

test('new schema: reasoning summaries merge into the pending assistant message', async () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '1+1?' }]),
    reason('T2', '先心算，1+1=2'),
    msg('T3', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: '等于 2。' }]),
  ]
  const file = nextFile('reason'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
  assert.equal(messages.length, 3)
  const reasoning = messages[1].blocks.filter((b) => b.type === 'reasoning')
  assert.equal(reasoning.length, 1)
  assert.equal(reasoning[0].text, '先心算，1+1=2')
})

test('new schema: raw image fragments are stripped from user text', async () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [
      { type: 'input_text', text: '# Files mentioned by the user:\n\n## 照片 1.jpg content' },
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/codex-remote-attachments/abc.jpg">' },
      { type: 'input_text', text: '</image>' },
    ]),
    msg('T2', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: '我看到了。' }]),
  ]
  const file = nextFile('img'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
  assert.equal(messages.length, 2)
  const userText = messages[0].blocks.map((b) => b.text).join('\n')
  assert.doesNotMatch(userText, /<image/, 'image fragments must be stripped')
  assert.match(userText, /# Files mentioned by the user:/)
})

test('new schema: an activated skill wrapper is not imported as a user message', async () => {
  // Codex hands `<skill>…SKILL.md…</skill>` to the model as a USER message, so
  // without filtering it the whole skill body shows up in the transcript.
  const skill = [
    '<skill>',
    '<name>zbwx-frontend-plugin-development</name>',
    '<path>D:\\repo\\.agents\\skills\\x\\SKILL.md</path>',
    '---',
    'name: zbwx-frontend-plugin-development',
    'description: implement or review plugins',
    '---',
    '# 开发约定',
    '</skill>',
  ].join('\n')
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: skill }]),
    msg('T2', '2026-08-17T10:00:02Z', 'user', [{ type: 'input_text', text: '真正的问题' }]),
    msg('T3', '2026-08-17T10:00:05Z', 'assistant', [{ type: 'output_text', text: '好的。' }]),
  ]
  const file = nextFile('skill'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0].blocks, [{ type: 'text', text: '真正的问题' }])
  assert.doesNotMatch(JSON.stringify(messages), /SKILL\.md/)
})

test('new schema: codex desktop envelopes are dropped, real content is kept', async () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [
      { type: 'input_text', text: '<codex_internal_context source="goal">\nContinue working toward the objective\n</codex_internal_context>' },
      { type: 'input_text', text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' },
      { type: 'input_text', text: '<in-app-browser-context source="ambient-ui-state">\nstuff\n</in-app-browser-context>' },
      { type: 'input_text', text: '<no retained transcript delta entries>' },
      { type: 'input_text', text: '帮我改一下这个页面' },
    ]),
    msg('T2', '2026-08-17T10:00:05Z', 'user', [
      { type: 'input_text', text: '<send_user_message_question_reply> [{"questionItemId":"q1","answer":"选 A"}] </send_user_message_question_reply>' },
    ]),
    msg('T3', '2026-08-17T10:00:09Z', 'assistant', [
      { type: 'output_text', text: '<proposed_plan>\n1. 改样式\n</proposed_plan>' },
    ]),
  ]
  const file = nextFile('envelopes'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0].blocks, [{ type: 'text', text: '帮我改一下这个页面' }])
  // The user's answer to a question and the assistant's plan are real content.
  assert.match(messages[1].blocks[0].text, /选 A/)
  assert.match(messages[2].blocks[0].text, /proposed_plan/)
})

test('reader: the last thread_goal_updated becomes the session goal', async () => {
  const goalEvent = (status, updatedAt) => ({
    type: 'event_msg',
    timestamp: '2026-08-17T10:00:00Z',
    payload: {
      type: 'thread_goal_updated',
      threadId: 'sess-goal',
      goal: {
        threadId: 'sess-goal',
        objective: '把目标模式带过去',
        status,
        tokensUsed: 1234,
        timeUsedSeconds: 56,
        createdAt: 1787000000,
        updatedAt,
      },
    },
  })
  const file = nextFile('goal')
  write(file, rolloutOf([
    { type: 'session_meta', payload: { id: 'sess-goal', cwd: '/tmp/p', timestamp: '2026-08-17T09:59:00Z' } },
    goalEvent('active', 1787000100),
    goalEvent('paused', 1787000200),
  ]))
  const { header } = await parseCodexSession(file)
  assert.equal(header.goal.status, 'paused', 'the last snapshot wins')
  assert.equal(header.goal.objective, '把目标模式带过去')
  assert.equal(header.goal.createdAt, 1787000000 * 1000, 'codex stores seconds')
  assert.equal(header.goal.updatedAt, 1787000200 * 1000)
  assert.equal(header.goal.tokensUsed, 1234)
})

test('legacy schema: tool_use blocks inside message content still map to tool-calls', async () => {
  const events = [
    msg('T1', '2026-08-17T10:00:01Z', 'user', [{ type: 'input_text', text: '读文件' }]),
    msg('T2', '2026-08-17T10:00:05Z', 'assistant', [
      { type: 'output_text', text: '读取中' },
      { type: 'tool_use', id: 'call-7', name: 'read_file', input: { path: '/tmp/x.txt' } },
    ]),
  ]
  const file = nextFile('legacy'); write(file, rolloutOf(events))
  const { messages } = await parseCodexSession(file)
  const toolCall = messages[1].blocks.find((b) => b.type === 'tool-call')
  assert.ok(toolCall)
  assert.equal(toolCall.id, 'call-7')
  assert.equal(toolCall.name, 'read_file')
  assert.match(toolCall.arguments, /x\.txt/)
})


test('reader: parent_thread_id marks a sub-agent thread header', async () => {
  const meta = { id: 'sess-sub', cwd: '/tmp', timestamp: '2026-08-17T10:00:00.000Z', parent_thread_id: 'sess-main', agent_nickname: 'Einstein' }
  const file = nextFile('subagent-marker')
  write(file, rolloutOf([{ type: 'session_meta', payload: meta }]))
  const { header } = await parseCodexSession(file)
  assert.equal(header.parentThreadId, 'sess-main')
  assert.equal(header.agentNickname, 'Einstein')
  assert.equal(isSubagentThread(header), true)
  assert.equal(isSubagentThread({}), false)
})

test('reader: zstd-compressed rollout (.jsonl.zst) parses like the plain one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-reader-zst-'))
  const plain = join(dir, 'rollout-plain.jsonl')
  const packed = join(dir, 'rollout-packed.jsonl.zst')
  writeFileSync(plain, ROLLOUT)
  writeFileSync(packed, zstdCompressSync(Buffer.from(ROLLOUT, 'utf8')))

  const plainParsed = await parseCodexSession(plain)
  const packedParsed = await parseCodexSession(packed)
  assert.equal(packedParsed.header.id, 'sess-1')
  assert.equal(packedParsed.messages.length, plainParsed.messages.length)
  assert.deepEqual(
    packedParsed.messages.map((m) => m.blocks),
    plainParsed.messages.map((m) => m.blocks),
  )
})

test('reader: multi-frame rollout keeps every frame (codex appends frames)', async () => {
  // node's zstd decoder stops at the end of the first frame, so a rollout that
  // was extended by appending a second frame must still be read to the end.
  const lines = ROLLOUT.split('\n').filter((l) => l.length > 0)
  const head = `${lines.slice(0, 2).join('\n')}\n`
  const tail = `${lines.slice(2).join('\n')}\n`
  const dir = mkdtempSync(join(tmpdir(), 'cx-reader-multi-'))
  const file = join(dir, 'rollout-multi.jsonl.zst')
  writeFileSync(file, Buffer.concat([
    zstdCompressSync(Buffer.from(head, 'utf8')),
    zstdCompressSync(Buffer.from(tail, 'utf8')),
  ]))

  const multi = await parseCodexSession(file)
  const single = await parseCodexSession(write(join(dir, 'rollout-single.jsonl'), ROLLOUT))
  assert.equal(multi.header.id, 'sess-1')
  assert.deepEqual(
    multi.messages.map((m) => m.blocks),
    single.messages.map((m) => m.blocks),
  )
})

// ═══ step/start…step/end pairing: token-meter replay contract.
// Every assistant/message, tool/call and tool/result must sit inside a paired
// step region — @deepseek-ai/dsh-token-meter fails loud on unmarked logs
// ("assistant/message at seq N has no matching step/start event") when a model
// switch forces full-replay pricing.

function assertStepPairing(events) {
  let open = null
  for (const e of events) {
    if (e.type === 'step/start') {
      assert.equal(open, null, `step/start at ${e.seq} while turn ${open?.turn}/step ${open?.step} still open`)
      open = e.data
    } else if (e.type === 'step/end') {
      assert.ok(open, `step/end at ${e.seq} without matching step/start`)
      assert.equal(open.turn, e.data.turn)
      assert.equal(open.step, e.data.step)
      open = null
    } else if (e.type === 'assistant/message' || e.type === 'tool/call' || e.type === 'tool/result') {
      assert.ok(open, `${e.type} at ${e.seq} outside a step/start…step/end region`)
      assert.equal(open.turn, e.data.turn, `${e.type} at ${e.seq} in wrong turn`)
      assert.equal(open.step, e.data.step, `${e.type} at ${e.seq} in wrong step`)
    }
  }
  assert.equal(open, null, 'log ends with an open step')
}

test('convert: every assistant message and tool event sits inside paired step markers', async () => {
  const events = buildDshEvents(
    [
      { role: 'user', time: 1000, blocks: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', time: 1100, provider: 'codex', model: 'm1', blocks: [{ type: 'text', text: 'a1' }] },
      { role: 'user', time: 1200, blocks: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', time: 1300, provider: 'codex', model: 'm1', blocks: [
        { type: 'tool-call', id: 'call-1', name: 'shell', arguments: '{}' },
        { type: 'text', text: 'working' },
      ] },
      { role: 'assistant', time: 1400, provider: 'codex', model: 'm1', blocks: [{ type: 'text', text: 'a2' }] },
    ],
    { toolEvents: true, titlePinned: true },
  )
  assertStepPairing(events)
})

test('convert: consecutive assistant messages get one step each, closed at turn boundaries', async () => {
  const events = buildDshEvents(
    [
      { role: 'user', time: 10, blocks: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', time: 20, blocks: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', time: 30, blocks: [{ type: 'text', text: 'two' }] },
      { role: 'user', time: 40, blocks: [{ type: 'text', text: 'again' }] },
      { role: 'assistant', time: 50, blocks: [{ type: 'text', text: 'three' }] },
    ],
    { toolEvents: true },
  )
  assertStepPairing(events)
  // turn/end must never be preceded by an unclosed step: verify ordering directly
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'turn/end') {
      assert.equal(events[i - 1].type, 'step/end', `turn/end at index ${i} must follow step/end`)
    }
  }
})


test('function_call: preserves arguments and prefers them over legacy input', async () => {
  const args = '{"text":"standard function argument"}'
  const file = nextFile('function-arguments')
  write(file, rolloutOf([
    { type: 'response_item', timestamp: '2026-08-17T10:00:01Z', payload: {
      type: 'function_call', call_id: 'function-1', name: 'fixture_echo', arguments: args, input: 'wrong legacy input',
    } },
    { type: 'response_item', timestamp: '2026-08-17T10:00:02Z', payload: {
      type: 'function_call_output', call_id: 'function-1', output: 'function result',
    } },
  ]))
  const { messages } = await parseCodexSession(file)
  const blocks = messages.flatMap(m => m.blocks)
  assert.equal(blocks.find(b => b.type === 'tool-call').arguments, args)
  assert.deepEqual(blocks.find(b => b.type === 'tool-result').content, [{ type: 'text', text: 'function result' }])
})

test('tool inputs: function arguments objects and empty strings; custom calls keep input', async () => {
  const file = nextFile('tool-input-variants')
  write(file, rolloutOf([
    ...[
      { type: 'function_call', call_id: 'object', name: 'echo', arguments: { text: 'object' } },
      { type: 'function_call', call_id: 'empty', name: 'echo', arguments: '', input: 'must not replace empty' },
      { type: 'function_call', call_id: 'legacy', name: 'echo', input: 'legacy input' },
      { type: 'custom_tool_call', call_id: 'custom', name: 'patch', input: 'custom input', arguments: 'wrong' },
    ].map(payload => ({ type: 'response_item', timestamp: '2026-08-17T10:00:01Z', payload })),
  ]))
  const calls = (await parseCodexSession(file)).messages.flatMap(m => m.blocks).filter(b => b.type === 'tool-call')
  assert.deepEqual(calls.map(b => b.arguments), ['{"text":"object"}', '', 'legacy input', 'custom input'])
})
