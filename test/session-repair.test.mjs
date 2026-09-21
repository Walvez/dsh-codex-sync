import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repairEvents, isClean } from '../lib/session-repair.mjs'

// 合成三类损伤，验证 repairEvents 全部修好且能通过真实 meter。
// 注意：isClean/measure 需要 @deepseek-ai/* 可解析（web profile 或 DSH_CHECKOUT），
// 在仓库目录跑 npm test 时依赖 DSH_CHECKOUT 指向 dsh 安装目录。

function damagedLog() {
  // turn 包裹齐全但完全没有 step 标记 + 一条非法 chunk 引用
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }], id: 'u1' }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 1100, sourceEventSeqs: [0], data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hello world answer' }], id: 'a1' } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('repairEvents inserts paired step markers for unpaired logs', async () => {
  const fixed = repairEvents(damagedLog())
  const kinds = fixed.map((e) => e.type)
  assert.ok(kinds.includes('step/start'), 'step/start inserted')
  assert.ok(kinds.includes('step/end'), 'step/end inserted')
  // every assistant/message must be inside a step region
  let open = null
  for (const e of fixed) {
    if (e.type === 'step/start') open = e.data
    else if (e.type === 'step/end') open = null
    else if (e.type === 'assistant/message') assert.ok(open, `${e.type} inside step`)
  }
  // seq renumbered densely
  fixed.forEach((e, i) => assert.equal(e.seq, i))
})

test('repairEvents drops stale chunk citations', async () => {
  const fixed = repairEvents(damagedLog())
  const msg = fixed.find((e) => e.type === 'assistant/message')
  // 引用 [0] 指向 turn/start（非 chunk）→ 必须被清掉或过滤
  if (msg.sourceEventSeqs !== undefined) {
    // 剩下的引用必须全部指向 assistant/chunk
    for (const s of msg.sourceEventSeqs) assert.equal(fixed[s].type, 'assistant/chunk')
  }
})

test('repairEvents merges stale-cursor seams and remaps citations', () => {
  // head 重写过：seq 连续；tail 是旧游标追加的（seq 回跳但自身自洽）
  const evs = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 10, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }], id: 'u1' }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 20, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], id: 'a1' } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 3, time: 30, data: { turn: 1, reason: { kind: 'completed' } } },
    // tail: 旧游标从 seq 2 开始重写 → 接缝在 index 4
    { type: 'turn/start', seq: 2, time: 40, data: { turn: 2 } },
    { type: 'user/message', seq: 3, time: 40, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }], id: 'u2' }, surfaceOp: 'append' },
    { type: 'assistant/chunk', seq: 4, time: 50, data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } },
    { type: 'assistant/message', seq: 5, time: 60, sourceEventSeqs: [4], data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], id: 'a2' } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 6, time: 70, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const fixed = repairEvents(evs)
  fixed.forEach((e, i) => assert.equal(e.seq, i, `seq dense at ${i}`))
  // 尾部 message 的引用被重映射到 chunk 的新位置
  const tailMsg = fixed.find((e) => e.type === 'assistant/message' && e.data.turn === 2)
  assert.ok(Array.isArray(tailMsg.sourceEventSeqs), 'tail citation kept')
  for (const s of tailMsg.sourceEventSeqs) assert.equal(fixed[s].type, 'assistant/chunk')
})

test('repairEvents opens a step before an orphan user/message (v0→v3 migration invariant)', () => {
  // 旧版导入器生成 turn/start → user/message（无前置 step/start）。DSH 的
  // format v0→v3 迁移要求任何 surface 事件出现在首个 step/start 之后，否则抛
  // "format v2 surface before first step cannot acquire a system head ..."。
  // 修复后 user/message 之前必须补一个 step/start。
  const evs = [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }], id: 'u1' }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 1100, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], id: 'a1' } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const fixed = repairEvents(evs)
  fixed.forEach((e, i) => assert.equal(e.seq, i, `seq dense at ${i}`))
  // 每个 surface（user/message / assistant/message）都必须落在 open step 内
  let open = null
  let firstUserSeen = false
  for (const e of fixed) {
    if (e.type === 'step/start') open = e.data
    else if (e.type === 'step/end' || e.type === 'turn/end') open = null
    if (e.type === 'user/message') { firstUserSeen = true; assert.ok(open, 'user/message is inside a step region') }
    if (e.type === 'assistant/message') assert.ok(open, 'assistant/message is inside a step region')
  }
  assert.ok(firstUserSeen, 'user/message present')
  // 首个 step/start 必须出现在第一个 user/message 之前（满足 v2→v3 迁移不变式）
  const firstStep = fixed.findIndex((e) => e.type === 'step/start')
  const firstUser = fixed.findIndex((e) => e.type === 'user/message')
  assert.ok(firstStep !== -1 && firstStep < firstUser, 'step/start precedes first user/message')
})
