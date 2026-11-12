/**
 * Codex session import for dsh.
 *
 * Adapted from dsh-import-agents (c) Chang-Tong / dongzhangust, MIT, with two
 * field-hardened fixes:
 *   1. SIZE GUARD — rollouts above `maxSessionBytes` are still skipped with a
 *      note, but the default is now 2 GiB: the reader streams JSONL line by line
 *      (it used to `readFileSync` the whole file, which made Node throw
 *      "Cannot create a string longer than 0x1fffffe8 characters" and abort the
 *      whole import-all). A 1.2 GB rollout parses in a few seconds, so the old
 *      256 MiB ceiling only hid real conversations.
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
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { listCodexSessions, parseCodexSession, isSubagentThread } from './codex-reader.mjs'
import { loadCodexIndex, codexTitleOf, codexProjectOf, codexProjectNameForPath, codexOriginOf, baseName } from './codex-index.mjs'
import { buildDshEvents, deriveImportTitle } from './convert.mjs'
import { migrateToCurrent } from './session-migrate.mjs'
import { normalizePersistence, isSessionBusyError } from './persistence-facade.mjs'
import { attachSessionsToWorkspaces, listImportedSessions } from './attach-workspaces.mjs'

export const DEFAULT_MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024
/**
 * Agent preset imported sessions run under. DSH names the built-in presets
 * `standard` (标准模式), `ptc`, `minimal` and `cordis` (创造模式); the preset is
 * fixed at session creation and decides which tools and prompt sections the
 * session gets, so an import must not silently place every Codex chat in the
 * plugin-authoring (创造模式) preset.
 */
export const DEFAULT_IMPORT_AGENT_PRESET = 'standard'

/**
 * Rewrite the JSONL/db title helpers into one index-backed lookup.
 */
function resolveImportTitle(codexHome, rawId, headerTitle, messages) {
  const named = codexTitleOf(loadCodexIndex(codexHome), rawId)
  if (typeof named === 'string' && named.length > 0) return named
  return deriveImportTitle(headerTitle, messages, 'codex')
}

/**
 * Codex goal status → the DSH goal phase it stands for. Unknown statuses are
 * treated as `active` so an unfinished goal is never silently dropped.
 * @param {string|undefined} status
 * @returns {'active'|'paused'|'blocked'|'complete'}
 */
function codexGoalPhase(status) {
  const wanted = String(status ?? 'active').toLowerCase()
  if (wanted === 'paused') return 'paused'
  if (wanted === 'complete' || wanted === 'completed') return 'complete'
  if (wanted === 'blocked') return 'blocked'
  return 'active'
}

/**
 * Operations that move an existing goal from `from` to `to`, following the
 * transitions `@deepseek-ai/dsh-goal`'s fold admits: `pause` only from active,
 * `block` only from active, `resume` only into active, `complete` from any
 * phase except complete. Blocked/paused therefore resume first.
 * @returns {string[]|undefined} operations, or undefined when the move is impossible
 */
function goalOperations(from, to) {
  if (from === to) return []
  if (from === 'complete') return undefined
  if (to === 'complete') return ['complete']
  const ops = []
  if (from === 'paused' || from === 'blocked') ops.push('resume')
  if (to === 'paused') ops.push('pause')
  else if (to === 'blocked') ops.push('block')
  return ops
}

/**
 * Replay a Codex goal as the `goal/change` events DSH's goal service folds.
 *
 * The fold is strict, so this must reproduce an admissible log rather than a
 * plausible one: `create` is only accepted as revision 1 / phase active / zero
 * rounds, every later change is exactly revision+1 and preserves `createdAt`
 * and `roundsStarted`, and a goal id may only be created once per session
 * (`seenGoalIds`). When `previous` names the goal already stored in the session,
 * the chain continues from it instead of creating a second goal.
 *
 * @param {string} sessionId
 * @param {{objective: string, status: string, createdAt?: number, updatedAt?: number}} | undefined goal
 * @param {number} time - fallback timestamps (ms)
 * @param {{phase: string, revision: number, createdAt: number, updatedAt: number}} [previous]
 * @returns {Array<object>} goal/change events (seq assigned by the caller)
 */
function codexGoalEvents(sessionId, goal, time, previous) {
  if (goal === undefined) return []
  const objective = String(goal.objective ?? '').trim()
  if (objective.length === 0) return []
  const target = codexGoalPhase(goal.status)
  const ops = goalOperations(previous === undefined ? 'active' : previous.phase, target)
  if (ops === undefined) return []
  const id = `goal-${sessionId}`
  const createdAt = previous === undefined ? (goal.createdAt ?? time) : previous.createdAt
  const wantedAt = Math.max(goal.updatedAt ?? time, createdAt)
  const events = []
  let revision = previous === undefined ? 0 : previous.revision
  let cursor = previous === undefined ? createdAt : Math.max(previous.updatedAt, createdAt)
  const push = (operation, phase, at) => {
    revision += 1
    events.push({
      type: 'goal/change',
      time: at,
      data: {
        kind: 'goal/change',
        version: 1,
        operation,
        goal: {
          id,
          revision,
          objective,
          phase,
          maxGoalRounds: 256,
          ...(phase === 'blocked'
            ? { blockedReason: { code: 'imported', message: 'Codex 侧目标处于 blocked 状态（导入时保留）' } }
            : {}),
        },
        roundsStarted: 0,
        createdAt,
        updatedAt: at,
      },
    })
  }
  if (previous === undefined) push('create', 'active', createdAt)
  for (const operation of ops) {
    cursor = Math.max(cursor, wantedAt)
    if (operation === 'resume') push('resume', 'active', cursor)
    else if (operation === 'pause') push('pause', 'paused', cursor)
    else if (operation === 'block') push('block', 'blocked', cursor)
    else if (operation === 'complete') push('complete', 'complete', cursor)
  }
  return events
}

/**
 * Goal events to append to an ALREADY imported session so it follows a Codex
 * goal change. The stored goal (if any) is read back from the session log, so a
 * re-import continues that goal instead of creating a second one.
 *
 * @param {string} sessionId
 * @param {Array<object>} oldEvents - what the DSH session already holds
 * @param {object|undefined} goal - the Codex goal snapshot
 * @param {number} time - fallback timestamp (ms)
 */
function codexGoalSyncEvents(sessionId, oldEvents, goal, time) {
  if (goal === undefined) return []
  const stored = [...oldEvents].reverse().find((event) => event?.type === 'goal/change')
  const previous = stored === undefined ? undefined : {
    phase: stored.data?.goal?.phase,
    revision: stored.data?.goal?.revision,
    createdAt: stored.data?.createdAt,
    updatedAt: stored.data?.updatedAt,
  }
  if (previous !== undefined && (typeof previous.phase !== 'string'
    || typeof previous.revision !== 'number'
    || typeof previous.createdAt !== 'number'
    || typeof previous.updatedAt !== 'number')) {
    return []
  }
  return codexGoalEvents(sessionId, goal, time, previous)
}

/** Project label for one thread: Codex's project name, else the cwd's folder. */
function folderLabel(cwd) {  if (typeof cwd !== 'string' || cwd.length === 0) return '(no project)'
  return baseName(cwd) || cwd
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
 * Repack continuation events into ONE fresh, self-contained turn (turn =
 * `turn`): structure markers from the slice are dropped and rebuilt (step
 * boundaries re-derived from assistant boundaries), content events re-attach
 * to the new turn/step. The append-only store can not rewrite the old tail
 * (its closing step/end and turn/end), so a same-turn continuation must land
 * in a new turn whose markers are internally consistent no matter which
 * structural boundaries the slice starts at.
 */
function wrapAsFreshTurn(leftover, turn) {
  const out = []
  let step = 0
  let open = false
  let stepHasAssistant = false
  let lastTime = leftover[0]?.time ?? 0
  out.push({ type: 'turn/start', time: lastTime, data: { turn } })
  const openStep = (time) => {
    step += 1
    out.push({ type: 'step/start', time, data: { turn, step } })
    open = true
  }
  const closeStep = (time) => {
    if (open) {
      out.push({ type: 'step/end', time, data: { turn, step } })
      open = false
    }
  }
  for (const event of leftover) {
    lastTime = event.time ?? lastTime
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/start' || event.type === 'step/end') continue
    if (event.type === 'assistant/message' && open && stepHasAssistant) closeStep(event.time)
    if (!open) openStep(event.time)
    if (event.type === 'assistant/message') stepHasAssistant = true
    const data = event.data && typeof event.data === 'object' ? { ...event.data } : event.data
    if (data && typeof data.turn === 'number') data.turn = turn
    if (data && typeof data.step === 'number') data.step = step
    out.push({ ...event, data })
  }
  closeStep(lastTime)
  out.push({ type: 'turn/end', time: lastTime, data: { turn, reason: { kind: 'completed' } } })
  out.forEach((e, i) => { e.seq = i })
  return out
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
  const baseSeq = (typeof last?.seq === 'number' ? last.seq : oldEvents.length - 1) + 1
  const oldTurn = lastTurnNumber(oldEvents)

  const remap = (slice, turnOffset, seqBase) => slice
    .filter((e) => e.type !== 'session/title' && e.type !== 'goal/change')
    .map((event, i) => {
      const data = event.data && typeof event.data === 'object' ? { ...event.data } : event.data
      if (data && typeof data.turn === 'number') data.turn = data.turn + turnOffset
      const copy = { ...event, data, seq: seqBase + i }
      return copy
    })

  // Locate the first event of `next` that the previous import did not store.
  // Rollouts are append-only, so `old`'s users and assistants are PREFIXES of
  // `next`'s: the (oldAssistants)-th assistant (0-based) and the (match)-th
  // user are the first NEW ones. The zero cases matter — `oldAssistants === 0`
  // is the reply to a question that was still pending at the previous import
  // (counting the current event BEFORE comparing; the old code incremented
  // first and never matched, silently dropping the answer), and a new user
  // may arrive while old's last turn also gained its (first) assistant.
  const oldAssistants = oldEvents.filter((e) => e.type === 'assistant/message').length
  let firstNewAssistant = -1
  let firstNewUser = -1
  let assistants = 0
  let seenUsers = -1
  for (let i = 0; i < nextEvents.length; i += 1) {
    const type = nextEvents[i].type
    if (type === 'assistant/message') {
      if (firstNewAssistant === -1) {
        if (assistants === oldAssistants) firstNewAssistant = i
        else assistants += 1
      }
    } else if (type === 'user/message') {
      seenUsers += 1
      if (seenUsers === match) firstNewUser = i
    }
  }
  if (firstNewAssistant === -1 && firstNewUser === -1) return []

  const cut = firstNewAssistant === -1 ? firstNewUser
    : firstNewUser === -1 ? firstNewAssistant
    : Math.min(firstNewAssistant, firstNewUser)

  // Split the new content at the first turn/start at or after its beginning:
  // - a slice that continues old's LAST turn (the reply arrived after the
  //   import) must be repacked into ONE fresh turn — the stored tail's
  //   closing step/end + turn/end are already on disk and the append-only
  //   store cannot rewrite them;
  // - complete new turns keep their converted structure, renumbered to
  //   continue after the fresh turn.
  let boundary
  if (cut === firstNewAssistant) {
    boundary = cut + 1
    while (boundary < nextEvents.length && nextEvents[boundary].type !== 'turn/start') boundary += 1
  } else {
    boundary = cut
    while (boundary > 0 && nextEvents[boundary].type !== 'turn/start') boundary -= 1
    if (nextEvents[boundary].type !== 'turn/start') return []
  }
  const suffix = []
  let nextTurn = oldTurn + 1
  if (cut === firstNewAssistant) {
    const fresh = wrapAsFreshTurn(
      nextEvents.slice(cut, boundary).filter((e) => e.type !== 'session/title'),
      nextTurn,
    )
    fresh.forEach((e, i) => { e.seq = baseSeq + i })
    suffix.push(...fresh)
    nextTurn += 1
  }
  if (boundary < nextEvents.length) {
    const rest = nextEvents.slice(boundary)
    const firstRestTurn = rest.find((e) => e.type === 'turn/start')?.data?.turn
    if (typeof firstRestTurn !== 'number') return []
    suffix.push(...remap(rest, nextTurn - firstRestTurn, baseSeq + suffix.length))
  }
  return suffix
}

/**
 * Append through the persistence facade, retrying once when the Session is
 * momentarily owned by another write handle (the GUI releases it as soon as the
 * view switches away). A still-busy Session is reported by the caller.
 * @param {object} persistence - normalized persistence
 * @param {string} id - session id
 * @param {Array<object>} events - events to append
 */
async function appendWithBusyRetry(persistence, id, events) {
  try {
    await persistence.append(id, events)
  } catch (error) {
    if (!isSessionBusyError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 300))
    await persistence.append(id, events)
  }
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
  persistence = normalizePersistence(persistence)
  const maxBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
  const dryRun = options.dryRun === true
  const existing = new Set((await persistence.list()).map((meta) => meta.id))
  const lines = []
  const index = loadCodexIndex(codexHome)
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
      parsed = await parseCodexSession(file)
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

  // Codex writes paginated continuation rollouts for one thread: the base
  // `rollout-<ts>-<uuid>.jsonl` plus later `rollout-<ts>-<uuid>_<fork>.jsonl`
  // segments (verified delta-only — no message overlap between segments).
  // Processing each file as its own candidate would create the session twice
  // and abort the whole batch with "session … already exists" on the second
  // segment. Merge segments per id, oldest file first (listCodexSessions
  // sorts paths, and the embedded rollout timestamps sort chronologically).
  const mergedById = new Map()
  for (const candidate of candidates) {
    const prev = mergedById.get(candidate.id)
    if (prev === undefined) mergedById.set(candidate.id, candidate)
    else prev.parsed.messages.push(...candidate.parsed.messages)
  }
  const deduped = [...mergedById.values()]

  let selected = deduped
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
  let busy = 0
  for (const candidate of selected) {
    const { messages } = candidate.parsed
    if (messages.length === 0) {
      empty += 1
      continue
    }
    const events = buildDshEvents(messages, {
      toolEvents: true,
      title: resolveImportTitle(codexHome, candidate.parsed.header.id, candidate.parsed.header.title, messages),
      titlePinned: true,
    }).map((event, seq) => ({ ...event, seq }))
    // Carry Codex's goal mode across: DSH's `ctx.goals` is derived purely from
    // `goal/change` events in the session log, so replaying the goal is what
    // makes an unfinished Codex goal active here.
    const lastMessageTime = messages.length > 0 ? (messages[messages.length - 1].time ?? Date.now()) : Date.now()
    events.push(...codexGoalEvents(candidate.id, candidate.parsed.header.goal, lastMessageTime))
    events.forEach((event, seq) => { event.seq = seq })
    // DSH 0.9.0 session-persistence now *writes* only the current (v3) format:
    // encodeCurrentHeader throws "encodeCurrent requires Session format v3" for a
    // v0 header, so the importer must migrate the imported v0 header + events
    // through the real v0->v1->v2->v3 chain before create/append (issue #2).
    const importHeader = {
      version: 0,
      id: candidate.id,
      createdAt: candidate.createdAt ?? messages[0].time,
      ...(candidate.cwd !== undefined ? { cwd: candidate.cwd } : {}),
      agentPreset: typeof options.agentPreset === 'string' && options.agentPreset.length > 0
        ? options.agentPreset
        : DEFAULT_IMPORT_AGENT_PRESET,
    }
    // Fail LOUDLY instead of falling back to a v0 write: real DSH persistence
    // rejects v0 anyway ("encodeCurrent requires Session format v3"/"v4"), so
    // a silent fallback would break the import while hiding the root cause
    // (missing migration packages / data-dependent migration failure).
    const { header: currentHeader, events: currentEvents } = (() => {
      try {
        return migrateToCurrent(importHeader, events)
      } catch (error) {
        throw new Error(`import-codex: session ${candidate.id} could not be migrated to the current session format: ${error.message}`)
      }
    })()
    if (existing.has(candidate.id)) {
      let oldEvents = []
      try {
        oldEvents = (await persistence.inspect(candidate.id)).events ?? []
      } catch {
        skipped += 1
        continue
      }
      const suffix = diffImportEvents(oldEvents, currentEvents)
      const goalTail = codexGoalSyncEvents(candidate.id, oldEvents, candidate.parsed.header.goal, lastMessageTime)
        .map((event, i) => ({ ...event, seq: (suffix[suffix.length - 1]?.seq ?? oldEvents[oldEvents.length - 1]?.seq ?? 0) + 1 + i }))
      if (suffix.length === 0 && goalTail.length === 0) {
        skipped += 1
        continue
      }
      if (dryRun) {
        updated += 1
        lines.push(`  [would-update] ${candidate.id}  +${suffix.length + goalTail.length} events`)
        continue
      }
      try {
        await appendWithBusyRetry(persistence, candidate.id, [...suffix, ...goalTail])
      } catch (error) {
        // A chat that is open in the GUI holds this Host's write handle for its
        // Session, and the backend refuses a second one. Skip it (with a hint)
        // instead of aborting the whole batch; other durability failures still
        // fail loud.
        if (!isSessionBusyError(error)) throw error
        busy += 1
        lines.push(`  [busy] ${candidate.id}: 该对话正在 DSH 中打开，关闭它（或切到别的对话）后重新导入本会话`)
        continue
      }
      updated += 1
      lines.push(`  [updated] ${candidate.id}  +${suffix.length + goalTail.length} events`)
      continue
    }
    if (dryRun) {
      imported += 1
      lines.push(`  [would-import] ${candidate.id}  ${candidate.cwd ?? '(no cwd)'}  ${messages.length} messages -> ${currentEvents.length} events`)
      continue
    }
    await persistence.createAndAppend(currentHeader, currentEvents)
    imported += 1
    lines.push(`  [imported] ${candidate.id}  ${candidate.cwd ?? '(no cwd)'}  ${messages.length} messages -> ${currentEvents.length} events`)
  }
  const verb = dryRun ? 'would-import' : 'imported'
  lines.push(`[codex] result: ${verb} ${imported}, updated ${updated}, skipped ${skipped}, empty ${empty}, busy ${busy}, subagent-skipped ${skippedSubagent}, oversized-skipped ${skippedBig}, unreadable ${unreadable}`)
  if (busy > 0) {
    lines.push(`  [hint] ${busy} 个会话正在 DSH 中打开（写句柄被占用），本次未更新；关闭这些对话后重新导入即可补齐`)
  }
  if (skippedSubagent > 0) {
    lines.push(`  [hint] ${skippedSubagent} codex 子代理线程已过滤（默认，避免会话列表塞满）; 需要时用 /import-codex --include-subagents 或配置 importSubagents: true`)
  }
  if (skippedBig > 0) {
    lines.push(`  [hint] ${skippedBig} file(s) > ${Math.round(maxBytes / 1024 / 1024)} MiB were skipped; raise config maxSessionBytes to include them`)
  }

  // ── workspace attach: the whole imported set, not just this batch ─────────
  if (!dryRun) {
    const attached = await attachAllImported(ctx, persistence, codexHome)
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
  persistence = normalizePersistence(persistence)
  const maxBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
  const includeSubagents = options.importSubagents === true
  const existing = new Set((await persistence.list()).map((meta) => meta.id))
  const flat = []
  let skippedBig = 0
  let unreadable = 0
  const index = loadCodexIndex(codexHome)
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
      parsed = await parseCodexSession(file)
    } catch {
      unreadable += 1
      continue
    }
    if (parsed.header.id === undefined) continue
    const rawId = String(parsed.header.id)
    const id = `codex-${rawId}`
    const title = resolveImportTitle(codexHome, rawId, parsed.header.title, parsed.messages) ?? id
    const lastTime = parsed.messages.length > 0 ? (parsed.messages[parsed.messages.length - 1].time ?? 0) : 0
    // Codex's own `threads.source` is authoritative: `guardian` rows are
    // automated review threads and `thread_spawn` rows are sub-agents, neither
    // of which the Codex sidebar shows as chats.
    const origin = codexOriginOf(index, rawId)
    const isInternal = origin !== undefined ? origin.kind !== 'user' : isSubagentThread(parsed.header)
    const parentRawId = parsed.header.parentThreadId
      ? String(parsed.header.parentThreadId)
      : (origin?.parentThreadId ?? null)
    flat.push({
      rawId,
      id,
      parentRawId,
      cwd: typeof parsed.header.cwd === 'string' ? parsed.header.cwd : null,
      createdAt: parsed.header.createdAt ?? 0,
      lastTime,
      title,
      isSubagent: isInternal,
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
    // Codex groups by PROJECT, and one project owns several roots, so every
    // thread whose cwd lives under a project root must land in the same group —
    // grouping by raw cwd would split e.g. zbwx-v2 into one group per repo.
    // Threads Codex knows no project for fall back to their folder name; the
    // label is the group key so equally-named groups never appear twice.
    const project = codexProjectOf(index, node.rawId, node.cwd ?? undefined)
    const label = project?.name ?? folderLabel(node.cwd)
    const key = label.toLowerCase()
    if (!groups.has(key)) groups.set(key, { label, cwd: node.cwd, sessions: [] })
    groups.get(key).sessions.push(node)
  }

  const projects = []
  for (const group of groups.values()) {
    const sorted = sortNewThenImported(group.sessions)
    let latest = 0
    const walk = (nodes) => {
      for (const n of nodes) {
        if ((n.createdAt ?? 0) > latest) latest = n.createdAt ?? 0
        walk(n.children)
      }
    }
    walk(sorted)
    const cwd = group.cwd
    projects.push({
      cwd: cwd.length > 0 ? cwd : null,
      label: group.label,
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
export async function attachAllImported(ctx, persistence, codexHome = join(process.env.HOME ?? '', '.codex')) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || persistence === undefined) return []
  const sessions = await listImportedSessions(persistence)
  const index = loadCodexIndex(codexHome)
  return attachSessionsToWorkspaces(ctx, sessions, {
    projectNameOf: (cwd) => codexProjectNameForPath(index, cwd),
  })
}
