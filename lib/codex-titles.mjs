/** Read local Codex display titles once per import/catalog request. Never writes. */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const usable = value => typeof value === 'string' && value.trim().length > 0

export function readCodexTitles(codexHome) {
  const titles = new Map()
  try {
    for (const line of readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8').split('\n')) {
      try {
        const row = JSON.parse(line)
        if (typeof row.id === 'string' && usable(row.thread_name)) titles.set(row.id, row.thread_name)
      } catch { /* A partial or malformed line must not hide other entries. */ }
    }
  } catch { /* The index is optional. */ }

  const path = join(codexHome, 'state_5.sqlite')
  if (!existsSync(path)) return titles
  let db
  try {
    // The desktop host supplies native SQLite; Node 20 can use the same CLI
    // already used by the reverse exporter. Both paths open read-only.
    let DatabaseSync
    try { ({ DatabaseSync } = require('node:sqlite')) } catch {}
    if (DatabaseSync) db = new DatabaseSync(path, { readOnly: true })
    const query = sql => db ? db.prepare(sql).all() : JSON.parse(execFileSync('sqlite3', [
      '-readonly', '-json', path, sql,
    ], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || '[]')
    const columns = new Set(query('PRAGMA table_info(threads)').map(row => row.name))
    if (!columns.has('id')) return titles
    const fields = ['name', 'title'].filter(key => columns.has(key))
    if (fields.length === 0) return titles
    for (const row of query(`SELECT id, ${fields.join(', ')} FROM threads`)) {
      const title = fields.map(key => row[key]).find(usable)
      if (typeof row.id === 'string' && title !== undefined) titles.set(row.id, title)
    }
  } catch { /* Missing CLI, locked/unsupported DB: retain index/rollout fallbacks. */ }
  finally { db?.close() }
  return titles
}
