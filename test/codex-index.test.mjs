/**
 * codex-index: titles and project names must come from Codex's own state
 * (`state_5.sqlite`), with `session_index.jsonl` and the rollout as fallbacks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexOriginOf,
  codexProjectOf,
  codexTitleOf,
  invalidateCodexIndex,
  loadCodexIndex,
  normalizePath,
} from '../lib/codex-index.mjs'

let sqlite
try {
  sqlite = (await import('node:sqlite')).DatabaseSync
} catch {
  sqlite = undefined
}

/** A codex home with a state DB (threads/projects/project_roots) + jsonl index. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cx-index-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'session_index.jsonl'), [
    JSON.stringify({ id: 'only-in-jsonl', thread_name: 'indexed name' }),
    JSON.stringify({ id: 'named', thread_name: 'stale index name' }),
  ].join('\n'))
  if (sqlite === undefined) return home

  const db = new sqlite(join(home, 'state_5.sqlite'))
  db.exec(`
    CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, project_id TEXT, source TEXT);
    CREATE TABLE projects (id TEXT, name TEXT);
    CREATE TABLE project_roots (project_id TEXT, path TEXT);
  `)
  const thread = db.prepare('INSERT INTO threads (id, name, title, cwd, project_id, source) VALUES (?, ?, ?, ?, ?, ?)')
  thread.run('named', '修复游客模式刷卡失败', '# Selected text:\n\n## Selection', '\\\\?\\D:\\repo\\app', null, 'vscode')
  thread.run('named-only-in-db', '数据库标题', null, '\\\\?\\D:\\repo\\app', null, 'vscode')
  thread.run('prompt-only', null, '帮我把这个函数重写一下', null, null, 'cli')
  thread.run('guardian', 'Guardian review', null, '\\\\?\\D:\\repo\\app', null, '{"subagent":{"other":"guardian"}}')
  thread.run('spawned', 'worker', null, '\\\\?\\D:\\repo\\app', null,
    '{"subagent":{"thread_spawn":{"parent_thread_id":"parent-1","depth":1}}}')
  thread.run('grouped', '另一个仓库里的会话', null, '\\\\?\\D:\\repo\\second', 'p-1', 'vscode')
  const project = db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
  project.run('p-1', 'mono-repo')
  const root = db.prepare('INSERT INTO project_roots (project_id, path) VALUES (?, ?)')
  root.run('p-1', 'D:\\repo')
  root.run('p-1', 'D:\\repo\\second')
  db.close()
  return home
}

test('normalizePath strips the Windows extended prefix and case-folds drive paths', () => {
  assert.equal(normalizePath('\\\\?\\D:\\Repo\\App\\'), 'd:/repo/app')
  assert.equal(normalizePath('D:/repo/app'), 'd:/repo/app')
  assert.equal(normalizePath(undefined), '')
})

test('titles prefer the SQLite name, then session_index, then threads.title', () => {
  const home = fixture()
  invalidateCodexIndex(home)
  const index = loadCodexIndex(home)
  if (sqlite === undefined) return
  // `name` is what Codex's sidebar shows; `title` here is a pasted prompt.
  assert.equal(codexTitleOf(index, 'named'), '修复游客模式刷卡失败')
  assert.equal(codexTitleOf(index, 'named-only-in-db'), '数据库标题')
  // no name/title in the DB → the jsonl index is used …
  assert.equal(codexTitleOf(index, 'only-in-jsonl'), 'indexed name')
  // … and threads.title is the last resort (Codex shows it the same way).
  assert.equal(codexTitleOf(index, 'prompt-only'), '帮我把这个函数重写一下')
  assert.equal(codexTitleOf(index, 'unknown-thread'), undefined)
})

test('projects resolve by project_id and by the longest matching root', () => {
  const home = fixture()
  invalidateCodexIndex(home)
  const index = loadCodexIndex(home)
  if (sqlite === undefined) return
  assert.equal(codexProjectOf(index, 'grouped', undefined)?.name, 'mono-repo')
  // No project_id, but the cwd sits under a known root → same project.
  assert.equal(codexProjectOf(index, 'named', '\\\\?\\D:\\repo\\app')?.name, 'mono-repo')
  // The more specific root wins when roots nest.
  assert.equal(codexProjectOf(index, 'unknown', 'D:\\repo\\second\\src')?.name, 'mono-repo')
  // Nothing matches → no project (caller falls back to the folder name).
  assert.equal(codexProjectOf(index, 'unknown', 'E:\\elsewhere'), undefined)
})

test('origin distinguishes user chats from guardian reviews and spawned sub-agents', () => {
  const home = fixture()
  invalidateCodexIndex(home)
  const index = loadCodexIndex(home)
  if (sqlite === undefined) return
  assert.equal(codexOriginOf(index, 'named')?.kind, 'user')
  assert.equal(codexOriginOf(index, 'guardian')?.kind, 'guardian')
  assert.equal(codexOriginOf(index, 'spawned')?.kind, 'subagent')
  assert.equal(codexOriginOf(index, 'spawned')?.parentThreadId, 'parent-1')
  assert.equal(codexOriginOf(index, 'unknown'), undefined)
})

test('without a state DB the JSONL index still supplies titles', () => {
  const home = mkdtempSync(join(tmpdir(), 'cx-index-jsonl-'))
  writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: 'a', thread_name: '旧版名称' }))
  invalidateCodexIndex(home)
  const index = loadCodexIndex(home)
  assert.equal(index.source, 'jsonl')
  assert.equal(codexTitleOf(index, 'a'), '旧版名称')
  assert.equal(codexOriginOf(index, 'a'), undefined)
})
