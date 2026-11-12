/**
 * convert.mjs event-ordering regression tests (issue #2).
 *
 * Regresses the "format v2 surface before first step cannot acquire a system
 * head without changing chronology" failure: DSH's persistence restore runs
 * the imported log through the format v0→v1→v2→v3 migration chain, and that
 * chain only acquires its "system head" at the first `step/start`. In v2→v3,
 * any surface event (user/message / assistant/message / tool/result /
 * system/message) appearing BEFORE the first step/start is rejected, so
 * sessions imported with the old converter (turn/start → user/message with no
 * step region) fail to open on DSH 0.9.0+.
 *
 * Our converter must therefore emit `step/start` before the first surface
 * event of each turn (matching the native agent-loop), so every imported log
 * survives the migration chain and becomes a resumable v3 session.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDshEvents } from '../lib/convert.mjs'

const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message'])

/** Assert: every surface event is inside an open step region. */
function assertSurfaceInsideSteps(events) {
  let open = null
  const violations = []
  for (const e of events) {
    if (e.type === 'step/start') {
      open = e.data
    } else if (e.type === 'step/end') {
      if (open === null) violations.push(`stray step/end ${e.data?.step}`)
      open = null
    } else if (SURFACE.has(e.type)) {
      if (open === null) violations.push(`${e.type} at ${e.seq} outside a step region`)
    }
  }
  assert.deepEqual(violations, [], `step ordering broken: ${violations.join('; ')}`)
}

/** Assert helper: surface events never precede the first step/start. */
function assertFirstStepBeforeFirstSurface(events) {
  const firstStep = events.findIndex((e) => e.type === 'step/start')
  const firstSurface = events.findIndex((e) => SURFACE.has(e.type))
  assert.ok(firstStep >= 0, 'a step/start must exist')
  assert.ok(
    firstSurface === -1 || firstStep < firstSurface,
    `first surface (${firstSurface}) must not precede first step/start (${firstStep})`,
  )
}

const mkUser = (time, text) => ({ role: 'user', time, provider: 'codex', model: 'unknown', blocks: [{ type: 'text', text }] })
const mkAsst = (time, blocks) => ({ role: 'assistant', time, provider: 'codex', model: 'unknown', blocks })

test('user-only turn opens a step region before its user/message', () => {
  const events = buildDshEvents([mkUser(1000, 'q')], { toolEvents: true })
  assertFirstStepBeforeFirstSurface(events)
  assertSurfaceInsideSteps(events)
  // turn/start → step/start → user/message
  const kinds = events.map((e) => e.type)
  const iStep = kinds.indexOf('step/start')
  const iUser = kinds.indexOf('user/message')
  assert.ok(iStep === 1, `step/start is the second event (got index ${iStep})`)
  assert.ok(iUser === 2, `user/message follows step/start (got index ${iUser})`)
})

test('user + assistant + tool turn keeps surface inside one step then opens new step', () => {
  const events = buildDshEvents([
    mkUser(1000, 'q'),
    mkAsst(2000, [{ type: 'tool-call', id: 'c1', name: 'exec', arguments: '{}' }]),
    mkAsst(2000, [{ type: 'text', text: 'answer' }]),
  ], { toolEvents: true })
  assertFirstStepBeforeFirstSurface(events)
  assertSurfaceInsideSteps(events)
  // user & first assistant share step 1; second assistant gets its own step
  const asstSteps = events
    .filter((e) => e.type === 'assistant/message')
    .map((e) => e.data.step)
  assert.deepEqual(asstSteps, [1, 2], 'first assistant reuses step 1, next advances')
})

test('assistant-first turn still opens a step before its first surface', () => {
  const events = buildDshEvents([mkAsst(1000, [{ type: 'text', text: 'direct answer' }])], { toolEvents: true })
  assertFirstStepBeforeFirstSurface(events)
  assertSurfaceInsideSteps(events)
})

test('multiple consecutive user turns each open their own leading step', () => {
  const events = buildDshEvents([
    mkUser(1000, 'first'),
    mkUser(2000, 'second'),
    mkUser(3000, 'third'),
  ], { toolEvents: true })
  assertFirstStepBeforeFirstSurface(events)
  assertSurfaceInsideSteps(events)
  // each user/message preceded by a step/start for that turn
  const kinds = events.map((e) => e.type)
  const starts = kinds
    .map((t, i) => (t === 'user/message' ? i : -1))
    .filter((i) => i >= 0)
  for (const i of starts) {
    assert.equal(kinds[i - 1], 'step/start', `user/message at ${i} preceded by step/start`)
  }
})

test('convert: a Codex question-reply envelope becomes a rendered answer card', () => {
  const item = {
    questionItemId: '["request_user_input_async","call_4326ec8a195049adb5882d6e601f5425",0]',
    question: '是否允许 ai-service 持有专用 manage_channels 凭据？',
    answer: '允许专用 manage_channels 凭据（推荐）',
  }
  // Codex stores the answer as markup; DSH only renders a card when the message
  // says it is a question reply, so the importer must translate it.
  const envelope = '<send_user_message_question_reply>\n' + JSON.stringify([item]) + '\n</send_user_message_question_reply>\n'
  const events = buildDshEvents([
    { role: 'user', time: 1000, blocks: [{ type: 'text', text: envelope }] },
    { role: 'assistant', time: 2000, blocks: [{ type: 'text', text: '收到' }] },
  ], { toolEvents: true })

  const user = events.find((e) => e.type === 'user/message')
  assert.equal(user.surfaceOp, 'append', 'the reply card reads append-origin messages')
  assert.deepEqual(user.data.source, {
    kind: 'user-question-reply',
    callId: 'call_4326ec8a195049adb5882d6e601f5425',
    outcome: 'answered',
  })
  const payload = JSON.parse(user.data.content[0].text)
  assert.equal(payload.questions[0].question, item.question)
  assert.deepEqual(payload.answers[0].selected, [item.answer])
  assert.ok(!JSON.stringify(user.data.content).includes('send_user_message_question_reply'), 'no raw markup left')
  assertSurfaceInsideSteps(events)
})

test('convert: a skipped question answer and plain text keep their own shapes', () => {
  const skipped = {
    questionItemId: '["request_user_input_async","call_skip",0]',
    question: '要发布到哪个环境？',
    answer: '',
  }
  const events = buildDshEvents([
    { role: 'user', time: 1000, blocks: [{ type: 'text', text: '<send_user_message_question_reply>' + JSON.stringify([skipped]) + '</send_user_message_question_reply>' }] },
    { role: 'user', time: 2000, blocks: [{ type: 'text', text: '普通提问' }] },
  ], { toolEvents: true })

  const replies = events.filter((e) => e.type === 'user/message')
  assert.equal(replies[0].data.source.kind, 'user-question-reply')
  assert.deepEqual(JSON.parse(replies[0].data.content[0].text).answers[0].selected, [], 'a skipped answer selects nothing')
  assert.deepEqual(replies[1].data.source, { kind: 'user' }, 'plain text stays a normal user message')
  assert.equal(replies[1].data.content[0].text, '普通提问')
})
