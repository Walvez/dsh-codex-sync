/**
 * codex (OpenAI Codex CLI) session reader.
 *
 * Sessions live at ~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl.
 * Each line is a rollout event; the conversation is carried by:
 *   session_meta  { id, cwd, timestamp }
 *   response_item { type: 'message', role, content: [{type, text|…}] }
 *   event_msg     { type: 'user_message', message }
 * response_item user messages repeat the same text as the user_message event,
 * so consecutive duplicates are collapsed. System-injected text blocks
 * (<environment_context>, <permissions instructions>, <turn_aborted> …) are
 * skipped.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Default codex session root. */
export function defaultCodexRoot() {
  return join(process.env.HOME ?? '', '.codex', 'sessions')
}

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

/** System-injected text blocks codex puts into user content; never conversation. */
const SYSTEM_BLOCK = /^<(environment_context|permissions instructions|turn_aborted|request_id|model|end_of_conversation|turn_id)>/u

/** Map one response_item content block to a DSH content block (undefined = skip). */
function normalizeContentBlock(block) {
  switch (block?.type) {
    case 'input_text':
    case 'output_text': {
      const text = block.text ?? ''
      if (SYSTEM_BLOCK.test(text.trim())) return undefined
      return { type: 'text', text }
    }
    case 'reasoning':
      return { type: 'reasoning', text: block.summary ?? block.text ?? '' }
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
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'session_meta') {
      const payload = event.payload ?? {}
      header.id = payload.id
      header.cwd = payload.cwd
      const created = Date.parse(payload.timestamp)
      header.createdAt = Number.isNaN(created) ? undefined : created
      continue
    }
    if (event.type !== 'response_item') continue
    const payload = event.payload ?? {}
    if (payload.type !== 'message') continue
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
    messages.push({ role, time: Date.parse(event.timestamp), provider: 'codex', model: undefined, blocks })
  }
  return { header, messages }
}
