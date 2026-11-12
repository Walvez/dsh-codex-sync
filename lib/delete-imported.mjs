/**
 * Delete chats this plugin imported from Codex.
 *
 * DSH exposes no "delete a Session" API — the workspace controller only offers
 * archive/unarchive/pin/unpin — so a real removal means deleting the durable
 * artifact. Everything else is derived and self-heals:
 *   - the SQLite session index reconciles away rows whose artifact is gone,
 *   - the projection cache file is dropped here,
 *   - the archive set is cleared through the registry BEFORE the artifact goes,
 *     because a re-import of the same id would otherwise stay hidden.
 *
 * Only `codex-*` ids are touched: the prefix is what the importer writes, so a
 * chat the user created in DSH can never be removed through this path.
 */
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizePersistence } from './persistence-facade.mjs'

/** Every imported Session id starts with this prefix (see import-service). */
export const IMPORTED_ID_PREFIX = 'codex-'

/** Durable session store root used by the JSONL persistence backend. */
export function defaultSessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

/** Materialized projection cache written per Session id. */
export function defaultProjectionCache() {
  return join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
}

/**
 * Find the artifact directory of one Session: `<root>/<project key>/<id>`.
 * @param {string} root - session store root
 * @param {string} id - Session id
 * @returns {Promise<string|undefined>} absolute directory, or undefined
 */
export async function locateSessionDir(root, id) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, id)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Delete imported Sessions by id.
 * @param {object} ctx - cordis context (reads workspaceRegistry / agents)
 * @param {object} persistence - ctx.sessionPersistence (only `list` is used)
 * @param {string[]} ids - Session ids to delete
 * @param {{sessionsRoot?: string, projectionCache?: string, dryRun?: boolean}} [options]
 * @returns {Promise<{lines: string[], deleted: string[], refused: Array<[string, string]>, missing: string[]}>}
 */
export async function deleteImportedSessions(ctx, persistence, ids, options = {}) {
  const root = options.sessionsRoot ?? defaultSessionsRoot()
  const cache = options.projectionCache ?? defaultProjectionCache()
  const dryRun = options.dryRun === true
  const registry = ctx.get('workspaceRegistry')
  const agents = ctx.get('agents')
  const normalized = normalizePersistence(persistence)
  const known = new Set(normalized === undefined
    ? []
    : (await normalized.list()).map((meta) => meta.id))

  const lines = []
  const deleted = []
  const refused = []
  const missing = []
  for (const raw of ids) {
    const id = String(raw)
    if (!id.startsWith(IMPORTED_ID_PREFIX)) {
      refused.push([id, '不是本插件导入的会话（只允许删除 codex-* 会话）'])
      continue
    }
    if (!known.has(id)) {
      missing.push(id)
      continue
    }
    const live = typeof agents?.get === 'function' ? agents.get(id) : undefined
    if (live !== undefined) {
      refused.push([id, '对话正在 DSH 中打开，关闭它之后才能删除'])
      continue
    }
    const dir = await locateSessionDir(root, id)
    if (dir === undefined) {
      missing.push(id)
      continue
    }
    if (dryRun) {
      deleted.push(id)
      lines.push(`  [would-delete] ${id}  ${dir}`)
      continue
    }
    // Clear the archive set first: while the artifact still exists the registry
    // knows the Session, and an archived id would hide a later re-import.
    try {
      await registry?.unarchiveSession?.(id)
    } catch { /* not archived / registry absent — nothing to undo */ }
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      refused.push([id, String(error?.message ?? error)])
      continue
    }
    try {
      await rm(join(cache, `${id}.json`), { force: true })
    } catch { /* cache is derived; a stale file is harmless */ }
    deleted.push(id)
    lines.push(`  [deleted] ${id}`)
  }

  const verb = dryRun ? 'would-delete' : 'deleted'
  const summary = [`[codex] ${verb} ${deleted.length}, missing ${missing.length}, refused ${refused.length}`]
  if (refused.length > 0) summary.push(...refused.map(([id, why]) => `  [refused] ${id}: ${why}`))
  if (missing.length > 0) summary.push(`  [hint] ${missing.length} 个会话不在 DSH 的会话存储里（可能已删除），已跳过`)
  if (deleted.length > 0 && !dryRun) summary.push('  [hint] 侧边栏列表由 dsh 自己维护，若仍显示旧条目，重启 dsh 或点「刷新列表」')
  return { lines: [...lines, ...summary], deleted, refused, missing }
}
