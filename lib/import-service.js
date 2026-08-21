/**
 * Codex session import for dsh.
 *
 * Adapted from dsh-import-agents (c) Chang-Tong / dongzhangust, MIT, with two
 * field-hardened fixes:
 *   1. SIZE GUARD — rollout files larger than `maxSessionBytes` (default
 *      256 MiB) are skipped with a note. The stock reader does
 *      `readFileSync(file, 'utf8')`, and a single file >512 MiB makes Node
 *      throw "Cannot create a string longer than 0x1fffffe8 characters",
 *      which aborted the whole import-all (hit in the wild with a 679 MB
 *      Surge-config session).
 *   2. WORKSPACE GAP — after a batch import, every previously-imported
 *      session is re-attached to its cwd workspace, so a partial first run
 *      (e.g. /import-codex --limit 20) can never leave later sessions
 *      stranded in unregistered workspace dirs.
 *
 * Sessions are written through ctx.sessionPersistence (create + append), so
 * they appear in the GUI immediately and are resumable with full history.
 *
 * @module dsh-codex-sync/import-service
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { listCodexSessions, parseCodexSession, isSubagentThread } from './codex-reader.mjs'
import { buildDshEvents, deriveImportTitle } from './convert.mjs'
import { attachSessionsToWorkspaces, listImportedSessions } from './attach-workspaces.mjs'

const DEFAULT_MAX_SESSION_BYTES = 256 * 1024 * 1024

function projectLabel(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '(no project)'
  const parts = cwd.replace(/\\/gu, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

function sortNewThenImported(nodes) {
  const neu = nodes.filter((s) => !s.imported).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const stale = nodes.filter((s) => s.imported && s.stale).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const old = nodes.filter((s) => s.imported && !s.stale).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const ordered = [...neu, ...stale, ...old]
  for (const node of ordered) {
    if (node.children.length > 0) node.children = sortNewThenImported(node.children)
  }
  return ordered
}

function userTextOf(event) {
  const content = event?.data?.content ?? event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
}

function lastTurnNumber(events) {
  let turn = 0
  for (const event of events) {
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') turn = event.data.turn
  }
  return turn
}

/**
 * Events in `next` that are not already in `old` (matched by leading user-message
 * text). Used to refresh an imported session after Codex continued the thread.
 */
export function diffImportEvents(oldEvents, nextEvents) {
  const oldUsers = oldEvents.filter((e) => e.type === 'user/message').map(userTextOf)
  const nextUsers = nextEvents.filter((e) => e.type === 'user/message').map(userTextOf)
  let match = 0
  while (match < oldUsers.length && match < nextUsers.length && oldUsers[match] === nextUsers[match]) match += 1
  if (match < oldUsers.length) return []

  const last = oldEvents[oldEvents.length - 1]
  const nextSeq = (typeof last?.seq === 'number' ? last.seq : oldEvents.length - 1) + 1
  const oldTurn = lastTurnNumber(oldEvents)

  const remap = (slice, turnOffset) => slice
    .filter((e) => e.type !== 'session/title')
    .map((event, i) => {
      const data = event.data && typeof event.data === 'object' ? { ...event.data } : event.data
      if (data && typeof data.turn === 'number') data.turn = data.turn + turnOffset
      const copy = { ...event, data, seq: nextSeq + i }
      return copy
    })

  if (nextUsers.length > oldUsers.length) {
    let seen = -1
    let start = -1
    for (let i = 0; i < nextEvents.length; i++) {
      if (nextEvents[i].type !== 'user/message') continue
      seen += 1
      if (seen === match) {
        start = i
        while (start > 0 && nextEvents[start].type !== 'turn/start') start -= 1
        break
      }
    }
    if (start < 0) return []
    const slice = nextEvents.slice(start)
    const firstTurn = slice.find((e) => e.type === 'turn/start')?.data?.turn ?? (oldTurn + 1)
    return remap(slice, (oldTurn + 1) - firstTurn)
  }

  const oldLast = oldEvents.at(-1)?.time ?? 0
  const nextLast = nextEvents.at(-1)?.time ?? 0
  if (nextLast <= oldLast) return []

  let seen = -1
  let assistants = 0
  const oldAssistants = oldEvents.filter((e) => e.type === 'assistant/message').length
  let cut = nextEvents.length
  for (let i = 0; i < nextEvents.length; i++) {
    const event = nextEvents[i]
    if (event.type === 'user/message') seen += 1
    if (event.type === 'assistant/message') {
      assistants += 1
      if (seen === match - 1 && assistants === oldAssistants) {
        cut = i + 1
        while (cut < nextEvents.length && (nextEvents[cut].type === 'tool/call' || nextEvents[cut].type === 'tool/result')) cut += 1
        if (nextEvents[cut]?.type === 'turn/end') cut += 1
        break
      }
    }
  }
  const leftover = nextEvents.slice(cut).filter((e) => e.type !== 'session/title' && e.type !== 'turn/end')
  if (leftover.length === 0) return []
  const turn = oldTurn + 1
  const wrapped = leftover[0].type === 'turn/start'
    ? leftover
    : [{ type: 'turn/start', time: leftover[0].time, data: { turn } }, ...leftover]
  const firstTurn = wrapped.find((e) => e.type === 'turn/start')?.data?.turn ?? turn
  return remap(wrapped, turn - firstTurn)
}

/**
 * Import codex sessions into dsh persistence.
 * @param {object} ctx - cordis context (reads workspaceRegistry via ctx.get).
 * @param {object} persistence - ctx.sessionPersistence (create/append/list).
 * @param {object} options - { limit?, project?, since?, maxSessionBytes?, importSubagents?, dryRun? }.
 * @param {string} codexHome - codex config dir (default resolved by caller).
 * @returns {Promise<string[]>} human-readable summary lines.
 */
export async function importCodex(ctx, persistence, options = {}, codexHome = join(process.env.HOME ?? '', '.codex')) {
  const maxBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
  const dryRun = options.dryRun === true
  const existing = new Set((await persistence.list()).map((meta) => meta.id))
  const lines = []
  if (dryRun) lines.push('[codex] dry-run: no sessions will be written')

  // ── collect candidates (with size guard) ──────────────────────────────────
  const candidates = []
  let skippedBig = 0
  let skippedSubagent = 0
  let unreadable = 0
  for (const file of listCodexSessions(join(codexHome, 'sessions'))) {
    let size
    try {
      size = statSync(file).size
    } catch {
      unreadable += 1
      continue
    }
    if (size > maxBytes) {
      skippedBig += 1
      continue
    }
    let parsed
    try {
      parsed = parseCodexSession(file)
    } catch {
      unreadable += 1
      continue
    }
    if (parsed.header.id === undefined) continue
    // Sub-agent threads (parent_thread_id set) dominate rollouts (~half in
    // real usage) and only clutter the session list; filter them out unless
    // explicitly requested.
    if (isSubagentThread(parsed.header) && options.importSubagents !== true && !(Array.isArray(options.ids) && options.ids.length > 0)) {
      skippedSubagent += 1
      continue
    }
    candidates.push({
      file,
      id: `codex-${parsed.header.id}`,
      cwd: parsed.header.cwd,
      createdAt: parsed.header.createdAt,
      parsed,
    })
  }

  let selected = candidates
  if (Array.isArray(options.ids) && options.ids.length > 0) {
    const want = new Set(options.ids)
    selected = selected.filter((c) => want.has(c.id) || want.has(c.parsed.header.id))
  }
  if (options.project !== undefined) {
    selected = selected.filter((c) => typeof c.cwd === 'string' && c.cwd.includes(options.project))
  }
  if (options.since !== undefined) {
    selected = selected.filter((c) => typeof c.createdAt === 'number' && c.createdAt >= options.since)
  }
  if (options.limit !== undefined) {
    selected = [...selected].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, options.limit)
  }

  // ── import ────────────────────────────────────────────────────────────────
  let imported = 0
  let updated = 0
  let skipped = 0
  let empty = 0
  for (const candidate of selected) {
    const { messages } = candidate.parsed
    if (messages.length === 0) {
      empty += 1
      continue
    }
    const events = buildDshEvents(messages, {
      toolEvents: true,
      title: deriveImportTitle(candidate.parsed.header.title, messages, 'codex'),
      titlePinned: true,
    }).map((event, seq) => ({ ...event, seq }))
    if (existing.has(candidate.id)) {
      let oldEvents = []
      try {
        oldEvents = (await persistence.inspect(candidate.id)).events ?? []
      } catch {
        skipped += 1
        continue
      }
      const suffix = diffImportEvents(oldEvents, events)
      if (suffix.length === 0) {
        skipped += 1
        continue
      }
      if (dryRun) {
        updated += 1
        lines.push(`  [would-update] ${candidate.id}  +${suffix.length} events`)
        continue
      }
      await persistence.append(candidate.id, suffix)
      updated += 1
      lines.push(`  [updated] ${candidate.id}  +${suffix.length} events`)
      continue
    }
    if (dryRun) {
      imported += 1
      lines.push(`  [would-import] ${candidate.id}  ${candidate.cwd ?? '(no cwd)'}  ${messages.length} messages -> ${events.length} events`)
      continue
    }
    await persistence.create({
      version: 0,
      id: candidate.id,
      createdAt: candidate.createdAt ?? messages[0].time,
      ...(candidate.cwd !== undefined ? { cwd: candidate.cwd } : {}),
    })
    await persistence.append(candidate.id, events)
    imported += 1
    lines.push(`  [imported] ${candidate.id}  ${candidate.cwd ?? '(no cwd)'}  ${messages.length} messages -> ${events.length} events`)
  }
  const verb = dryRun ? 'would-import' : 'imported'
  lines.push(`[codex] result: ${verb} ${imported}, updated ${updated}, skipped ${skipped}, empty ${empty}, subagent-skipped ${skippedSubagent}, oversized-skipped ${skippedBig}, unreadable ${unreadable}`)
  if (skippedSubagent > 0) {
    lines.push(`  [hint] ${skippedSubagent} codex 子代理线程已过滤（默认，避免会话列表塞满）; 需要时用 /import-codex --include-subagents 或配置 importSubagents: true`)
  }
  if (skippedBig > 0) {
    lines.push(`  [hint] ${skippedBig} file(s) > ${Math.round(maxBytes / 1024 / 1024)} MiB were skipped to avoid the Node string-limit crash; raise config maxSessionBytes to force them, or move them out of ~/.codex/sessions`)
  }

  // ── workspace attach: the whole imported set, not just this batch ─────────
  if (!dryRun) {
    const attached = await attachAllImported(ctx, persistence)
    lines.push(...attached)
  }
  return lines
}

/**
 * Scan Codex rollouts into a project → conversation tree for the import picker.
 * Sub-agent sessions nest under the parent when `parent_thread_id` matches.
 * Does not write persistence.
 */
export async function listImportCatalog(persistence, options = {}, codexHome = join(process.env.HOME ?? '', '.codex')) {
  const maxBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
  const includeSubagents = options.importSubagents === true
  const existing = new Set((await persistence.list()).map((meta) => meta.id))
  const flat = []
  let skippedBig = 0
  let unreadable = 0
  for (const file of listCodexSessions(join(codexHome, 'sessions'))) {
    let size
    try {
      size = statSync(file).size
    } catch {
      unreadable += 1
      continue
    }
    if (size > maxBytes) {
      skippedBig += 1
      continue
    }
    let parsed
    try {
      parsed = parseCodexSession(file)
    } catch {
      unreadable += 1
      continue
    }
    if (parsed.header.id === undefined) continue
    const rawId = String(parsed.header.id)
    const id = `codex-${rawId}`
    const title = deriveImportTitle(parsed.header.title, parsed.messages, 'codex') ?? id
    const lastTime = parsed.messages.length > 0 ? (parsed.messages[parsed.messages.length - 1].time ?? 0) : 0
    flat.push({
      rawId,
      id,
      parentRawId: parsed.header.parentThreadId ? String(parsed.header.parentThreadId) : null,
      cwd: typeof parsed.header.cwd === 'string' ? parsed.header.cwd : null,
      createdAt: parsed.header.createdAt ?? 0,
      lastTime,
      title,
      isSubagent: isSubagentThread(parsed.header),
      imported: existing.has(id),
      stale: false,
      children: [],
    })
  }
  for (const node of flat) {
    if (!node.imported || typeof persistence.inspect !== 'function') continue
    try {
      const view = await persistence.inspect(node.id)
      const lastDsh = view?.events?.length ? (view.events[view.events.length - 1].time ?? 0) : 0
      node.stale = node.lastTime > lastDsh + 500
    } catch {
      node.stale = false
    }
  }

  const visible = includeSubagents ? flat : flat.filter((s) => !s.isSubagent)
  const visByRaw = new Map(visible.map((s) => [s.rawId, s]))
  const roots = []
  for (const node of visible) {
    const parent = node.parentRawId ? visByRaw.get(node.parentRawId) : undefined
    if (parent !== undefined) parent.children.push(node)
    else roots.push(node)
  }

  const groups = new Map()
  for (const node of roots) {
    const key = node.cwd ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(node)
  }

  const projects = []
  for (const [cwd, sessions] of groups) {
    const sorted = sortNewThenImported(sessions)
    let latest = 0
    const walk = (nodes) => {
      for (const n of nodes) {
        if ((n.createdAt ?? 0) > latest) latest = n.createdAt ?? 0
        walk(n.children)
      }
    }
    walk(sorted)
    projects.push({
      cwd: cwd.length > 0 ? cwd : null,
      label: projectLabel(cwd),
      sessions: sorted,
      latest,
    })
  }
  projects.sort((a, b) => b.latest - a.latest)
  return { projects, skippedBig, unreadable }
}

/**
 * Retro-fit every imported session (pi/oc/codex/claude id prefixes) into its
 * cwd-matched workspace, creating missing workspaces. Backs the
 * /attach-workspaces command and the post-import attach step above.
 * @returns {Promise<string[]>} summary lines ('' when workspace service absent).
 */
export async function attachAllImported(ctx, persistence) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || persistence === undefined) return []
  const sessions = await listImportedSessions(persistence)
  return attachSessionsToWorkspaces(ctx, sessions)
}
