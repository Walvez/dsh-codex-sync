/**
 * Codex's own catalog of threads and projects, read from `~/.codex/state_5.sqlite`.
 *
 * A rollout file only carries `session_meta` (id/cwd) and the conversation — no
 * display name and no project. Codex Desktop keeps both in its SQLite state:
 *
 *   threads.name            the title the user sees (threads.title is often just
 *                           the raw first message, e.g. "# Selected text: …")
 *   threads.cwd             the rollout's directory, usually prefixed `\\?\`
 *   threads.project_id      the project the thread belongs to (sparse)
 *   projects.name           the project's display name
 *   project_roots.path      every root directory of a project (a project groups
 *                           several repos, so several cwds share one name)
 *
 * Reading this is what keeps imported titles and project names identical to
 * Codex's sidebar. `~/.codex/session_index.jsonl` ({id, thread_name}) is the
 * fallback for older builds that predate the SQLite state, and the rollout
 * contents are the last resort.
 *
 * `node:sqlite` ships with Node 22.5+; on older runtimes this module degrades to
 * the JSONL index instead of failing the import.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const cache = new Map()

/**
 * Normalize a Codex path for comparison: strip the Windows extended-length
 * prefix, unify separators, drop trailing separators, case-fold (Windows
 * paths are case-insensitive and Codex mixes cases freely).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  let path = value.trim()
  if (path.startsWith('\\\\?\\')) path = path.slice(4)
  path = path.replace(/\\/gu, '/')
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return /^[a-z]:\//iu.test(path) ? path.toLowerCase() : path
}

/** Last path segment, for cwds that belong to no Codex project. */
export function baseName(value) {
  const path = normalizePath(value)
  if (path.length === 0) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** `{id, thread_name}` entries from ~/.codex/session_index.jsonl (older builds). */
function readSessionIndex(codexHome) {
  const titles = new Map()
  const file = join(codexHome, 'session_index.jsonl')
  if (!existsSync(file)) return titles
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return titles
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const entry = JSON.parse(trimmed)
      if (typeof entry?.id === 'string' && typeof entry?.thread_name === 'string' && entry.thread_name.length > 0) {
        titles.set(entry.id, entry.thread_name)
      }
    } catch {
      /* skip malformed line */
    }
  }
  return titles
}

/**
 * Classify a `threads.source` value.
 *
 * Codex stores either a plain origin string (`vscode`, `cli`, `exec`, …) for a
 * user chat, or a JSON object for internal threads:
 *   {"subagent":{"other":"guardian"}}            → automated review threads
 *   {"subagent":{"thread_spawn":{parent_thread_id,…}}} → spawned sub-agents
 *
 * Only the plain origins are user-facing chats; the sidebar hides the rest.
 * @param {unknown} value
 * @returns {{kind: 'user' | 'subagent' | 'guardian', parentThreadId?: string}}
 */
function describeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return { kind: 'user' }
  const text = value.trim()
  if (!text.startsWith('{')) return { kind: 'user' }
  try {
    const parsed = JSON.parse(text)
    const subagent = parsed?.subagent
    if (subagent === undefined) return { kind: 'user' }
    if (subagent?.other === 'guardian') return { kind: 'guardian' }
    const parent = subagent?.thread_spawn?.parent_thread_id
    return { kind: 'subagent', ...(typeof parent === 'string' ? { parentThreadId: parent } : {}) }
  } catch {
    return { kind: 'user' }
  }
}

/** Read the SQLite state; returns undefined when unavailable (old Node, no file). */
function readSqliteState(codexHome) {  const file = join(codexHome, 'state_5.sqlite')
  if (!existsSync(file)) return undefined
  let sqlite
  try {
    // Imported lazily: Node < 22.5 has no node:sqlite and must not break import.
    sqlite = process.getBuiltinModule?.('node:sqlite')
  } catch {
    sqlite = undefined
  }
  if (!sqlite?.DatabaseSync) return undefined

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    return undefined
  }
  try {
    const threads = new Map()
    for (const row of db.prepare('SELECT id, name, title, cwd, project_id, source FROM threads').all()) {
      if (typeof row.id !== 'string') continue
      const origin = describeOrigin(row.source)
      threads.set(row.id, {
        name: typeof row.name === 'string' ? row.name : undefined,
        title: typeof row.title === 'string' ? row.title : undefined,
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        projectId: typeof row.project_id === 'string' ? row.project_id : undefined,
        kind: origin.kind,
        parentThreadId: origin.parentThreadId,
      })
    }
    const projects = new Map()
    for (const row of db.prepare('SELECT id, name FROM projects').all()) {
      if (typeof row.id !== 'string') continue
      projects.set(row.id, { name: typeof row.name === 'string' ? row.name : '', roots: [] })
    }
    for (const row of db.prepare('SELECT project_id, path FROM project_roots').all()) {
      const project = projects.get(row.project_id)
      if (project !== undefined && typeof row.path === 'string') project.roots.push(row.path)
    }
    return { threads, projects }
  } catch {
    return undefined
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Load (and cache) Codex's thread/project catalog for one codex home.
 * @param {string} codexHome
 * @returns {{
 *   threads: Map<string, {name?: string, title?: string, cwd?: string, projectId?: string}>,
 *   projects: Map<string, {name: string, roots: string[]}>,
 *   indexTitles: Map<string, string>,
 *   source: 'sqlite' | 'jsonl' | 'none',
 * }}
 */
export function loadCodexIndex(codexHome) {
  const cached = cache.get(codexHome)
  if (cached !== undefined) return cached

  const state = readSqliteState(codexHome)
  const indexTitles = readSessionIndex(codexHome)
  const entry = {
    threads: state?.threads ?? new Map(),
    projects: state?.projects ?? new Map(),
    indexTitles,
    source: state !== undefined ? 'sqlite' : (indexTitles.size > 0 ? 'jsonl' : 'none'),
  }
  cache.set(codexHome, entry)
  return entry
}

/** Drop the cached catalog (after a Codex rename, so the next read sees it). */
export function invalidateCodexIndex(codexHome) {
  if (codexHome === undefined) cache.clear()
  else cache.delete(codexHome)
}

/**
 * Display title for one Codex thread, or undefined when Codex has no name for it.
 * Prefers the SQLite `name` (what the sidebar shows), then the JSONL index, then
 * `threads.title` (the string Codex itself falls back to).
 */
export function codexTitleOf(index, rawId) {
  const thread = index.threads.get(rawId)
  const name = thread?.name?.trim()
  if (name) return name
  const indexed = index.indexTitles.get(rawId)?.trim()
  if (indexed) return indexed
  const title = thread?.title?.trim()
  return title ? title : undefined
}

/**
 * Codex's own view of what a thread is: a user chat, a spawned sub-agent, or an
 * automated guardian review. `undefined` when Codex has no row for the id.
 */
export function codexOriginOf(index, rawId) {
  const thread = index.threads.get(rawId)
  if (thread === undefined) return undefined
  return { kind: thread.kind ?? 'user', parentThreadId: thread.parentThreadId }
}

/** Codex project name + matched root for a thread, when it belongs to one. */
export function codexProjectOf(index, rawId, cwd) {  const thread = index.threads.get(rawId)
  if (thread?.projectId !== undefined) {
    const project = index.projects.get(thread.projectId)
    if (project !== undefined && project.name.length > 0) {
      return { name: project.name, root: normalizePath(thread.cwd ?? cwd) }
    }
  }
  const target = normalizePath(thread?.cwd ?? cwd)
  if (target.length === 0) return undefined
  // A project groups several roots (one monorepo per root); the longest root
  // that contains the cwd wins so nested repos resolve to their own project.
  let best
  for (const [id, project] of index.projects) {
    if (project.name.length === 0) continue
    for (const root of project.roots) {
      const normalized = normalizePath(root)
      if (normalized.length === 0) continue
      const matches = target === normalized || target.startsWith(`${normalized}/`)
      if (!matches) continue
      if (best === undefined || normalized.length > best.length) {
        best = { id, name: project.name, root: normalized, length: normalized.length }
      }
    }
  }
  return best === undefined ? undefined : { name: best.name, root: best.root }
}

/**
 * Codex project name for a bare directory, by the longest matching project root.
 * Used to name the DSH workspace a thread is attached to: Codex names the
 * project (`zbwx-v2`), while the folder it holds is just one of its repos
 * (`zbwx-frontend-v2`).
 * @returns {string | undefined}
 */
export function codexProjectNameForPath(index, cwd) {
  const target = normalizePath(cwd)
  if (target.length === 0) return undefined
  let best
  for (const project of index.projects.values()) {
    if (project.name.length === 0) continue
    for (const root of project.roots) {
      const normalized = normalizePath(root)
      if (normalized.length === 0) continue
      if (target !== normalized && !target.startsWith(`${normalized}/`)) continue
      if (best === undefined || normalized.length > best.length) best = { name: project.name, length: normalized.length }
    }
  }
  return best?.name
}
