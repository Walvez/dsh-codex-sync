/**
 * codex (OpenAI Codex CLI) session reader.
 *
 * Sessions live at ~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl.
 * Each line is a rollout event; the conversation is carried by:
 *   session_meta  { id, cwd, timestamp }
 *   response_item — the model-visible items:
 *       message                { role, content: [{type, text|…}] }  (user/assistant text)
 *       reasoning              { summary? | encrypted content }      (thinking trace)
 *       custom_tool_call       { call_id, name, input }  (freeform tool invocation)
 *       custom_tool_call_output{ call_id, output, is_error } (its real result)
 *   event_msg     { type: 'user_message', message }
 *
 * Current codex versions record tool calls as standalone `custom_tool_call` /
 * `custom_tool_call_output` response_items (paired by call_id), NOT as
 * `tool_use` content blocks inside `message` — so both schemas are supported.
 * The standalone events are folded into a pending assistant message that is
 * flushed before the next `message`, keeping the tool call + its real result
 * (capped to TOOL_RESULT_MAX chars) with the turn they belong to.
 *
 * System-injected text blocks codex puts into user/assistant content (their
 * whole trimmed text starts with a known opener) are dropped:
 * `<environment_context>`, `<recommended_plugins>`, the
 * `# AGENTS.md instructions` wrapper, and raw `<image …>` / `</image>`
 * fragments whose target attachment files are usually long gone.
 */

import { closeSync, createReadStream, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { join } from 'node:path'
import { decompressFrames } from './zstd-frame.mjs'

/** Default codex session root. */
export function defaultCodexRoot() {
  return join(process.env.HOME ?? '', '.codex', 'sessions')
}

/** Cap for real tool-result output carried into imported sessions. */
export const TOOL_RESULT_MAX = 4000

/** Enumerate rollout files under the date-based directory tree. */
export function listCodexSessions(root) {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst')) && entry.name.startsWith('rollout-')) files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

/**
 * System-injected text blocks codex puts into user/assistant content; never
 * conversation. `<environment_context>` (cwd/date/shell…), `<recommended_plugins>`
 * (plugin catalog blurb) and the `# AGENTS.md instructions` wrapper are codex
 * CLI/desktop injections; the rest are provider plumbing. Blocks whose whole
 * trimmed text starts with one of these openers are dropped by
 * `normalizeContentBlock`.
 *
 * Two families matter most in practice:
 *   `<skill>`  how codex hands an ACTIVATED SKILL to the model — the whole
 *              SKILL.md (frontmatter + body) arrives as a USER message, which
 *              used to show up verbatim in the imported transcript.
 *   `<external_codex_apps_*>` / `<codex_internal_context>` / `<heartbeat>` / …
 *              desktop envelopes carrying JSON (opened pages, streaming block
 *              edits, goal continuations); they are tooling, not chat.
 * `<proposed_plan>` and `<send_user_message_question_reply>` are deliberately
 * KEPT: the first is real content, the second carries the user's own answer.
 */
const SYSTEM_BLOCK = /^<(environment_context|permissions instructions|turn_aborted|request_id|model|end_of_conversation|turn_id|recommended_plugins|skills_instructions|apps_instructions|plugins_instructions|collaboration_mode|multi_agent_mode|app-context|citation_entries|INSTRUCTIONS|skill|skills|guardian_tool_descriptions|codex_internal_context|node_repl_review_evidence|in-app-browser-context|external_browser_tabs|external_codex_apps_[a-z0-9_]*|heartbeat)(?:\s[^>]*)?>/u

/**
 * A codex placeholder that arrives as a user message when the incremental
 * transcript delta is empty (`<no retained transcript delta entries>`).
 */
const TRANSCRIPT_PLACEHOLDER = /^<no retained transcript delta entries>/u

/** AGENTS.md instructions wrapper (codex desktop): `# AGENTS.md instructions\n\n<INSTRUCTIONS>…`. */
const AGENTS_MD_BLOCK = /^# AGENTS\.md instructions/u

/** Raw image fragments (`<image name=… path=…>` / `</image>`) as standalone blocks. */
const IMAGE_BLOCK = /^\s*<image\b[^>]*>\s*$/u
const IMAGE_CLOSE = /^\s*<\/image>\s*$/u

/** Cap a tool-result payload to TOOL_RESULT_MAX chars with a truncation note. */
export function capToolResult(text) {
  if (text.length <= TOOL_RESULT_MAX) return text
  return `${text.slice(0, TOOL_RESULT_MAX)}\n…[截断：源输出 ${text.length} 字符]`
}

/**
 * True when a session_meta header marks a sub-agent thread: codex spawns each
 * sub-agent as its own rollout with a parent_thread_id (and typically an
 * agent_nickname like "Socrates"). These are ~half of all rollouts in real
 * usage; imports filter them out by default so the session list stays clean.
 */
export function isSubagentThread(header) {
  // Guardian reviews are not sub-agents; don't filter them out.
  if (header?.threadSource === 'guardian_review') return false
  return Boolean(header?.parentThreadId)
}

/**
 * True when the path is a zstd-compressed codex rollout (`rollout-….jsonl.zst`).
 * Newer codex builds compress rollouts; the payload is a plain jsonl stream
 * inside a standard zstd frame, so `node:zlib`'s zstd decoder can inflate it.
 */
export function isCompressedSession(file) {
  return typeof file === 'string' && file.endsWith('.zst')
}

/** Zstd frame magic (`0xFD2FB528`, little-endian on disk). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Count the zstd frames in a file without reading all of it.
 *
 * A rollout is normally ONE frame, but codex appends to a rollout by writing a
 * new frame, and node's zstd decoder stops at the end of the first frame (it
 * does not stitch concatenated frames). Counting lets us pick a streamed decode
 * for the normal case and a frame-by-frame decode when the tail would otherwise
 * be dropped.
 * @param {string} file
 */
function countFrames(file) {
  const chunkSize = 1 << 20
  const chunk = Buffer.allocUnsafe(chunkSize + ZSTD_MAGIC.length)
  const fd = openSync(file, 'r')
  let count = 0
  let carry = 0
  try {
    for (;;) {
      const read = readSync(fd, chunk, carry, chunkSize, null)
      if (read <= 0) break
      const view = chunk.subarray(0, carry + read)
      let at = view.indexOf(ZSTD_MAGIC)
      while (at !== -1) {
        count += 1
        at = view.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
      }
      // Keep the last few bytes so a magic split across chunks is still found.
      carry = Math.min(ZSTD_MAGIC.length - 1, view.length)
      view.copy(chunk, 0, view.length - carry)
    }
  } finally {
    closeSync(fd)
  }
  return count
}

/**
 * Inflate a rollout into a readable text stream.
 *
 * Single-frame files (the norm) are streamed, so a big rollout never has to sit
 * in memory as a decoded string. Multi-frame files are decoded frame by frame
 * because the streaming decoder would drop everything after the first frame.
 */
function openCodexSessionStream(file) {
  if (!isCompressedSession(file)) return createReadStream(file)
  if (countFrames(file) <= 1) return createReadStream(file).pipe(createZstdDecompress())
  return Readable.from([decompressFrames(readFileSync(file))])
}

/**
 * Read session file asynchronously using stream.
 * @param {string} file
 */
export async function parseCodexSession(file) {
  const header = { id: undefined, createdAt: undefined, cwd: undefined }
  const messages = []
  let pending = []
  let pendingTime = 0
  let lastUserText = ''

  const flushPending = () => {
    if (pending.length === 0) return
    messages.push({ role: 'assistant', time: pendingTime, provider: 'codex', model: undefined, blocks: pending })
    pending = []
  }

  const rl = createInterface({
    input: openCodexSessionStream(file),
    crlfDelay: Infinity
  })

  for await (const rawLine of rl) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const parsedTime = Date.parse(event.timestamp)
    const at = Number.isNaN(parsedTime) ? Date.now() : parsedTime

    if (event.type === 'session_meta') {
      const payload = event.payload ?? {}
      header.id = payload.id
      header.cwd = payload.cwd
      if (payload.parent_thread_id !== undefined) header.parentThreadId = payload.parent_thread_id
      if (payload.agent_nickname !== undefined) header.agentNickname = payload.agent_nickname
      if (payload.thread_source !== undefined) header.threadSource = payload.thread_source
      // Codex Desktop's side chat: the conversation is forked into its own
      // thread (`forked_from_id`, or a `history_base` naming another thread) and
      // repeats the parent's name and history prefix. Paginated continuation
      // segments carry `history_base` too, but pointing at THEMSELVES, so the
      // self-reference is what separates a fork from a segment.
      const forkedFrom = typeof payload.forked_from_id === 'string'
        ? payload.forked_from_id
        : (typeof payload.history_base?.thread_id === 'string' ? payload.history_base.thread_id : undefined)
      if (typeof forkedFrom === 'string' && forkedFrom.length > 0 && forkedFrom !== payload.id) {
        header.forkedFromId = forkedFrom
      }
      const created = Date.parse(payload.timestamp)
      header.createdAt = Number.isNaN(created) ? undefined : created
      continue
    }
    if (event.type !== 'response_item') {
      // Codex keeps goal mode in `event_msg` snapshots: every goal mutation
      // appends `thread_goal_updated` with the WHOLE goal, so the last one wins.
      if (event.type === 'event_msg' && event.payload?.type === 'thread_goal_updated') {
        const goal = event.payload.goal
        if (goal && typeof goal.objective === 'string' && goal.objective.trim().length > 0) {
          header.goal = {
            objective: goal.objective.trim(),
            status: typeof goal.status === 'string' ? goal.status : 'active',
            createdAt: typeof goal.createdAt === 'number' ? goal.createdAt * 1000 : undefined,
            updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt * 1000 : undefined,
            tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : undefined,
            timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : undefined,
          }
        }
      }
      continue
    }
    const payload = event.payload ?? {}
    const type = payload.type

    // ── standalone tool-call / tool-result / reasoning events ─────────────
    if (type === 'custom_tool_call' || type === 'function_call') {
      if (pending.length === 0) pendingTime = at
      const id = typeof payload.call_id === 'string' ? payload.call_id : `codex-call-${crypto.randomUUID()}`
      const input = type === 'function_call' ? (payload.arguments ?? payload.input) : payload.input
      const args = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input)
      pending.push({ type: 'tool-call', id, name: String(payload.name ?? 'tool'), arguments: args })
      continue
    }
    if (type === 'custom_tool_call_output' || type === 'function_call_output') {
      if (pending.length === 0) pendingTime = at
      const id = typeof payload.call_id === 'string' ? payload.call_id : ''
      const raw = payload.output ?? payload.content
      const text = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
      pending.push({
        type: 'tool-result',
        toolCallId: id,
        id: `result-${id || crypto.randomUUID()}`,
        content: [{ type: 'text', text: capToolResult(text) }],
        isError: Boolean(payload.is_error),
      })
      continue
    }
    if (type === 'reasoning') {
      if (pending.length === 0) pendingTime = at
      const mapped = normalizeContentBlock({ type: 'reasoning', summary: payload.summary, text: payload.text })
      if (mapped !== undefined) pending.push(mapped)
      continue
    }

    // ── message events ────────────────────────────────────────────────────
    if (type !== 'message') continue
    flushPending()
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') continue
    const blocks = []
    for (const block of Array.isArray(payload.content) ? payload.content : []) {
      const mapped = normalizeContentBlock(block)
      if (mapped !== undefined) blocks.push(mapped)
    }
    if (role === 'user') {
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text === lastUserText && blocks.every(block => block.type === 'text')) continue
      lastUserText = text
    }
    if (blocks.length === 0) continue
    messages.push({ role, time: at, provider: 'codex', model: undefined, blocks })
  }
  flushPending()
  return { header, messages }
}

/**
 * Map one response_item content block to a DSH content block (undefined = skip).
 */
function flattenReasoningText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part.text === 'string') return part.text
      return ''
    }).join('\n')
  }
  if (value && typeof value.text === 'string') return value.text
  return ''
}

function normalizeContentBlock(block) {
  switch (block?.type) {
    case 'input_text':
    case 'output_text': {
      const text = block.text ?? ''
      const trimmed = text.trim()
      if (SYSTEM_BLOCK.test(trimmed) || TRANSCRIPT_PLACEHOLDER.test(trimmed) || AGENTS_MD_BLOCK.test(trimmed) || IMAGE_BLOCK.test(trimmed) || IMAGE_CLOSE.test(trimmed)) return undefined
      return { type: 'text', text }
    }
    case 'reasoning': {
      const text = flattenReasoningText(block.summary ?? block.text)
      return text.length > 0 ? { type: 'reasoning', text } : undefined
    }
    case 'tool_use': {
      const args = block.input === undefined ? '' : JSON.stringify(block.input)
      return {
        type: 'tool-call',
        id: typeof block.id === 'string' ? block.id : `codex-call-${crypto.randomUUID()}`,
        name: String(block.name ?? 'tool'),
        arguments: args,
      }
    }
    default:
      return undefined
  }
}

/**
 * Parse one codex rollout file into normalized messages.
 * @returns { header: {id, createdAt, cwd}, messages: normalized[] }
 */

// Old sync version removed

