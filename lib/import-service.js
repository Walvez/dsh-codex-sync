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
    if (isSubagentThread(parsed.header) && options.importSubagents !== true) {
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
  let skipped = 0
  let empty = 0
  for (const candidate of selected) {
    if (existing.has(candidate.id)) {
      skipped += 1
      continue
    }
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
  lines.push(`[codex] result: ${verb} ${imported}, skipped ${skipped}, empty ${empty}, subagent-skipped ${skippedSubagent}, oversized-skipped ${skippedBig}, unreadable ${unreadable}`)
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
