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

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.startsWith('rollout-')) files.push(path)
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
 */
const SYSTEM_BLOCK = /^<(environment_context|permissions instructions|turn_aborted|request_id|model|end_of_conversation|turn_id|recommended_plugins|skills_instructions|apps_instructions|plugins_instructions|collaboration_mode|multi_agent_mode|app-context|citation_entries|INSTRUCTIONS)>/u

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
  return Boolean(header?.parentThreadId)
}

/**
 * Map one response_item content block to a DSH content block (undefined = skip).
 */
function normalizeContentBlock(block) {
  switch (block?.type) {
    case 'input_text':
    case 'output_text': {
      const text = block.text ?? ''
      const trimmed = text.trim()
      if (SYSTEM_BLOCK.test(trimmed) || AGENTS_MD_BLOCK.test(trimmed) || IMAGE_BLOCK.test(trimmed) || IMAGE_CLOSE.test(trimmed)) return undefined
      return { type: 'text', text }
    }
    case 'reasoning': {
      const text = block.summary ?? (typeof block.text === 'string' ? block.text : '')
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
export function parseCodexSession(file) {
  const header = { id: undefined, createdAt: undefined, cwd: undefined }
  const messages = []
  let lastUserText
  // assistant-side blocks accumulated from standalone response_items
  // (custom_tool_call/_output, reasoning) and flushed as one assistant
  // message right before the next `message` event.
  let pending = []
  let pendingTime = 0

  const flushPending = () => {
    if (pending.length === 0) return
    messages.push({ role: 'assistant', time: pendingTime, provider: 'codex', model: undefined, blocks: pending })
    pending = []
  }

  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
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
      // Some rollouts carry several session_meta lines (thread fork / resume);
      // a parent_thread_id on ANY of them marks a sub-agent thread.
      if (payload.parent_thread_id !== undefined) header.parentThreadId = payload.parent_thread_id
      if (payload.agent_nickname !== undefined) header.agentNickname = payload.agent_nickname
      const created = Date.parse(payload.timestamp)
      header.createdAt = Number.isNaN(created) ? undefined : created
      continue
    }
    if (event.type !== 'response_item') continue
    const payload = event.payload ?? {}
    const type = payload.type

    // ── standalone tool-call / tool-result / reasoning events ─────────────
    if (type === 'custom_tool_call' || type === 'function_call') {
      if (pending.length === 0) pendingTime = at
      const id = typeof payload.call_id === 'string' ? payload.call_id : `codex-call-${crypto.randomUUID()}`
      const input = payload.input
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
      // The same prompt is echoed per turn; collapse consecutive duplicates.
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
