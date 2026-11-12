/**
 * Conversation → DSH session-log conversion.
 *
 * Both source readers normalize to one message shape:
 *   { role: 'user'|'assistant', time: ms, provider?, model?, blocks: [...] }
 * where blocks are already mapped to DSH content blocks
 * (text / reasoning / tool-call). This module folds the message stream into a
 * balanced DSH event log: each user message opens a turn (turn/start +
 * user/message), following assistant messages join it with an increasing step
 * (assistant/message), and the turn closes with turn/end {kind:'completed'}.
 *
 * With `toolEvents: true` (the default for imports), an assistant message's
 * tool-call blocks additionally emit paired `tool/call` + `tool/result`
 * events: `tool/call` drives the trajectory UI, and the placeholder
 * `tool/result` keeps resumed model requests API-legal (every `tool_calls`
 * answered by a `tool` message, as OpenAI-compatible providers require).
 * The tool-call block stays in the assistant content so the call itself is
 * model-visible.
 */

/** Placeholder text for tool results the source tool never recorded. */
export const TOOL_RESULT_PLACEHOLDER = '[工具结果未记录：源工具不保存调用结果，仅保留调用信息]'

/** Codex wraps a question answer in this envelope; DSH has no renderer for it. */
const QUESTION_REPLY_ENVELOPE = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/u

/**
 * Translate a Codex question-reply message into the payload DSH's user-questions
 * UI reads back. Codex stores the answer as a bare envelope
 * (`<send_user_message_question_reply>[{questionItemId, question, answer}]`),
 * which DSH would print as literal markup; a `user/message` carrying
 * `source.kind = 'user-question-reply'` and the `{questions, answers}` JSON is
 * rendered as an answered-question card instead.
 * @param blocks - the normalized content blocks of one user message
 * @returns {{callId: string, content: Array<object>}|undefined} the card payload
 */
export function questionReplyPayload(blocks) {
  if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== 'text') return undefined
  const matched = QUESTION_REPLY_ENVELOPE.exec(typeof blocks[0].text === 'string' ? blocks[0].text : '')
  if (matched === null) return undefined
  let items
  try {
    items = JSON.parse(matched[1])
  } catch {
    return undefined
  }
  if (!Array.isArray(items) || items.length === 0) return undefined
  const questions = []
  const answers = []
  let callId
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item === null || typeof item !== 'object') return undefined
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    if (question.length === 0) continue
    const id = typeof item.questionItemId === 'string' && item.questionItemId.length > 0
      ? item.questionItemId
      : `codex-question-${i}`
    questions.push({ id, question })
    const answer = typeof item.answer === 'string' ? item.answer.trim() : ''
    answers.push({ id, selected: answer.length > 0 ? [answer] : [] })
    if (callId === undefined) {
      // The item id is `["request_user_input_async","call_…",0]`; keep the call id
      // so the card can be paired with its tool call when one was imported.
      try {
        const parsed = JSON.parse(id)
        if (Array.isArray(parsed) && typeof parsed[1] === 'string' && parsed[1].length > 0) callId = parsed[1]
      } catch { /* not the composite id — fall back below */ }
    }
  }
  if (questions.length === 0) return undefined
  return {
    callId: callId ?? 'codex-question',
    content: [{ type: 'text', text: JSON.stringify({ questions, answers }) }],
  }
}

/**
 * Temporarily downgrade `user-question-reply` sources to `user` before the
 * v0→v4 migration chain runs.
 *
 * The chain's v2→v3 stage validates `source.kind` against a closed set that does
 * not contain `user-question-reply` ("cannot safely transform unclassified
 * message source"), while the current (v4) write gate does accept it — the
 * user-questions projection reads exactly that kind. So the reply is written
 * through the migration as a plain user message and the kind is restored on the
 * migrated events.
 * @param events - the v0 event list about to be migrated (mutated in place)
 * @returns {Map<string, object>} message id → original reply source
 */
export function hideReplySources(events) {
  const hidden = new Map()
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'user-question-reply' || typeof event.data?.id !== 'string') continue
    hidden.set(event.data.id, source)
    event.data.source = { kind: 'user' }
  }
  return hidden
}

/**
 * Put the `user-question-reply` kinds back on the migrated events.
 * @param events - current-format events (mutated in place)
 * @param hidden - the map returned by {@link hideReplySources}
 * @returns {number} how many sources were restored
 */
export function restoreReplySources(events, hidden) {
  if (!(hidden instanceof Map) || hidden.size === 0) return 0
  let restored = 0
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue
    const source = hidden.get(event.data?.id)
    if (source === undefined) continue
    event.data.source = source
    restored += 1
  }
  return restored
}

/**
 * Fold normalized messages into a balanced DSH event list (seq 0..n-1).
 * @param messages - normalized message stream in chronological order.
 * @param options.toolEvents - emit paired tool/call + tool/result events for
 *   tool-call blocks (default false; importers enable it).
 * @returns the balanced event list.
 */
export function buildDshEvents(messages, options = {}) {
  const events = []
  let turn = 0
  let step = 0
  let stepHasAssistant = false
  let openTurn = false
  let lastTime = 0
  let firstUserSeq

  /** Non-decreasing timestamps keep the log well-formed for replay. */
  const atLeast = (time) => {
    if (time > lastTime) lastTime = time
    return lastTime
  }

  const push = (type, time, data, surfaceOp) => {
    events.push({ type, time: atLeast(time), data, ...(surfaceOp ? { surfaceOp } : {}) })
  }

  // step/start…step/end 配对标记：token meter（@deepseek-ai/dsh-token-meter）
  // 要求每个 assistant/message、tool/call、tool/result 都必须落在配对的
  // step 区间内，换模型压缩时的全量重放定价会对缺标记的日志抛出
  // "assistant/message at seq N has no matching step/start event"。原生会话由
  // agent-loop 写这些标记；导入器必须自己补齐等价序列。
  let openStep = null // { turn, step } | null
  const openStepFor = (turn, step, time) => {
    if (openStep !== null && (openStep.turn !== turn || openStep.step !== step)) closeOpenStep(time)
    if (openStep === null) {
      push('step/start', time, { turn, step })
      openStep = { turn, step }
    }
  }
  const closeOpenStep = (time) => {
    if (openStep === null) return
    push('step/end', time, { turn: openStep.turn, step: openStep.step })
    openStep = null
  }

  for (const message of messages) {
    if (message.role === 'user') {
      // Pure control-block messages (recommended_plugins / AGENTS.md / env
      // context) strip to zero blocks: skip them entirely so they open no
      // empty turn and never seed the derived title.
      if (message.blocks.length === 0) continue
      if (openTurn) {
        closeOpenStep(message.time)
        push('turn/end', message.time, { turn, reason: { kind: 'completed' } })
        openTurn = false
      }
      turn += 1
      step = 1
      stepHasAssistant = false
      openTurn = true
      push('turn/start', message.time, { turn })
      // 每个 turn 必须先开一个 step 区，才能承接后面的 surface 事件
      // （user/message / assistant/message / tool/result）。dsl 持久化读入时的
      // format v2→v3 迁移要求：任何 surface 事件出现在第一个 step/start 之前，
      // 会因“无法在不改变时间顺序的情况下获取 system head”而拒绝导入。
      // 原生 agent-loop 是先 step/start 再写 surface；导入器必须复用同样的
      // “step/start 前置于首条 surface 事件”的序列，否则 DSH 0.9.0 已导入会话
      // 无法打开（issue #2）。
      openStepFor(turn, step, message.time)
      if (message.blocks.length > 0) {
        // A Codex question answer is recorded as markup; DSH renders it as an
        // answered-question card only when the message says so in its source.
        const reply = questionReplyPayload(message.blocks)
        push('user/message', message.time, {
          role: 'user',
          source: reply === undefined
            ? { kind: 'user' }
            : { kind: 'user-question-reply', callId: reply.callId, outcome: 'answered' },
          content: reply === undefined ? message.blocks : reply.content,
          id: randomId(),
        }, 'append')
        if (firstUserSeq === undefined) firstUserSeq = events.length - 1
      }
    } else {
      if (!openTurn) {
        turn += 1
        step = 1
        stepHasAssistant = false
        openTurn = true
        push('turn/start', message.time, { turn })
        // 首个消息是 assistant（无前置用户消息）时也要先开 step 区，
        // 才能承接其后的 surface 事件。
        openStepFor(turn, step, message.time)
      }
      // Paired tool-result blocks (from codex custom_tool_call_output) are
      // consumed by the tool/result surface event, never written into the
      // assistant message content itself.
      const resultByCall = new Map()
      const contentBlocks = []
      for (const block of message.blocks) {
        if (block.type === 'tool-result') resultByCall.set(block.toolCallId, block)
        else contentBlocks.push(block)
      }
      for (const block of contentBlocks) {
        if (block.type === 'reasoning' && typeof block.text !== 'string') {
          const v = block.text
          if (Array.isArray(v)) {
            block.text = v.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n')
          } else if (v && typeof v.text === 'string') {
            block.text = v.text
          } else {
            block.text = ''
          }
        }
      }
      if (contentBlocks.length === 0) continue
      // 若当前 turn 已有 open step 区且尚未被任何 assistant 占用（即刚由用户
      // 消息开启的 step 1），则首个 assistant 复用该 step——与原生 agent-loop
      // 行为一致（首条 user/message 与 assistant/message 共享 step 1）。否则
      // 递增开启新 step，保证同一 turn 内多条 assistant 各自成步。
      const regionMatches = openStep !== null && openStep.turn === turn && openStep.step === step
      if (!regionMatches || stepHasAssistant) {
        step += 1
        openStepFor(turn, step, message.time)
      }
      stepHasAssistant = true
      push('assistant/message', message.time, {
        turn,
        step,
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: message.provider ?? 'imported', model: message.model ?? 'unknown' },
          content: contentBlocks,
          id: randomId(),
        },
      }, 'append')
      if (options.toolEvents === true) {
        for (const block of contentBlocks) {
          if (block.type !== 'tool-call') continue
          // tool/call is log-only: trajectory UI reads it, model requests do not.
          push('tool/call', message.time, {
            turn,
            step,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
          })
          // tool/result is surface: it derives the user-role tool message that
          // answers the assistant's tool_calls in resumed requests. Prefer the
          // real codex output when the reader captured one; fall back to the
          // placeholder so the request stays API-legal.
          const real = resultByCall.get(block.id)
          const result = real ?? {
            content: [{ type: 'text', text: TOOL_RESULT_PLACEHOLDER }],
            isError: false,
          }
          push('tool/result', message.time, {
            turn,
            step,
            message: {
              role: 'user',
              source: { kind: 'tool', callId: block.id },
              content: [{ type: 'tool-result', toolCallId: block.id, content: result.content, isError: result.isError }],
              id: randomId(),
            },
          }, 'append')
        }
      }
    }
  }
  if (openTurn) {
    closeOpenStep(lastTime)
    push('turn/end', lastTime, { turn, reason: { kind: 'completed' } })
  }
  // 继承源会话标题：latest-wins 的 session/title 事件。默认 fallback 源
  // （继续对话后 LLM 标题生成器接管更新）；`titlePinned` 时用 user 源
  // 固定标题（自动生成停止调度，来源标识与标题持久保留）。
  // V4 relationship rule：user 源标题是独立文本，messageSeqs 必须为空；
  // fallback 源标题必须引用一条更早的 user/message 事件。
  if (options.title !== undefined && options.title.length > 0) {
    const source = options.titlePinned === true ? { kind: 'user' } : { kind: 'fallback' }
    const messageSeqs = options.titlePinned === true ? [] : (firstUserSeq !== undefined ? [firstUserSeq] : [])
    if (messageSeqs.length > 0 || options.titlePinned === true) {
      push('session/title', lastTime, { title: options.title, messageSeqs, source })
    }
  }
  return events
}

/**
 * 从源标题或首条用户消息推导导入标题（规范化 + 截断 + 来源前缀）。
 * @param sourceTitle - 源工具的标题（opencode.title / claude ai-title），可缺省。
 * @param messages - 归一化消息流。
 * @param sourceName - 来源工具名（pi / opencode / codex / claude-code），
 *   拼成 `[来源] 标题` 前缀。
 * @returns 规范化标题，无可用文本时 undefined。
 */
export function deriveImportTitle(sourceTitle, messages, sourceName) {
  const clean = (text) => text.replace(/\s+/gu, ' ').trim().slice(0, 80)
  let title
  if (typeof sourceTitle === 'string') {
    title = clean(sourceTitle)
    // 忽略无意义的模板标题（如 opencode 的 "New session - …"）。
    if (title.length === 0 || /^new session[- ]/iu.test(title)) title = undefined
  }
  if (title === undefined) {
    const firstUser = messages.find(message =>
      message.role === 'user' && message.blocks.some(block => block.type === 'text'))
    if (firstUser !== undefined) {
      const text = firstUser.blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(' ')
        .trim()
      if (text.length > 0) title = clean(text)
    }
  }
  if (title === undefined) return undefined
  // 来源前缀：`[pi] 标题` —— 让会话列表一眼可见会话来自哪个工具。
  return typeof sourceName === 'string' && sourceName.length > 0
    ? `[${sourceName}] ${title}`
    : title
}

/** Fresh stable message identity (DSH MessageId is a branded uuid string). */
function randomId() {
  return crypto.randomUUID()
}
