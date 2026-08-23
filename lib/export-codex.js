/**
 * DSH → Codex session export.
 *
 * Writes a new Codex rollout JSONL and registers it in state_5.sqlite +
 * session_index.jsonl so Codex Desktop's thread list can see it.
 * Not a round-trip: tool traces and the original thread id are not restored.
 *
 * @module dsh-codex-sync/export-codex
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { randomFillSync } from 'node:crypto'
import { listCodexSessions, parseCodexSession } from './codex-reader.mjs'

function uuidv7() {
  const b = Buffer.alloc(16)
  const t = BigInt(Date.now())
  b.writeUInt32BE(Number((t >> 16n) & 0xffffffffn), 0)
  b.writeUInt16BE(Number(t & 0xffffn), 4)
  randomFillSync(b, 6, 10)
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function sqlQuote(s) {
  return `'${String(s ?? '').replace(/'/gu, "''")}'`
}

function skipUserText(text) {
  const t = text.trim()
  return t.startsWith('<system-reminder>')
    || t.startsWith('Current runtime context.')
    || t.startsWith('<environment_context>')
}

function iso(ms) {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now()
  return new Date(n).toISOString()
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function rolloutPath(codexHome, createdAt, uuid) {
  const d = new Date(createdAt)
  const y = d.getUTCFullYear()
  const m = pad(d.getUTCMonth() + 1)
  const day = pad(d.getUTCDate())
  const stamp = `${y}-${m}-${day}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
  const dir = join(codexHome, 'sessions', String(y), m, day)
  return join(dir, `rollout-${stamp}-${uuid}.jsonl`)
}

function blockText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
}

function eventUserText(event) {
  return blockText(event?.data?.content)
}

function eventAssistantText(event) {
  const inner = event?.data?.message?.content ?? event?.data?.content
  return blockText(inner)
}

/**
 * Fold a DSH event log into Codex response_item messages (text only).
 * @param {object[]} events
 */
export function dshEventsToCodexMessages(events) {
  const out = []
  for (const event of events ?? []) {
    if (event.type === 'user/message') {
      const text = eventUserText(event).trim()
      if (text && !skipUserText(text)) out.push({ role: 'user', text, time: event.time ?? Date.now() })
    } else if (event.type === 'assistant/message') {
      const text = eventAssistantText(event).trim()
      if (text) out.push({ role: 'assistant', text, time: event.time ?? Date.now() })
    }
  }
  return out
}

function line(ordinal, type, payload, timestamp) {
  return JSON.stringify({ timestamp, ordinal, type, payload })
}

/**
 * Build JSONL text for one exported session.
 */
export function buildRolloutJsonl({ uuid, cwd, createdAt, messages }) {
  const ts0 = iso(createdAt)
  const lines = []
  let ord = 0
  lines.push(line(ord++, 'session_meta', {
    session_id: uuid,
    id: uuid,
    timestamp: ts0,
    cwd: cwd || process.cwd(),
    originator: 'Codex Desktop',
    cli_version: '0.149.0-alpha.4',
    source: 'vscode',
    thread_source: 'user',
    model_provider: 'openai',
    history_mode: 'legacy',
  }, ts0))
  let t = createdAt
  let turnN = 0
  const bump = () => { t += 1; return iso(t) }
  const startedAt = Math.floor(createdAt / 1000)
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    if (role === 'user') turnN += 1
    const turnId = `${uuid}-turn-${turnN || 1}`
    const ts = bump()
    const ms = t
    const itemId = `${uuid}-${ord}`
    if (role === 'user') {
      lines.push(line(ord++, 'event_msg', {
        type: 'task_started',
        turn_id: turnId,
        started_at: Math.floor(ms / 1000),
        model_context_window: 950000,
        collaboration_mode_kind: 'default',
      }, ts))
      lines.push(line(ord++, 'response_item', {
        type: 'message',
        id: `msg_${itemId}`,
        role: 'user',
        content: [{ type: 'input_text', text: msg.text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }, ts))
      lines.push(line(ord++, 'event_msg', {
        type: 'user_message',
        client_id: uuidv7(),
        message: msg.text,
        images: [],
        local_images: [],
        audio: [],
        local_audio: [],
        text_elements: [],
      }, ts))
    } else {
      lines.push(line(ord++, 'response_item', {
        type: 'message',
        id: `msg_${itemId}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: msg.text }],
        phase: 'final_answer',
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }, ts))
      lines.push(line(ord++, 'event_msg', {
        type: 'agent_message',
        message: msg.text,
        phase: 'final_answer',
        memory_citation: null,
      }, ts))
      lines.push(line(ord++, 'event_msg', {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: msg.text,
        started_at: startedAt,
        completed_at: Math.floor(ms / 1000),
      }, ts))
    }
  }
  return lines.join('\n') + '\n'
}

export function titleOf(events, fallback) {
  const evts = events ?? []
  for (let i = evts.length - 1; i >= 0; i--) {
    const event = evts[i]
    if (event?.type === 'session/title' && typeof event?.data?.title === 'string') {
      const t = event.data.title.replace(/^\[codex\]\s*/u, '').trim()
      if (t) return t.slice(0, 80)
    }
  }
  for (const event of evts) {
    if (event?.type === 'user/message') {
      const t = eventUserText(event).replace(/\s+/gu, ' ').trim()
      if (t && !skipUserText(t)) return t.slice(0, 80)
    }
  }
  return fallback
}

function firstUserPreview(messages) {
  const u = messages.find((m) => m.role === 'user')
  return (u?.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200)
}

function normalizeSignatureText(text) {
  return String(text ?? '')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Extract comparable message signatures (role + normalized text/reasoning) from DSH events.
 * @param {object[]} events
 */
export function extractDshSignatures(events) {
  const sigs = []
  for (const event of events ?? []) {
    if (event.type === 'user/message') {
      const text = eventUserText(event).trim()
      if (text && !skipUserText(text)) {
        sigs.push({ role: 'user', text: normalizeSignatureText(text) })
      }
    } else if (event.type === 'assistant/message') {
      const inner = event?.data?.message?.content ?? event?.data?.content
      const text = blockText(inner).trim()
      if (text) {
        sigs.push({ role: 'assistant', text: normalizeSignatureText(text) })
      }
    }
  }
  return sigs
}

/**
 * Extract comparable message signatures (role + normalized text/reasoning) from Codex messages.
 * @param {object[]} messages - parsedCodexSession messages
 */
export function extractCodexSignatures(messages) {
  const sigs = []
  for (const msg of messages ?? []) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    let text = ''
    if (Array.isArray(msg.blocks)) {
      text = msg.blocks
        .filter((b) => b.type === 'text' || b.type === 'reasoning')
        .map((b) => b.text ?? '')
        .join('')
        .trim()
    } else if (typeof msg.text === 'string') {
      text = msg.text.trim()
    }
    if (text) {
      sigs.push({ role, text: normalizeSignatureText(text) })
    }
  }
  return sigs
}

/**
 * Get known workspace cwds from Codex SQLite DB and sessions.
 * @param {string} codexHome
 * @returns {Set<string>}
 */
export function getKnownCodexWorkspaces(codexHome) {
  const cwds = new Set()
  const db = join(codexHome, 'state_5.sqlite')
  if (existsSync(db)) {
    try {
      const out = execFileSync('sqlite3', [db, "SELECT DISTINCT cwd FROM threads WHERE cwd IS NOT NULL AND cwd != '';"], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
      for (const line of out.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) cwds.add(trimmed)
      }
    } catch {}
  }
  const sessionsDir = join(codexHome, 'sessions')
  if (existsSync(sessionsDir)) {
    try {
      for (const file of listCodexSessions(sessionsDir)) {
        try {
          const parsed = parseCodexSession(file)
          if (parsed?.header?.cwd) cwds.add(String(parsed.header.cwd).trim())
        } catch {}
      }
    } catch {}
  }
  return cwds
}

/**
 * Scan codexHome for session source files and return a map of rawId -> parsed codex session info.
 */
export function buildCodexSourceMap(codexHome) {
  const map = new Map()
  const roots = [
    join(codexHome, 'sessions'),
    join(codexHome, 'archived_sessions'),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const file of listCodexSessions(root)) {
      try {
        const parsed = parseCodexSession(file)
        if (parsed?.header?.id !== undefined) {
          const rawId = String(parsed.header.id)
          // Keep the latest or existing
          if (!map.has(rawId)) {
            map.set(rawId, { file, parsed })
          }
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  return map
}

/**
 * Compare DSH messages against original Codex messages.
 * Returns { dshUpdated, sourceMissing, dshAddedCount }.
 */
export function compareDshWithCodexSource(dshEvents, sourceInfo) {
  if (!sourceInfo || !sourceInfo.parsed) {
    return { dshUpdated: false, sourceMissing: true, dshAddedCount: 0 }
  }
  const dshSigs = extractDshSignatures(dshEvents)
  const codexSigs = extractCodexSignatures(sourceInfo.parsed.messages)

  let prefixMatch = 0
  while (
    prefixMatch < dshSigs.length &&
    prefixMatch < codexSigs.length &&
    dshSigs[prefixMatch].role === codexSigs[prefixMatch].role &&
    dshSigs[prefixMatch].text === codexSigs[prefixMatch].text
  ) {
    prefixMatch += 1
  }

  // Meaningful DSH messages after common prefix => dshUpdated true and dshAddedCount
  if (dshSigs.length > prefixMatch) {
    return {
      dshUpdated: true,
      sourceMissing: false,
      dshAddedCount: dshSigs.length - prefixMatch,
    }
  }

  // Untouched or no extra DSH messages
  return {
    dshUpdated: false,
    sourceMissing: false,
    dshAddedCount: 0,
  }
}

/**
 * Register a thread so Codex Desktop lists it.
 * @returns {boolean}
 */
export function indexCodexThread(codexHome, { uuid, path, cwd, createdAt, title, firstUser }) {
  const nowSec = Math.floor((createdAt || Date.now()) / 1000)
  const nowMs = createdAt || Date.now()
  const preview = (firstUser || title || '').slice(0, 200)
  const db = join(codexHome, 'state_5.sqlite')
  let ok = false
  if (existsSync(db)) {
    const sql = `INSERT OR REPLACE INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, tokens_used, has_user_event, archived,
      cli_version, first_user_message, thread_source, preview, recency_at,
      recency_at_ms, history_mode, created_at_ms, updated_at_ms
    ) VALUES (
      ${sqlQuote(uuid)},
      ${sqlQuote(path)},
      ${nowSec}, ${nowSec},
      'vscode', 'openai',
      ${sqlQuote(cwd || '')},
      ${sqlQuote(title || 'Imported from DSH')},
      '{"type":"disabled"}', 'never',
      0, 1, 0,
      '0.149.0-alpha.4',
      ${sqlQuote(preview)},
      'user',
      ${sqlQuote(preview)},
      ${nowSec}, ${nowMs},
      'legacy', ${nowMs}, ${nowMs}
    );`
    try {
      execFileSync('sqlite3', [db, sql], { stdio: 'pipe' })
      ok = true
    } catch {
      ok = false
    }
  }
  try {
    appendFileSync(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
      id: uuid,
      thread_name: title || 'Imported from DSH',
      updated_at: iso(nowMs),
    })}\n`)
  } catch {
    /* index file optional */
  }
  return ok
}

/**
 * List DSH sessions as an export catalog (grouped by cwd).
 */
export async function listExportCatalog(persistence, options = {}, codexHome = join(process.env.HOME ?? '', '.codex')) {
  const includeCodex = options.includeCodex === true
  const includeSubagents = options.includeSubagents === true

  const metas = (await persistence.list()) || []
  let codexSourceMap = null
  if (includeCodex) {
    codexSourceMap = buildCodexSourceMap(codexHome)
  }

  const flatNodes = []
  for (const meta of metas) {
    const isCodex = String(meta.id).startsWith('codex-')
    const isNativeSubagent = meta.origin === 'subagent' || (typeof meta.delegationDepth === 'number' && meta.delegationDepth > 0)
    
    // Default excludes codex-* sessions unless includeCodex is true
    if (isCodex && !includeCodex) continue

    let events = []
    let title = meta.id
    let messageCount = 0
    if (typeof persistence.inspect === 'function') {
      try {
        const view = await persistence.inspect(meta.id)
        events = view?.events ?? []
        title = titleOf(events, meta.id)
        messageCount = dshEventsToCodexMessages(events).length
      } catch {
        /* fallback title = meta.id, messageCount = 0 */
      }
    }

    // Skip empty sessions with 0 messages (e.g. newly created blank session where user never spoke)
    if (messageCount === 0) continue

    let isSubagent = false
    let parentId = null
    let alreadyCodex = false
    let fromCodex = false
    let dshUpdated = false
    let sourceMissing = false
    let dshAddedCount = 0

    if (isCodex) {
      alreadyCodex = true
      fromCodex = true
      const rawId = String(meta.id).replace(/^codex-/u, '')
      const sourceInfo = codexSourceMap?.get(rawId)
      const comparison = compareDshWithCodexSource(events, sourceInfo)
      dshUpdated = comparison.dshUpdated
      sourceMissing = comparison.sourceMissing
      dshAddedCount = comparison.dshAddedCount

      if (sourceInfo?.parsed?.header?.parentThreadId) {
        isSubagent = true
        parentId = `codex-${sourceInfo.parsed.header.parentThreadId}`
      }
    } else if (isNativeSubagent) {
      isSubagent = true
      parentId = meta.parentSession ? String(meta.parentSession) : null
    }

    // Default excludes subagents unless includeSubagents is true
    if (isSubagent && !includeSubagents) continue

    flatNodes.push({
      id: meta.id,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
      createdAt: meta.createdAt ?? 0,
      title,
      messageCount,
      alreadyCodex,
      fromCodex,
      dshUpdated,
      sourceMissing,
      dshAddedCount,
      parentId,
      isSubagent,
      children: [],
    })
  }

  // Nest children under parent when includeSubagents is true
  const nodeMap = new Map(flatNodes.map((n) => [n.id, n]))
  const rootNodes = []
  for (const node of flatNodes) {
    if (includeSubagents && node.parentId && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId).children.push(node)
    } else {
      rootNodes.push(node)
    }
  }

  const groups = new Map()
  for (const node of rootNodes) {
    const key = node.cwd ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(node)
  }

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortNodes(node.children)
      }
    }
  }

  const knownCodexCwds = getKnownCodexWorkspaces(codexHome)

  const projects = []
  for (const [cwd, sessions] of groups) {
    const parts = cwd.replace(/\\/gu, '/').split('/').filter(Boolean)
    const isCodexWorkspace = Boolean(cwd && (knownCodexCwds.size === 0 || knownCodexCwds.has(cwd)))
    for (const node of sessions) {
      node.isCodexWorkspace = isCodexWorkspace
    }
    sortNodes(sessions)
    projects.push({
      cwd: cwd || null,
      label: parts[parts.length - 1] || '(no project)',
      sessions,
      isCodexWorkspace,
    })
  }
  projects.sort((a, b) => (b.sessions[0]?.createdAt ?? 0) - (a.sessions[0]?.createdAt ?? 0))
  return { projects }
}

/**
 * Export selected DSH sessions to new Codex rollouts + thread index.
 */
export async function exportToCodex(persistence, options = {}, codexHome = join(process.env.HOME ?? '', '.codex')) {
  const dryRun = options.dryRun === true
  const want = Array.isArray(options.ids) && options.ids.length > 0 ? new Set(options.ids) : null
  const metas = (await persistence.list()) || []
  const lines = []
  if (dryRun) lines.push('[codex] export dry-run: no files will be written')
  let exported = 0
  let skipped = 0
  let empty = 0

  let codexSourceMap = null
  const getCodexSourceMap = () => {
    if (!codexSourceMap) {
      codexSourceMap = buildCodexSourceMap(codexHome)
    }
    return codexSourceMap
  }

  const knownCodexCwds = getKnownCodexWorkspaces(codexHome)

  for (const meta of metas) {
    if (want && !want.has(meta.id)) continue
    if (meta.cwd && knownCodexCwds.size > 0 && !knownCodexCwds.has(meta.cwd)) {
      skipped += 1
      lines.push(`  [skip-workspace] ${meta.id} (workspace not recognized in Codex: ${meta.cwd})`)
      continue
    }
    const isCodex = String(meta.id).startsWith('codex-')
    let isCodexExportAllowed = false

    if (isCodex) {
      if (want && want.has(meta.id)) {
        let events = []
        try {
          events = (await persistence.inspect(meta.id)).events ?? []
        } catch {
          skipped += 1
          continue
        }
        const rawId = String(meta.id).replace(/^codex-/u, '')
        const sourceInfo = getCodexSourceMap().get(rawId)
        const comparison = compareDshWithCodexSource(events, sourceInfo)
        if (comparison.dshUpdated) {
          isCodexExportAllowed = true
        }
      }
      if (!isCodexExportAllowed) {
        skipped += 1
        lines.push(`  [skip-source] ${meta.id} (already a codex session)`)
        continue
      }
    }

    let events = []
    try {
      events = (await persistence.inspect(meta.id)).events ?? []
    } catch {
      skipped += 1
      continue
    }
    const messages = dshEventsToCodexMessages(events)
    if (messages.length === 0) {
      empty += 1
      continue
    }
    const uuid = uuidv7()
    const createdAt = Date.now()
    const path = rolloutPath(codexHome, createdAt, uuid)
    const title = titleOf(events, meta.id)
    const body = buildRolloutJsonl({
      uuid,
      cwd: meta.cwd,
      createdAt,
      messages,
    })
    const copyNote = isCodex ? ' (new copy; original Codex thread not overwritten)' : ''
    if (dryRun) {
      exported += 1
      lines.push(`  [would-export] ${meta.id}  ${messages.length} messages -> ${path}${copyNote}`)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    const indexed = indexCodexThread(codexHome, {
      uuid,
      path,
      cwd: meta.cwd || '',
      createdAt,
      title,
      firstUser: firstUserPreview(messages),
    })
    exported += 1
    lines.push(`  [exported] ${meta.id}  ${messages.length} messages -> ${path}${copyNote}${indexed ? '  (indexed)' : '  (jsonl only — restart Codex)'}`)
  }
  lines.push(`[codex] export: ${dryRun ? 'would-export' : 'exported'} ${exported}, skipped ${skipped}, empty ${empty}`)
  return lines
}
