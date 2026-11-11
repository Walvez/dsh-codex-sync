/**
 * attach-workspaces: workspace titles come from the Codex project name (with the
 * folder name as fallback) and never embed a filesystem path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachSessionsToWorkspaces, unifyWorkspaceTitles, workspaceTitle } from '../lib/attach-workspaces.mjs'
import { codexProjectNameForPath, invalidateCodexIndex, loadCodexIndex } from '../lib/codex-index.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let sqlite
try {
  sqlite = (await import('node:sqlite')).DatabaseSync
} catch {
  sqlite = undefined
}

/** Codex home whose project groups two repo roots under one project name. */
function codexHomeWithProject() {
  const home = mkdtempSync(join(tmpdir(), 'cx-ws-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  if (sqlite === undefined) return home
  const db = new sqlite(join(home, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, project_id TEXT, source TEXT); CREATE TABLE projects (id TEXT, name TEXT); CREATE TABLE project_roots (project_id TEXT, path TEXT);')
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('p-1', 'zbwx-v2')
  const root = db.prepare('INSERT INTO project_roots (project_id, path) VALUES (?, ?)')
  root.run('p-1', String.raw`D:\ws\ZBWX\2.0\zbwx-frontend-v2`)
  root.run('p-1', String.raw`D:\ws\ZBWX\2.0\zbwx-services-v2`)
  db.close()
  return home
}

/** Minimal workspaceRegistry stand-in recording created titles. */
function fakeRegistry() {
  const byPath = new Map()
  const created = []
  const make = (path, title) => {
    const workspace = {
      path,
      title,
      attached: [],
      setTitle: async (next) => { workspace.title = next },
      attachSession: async (id) => { workspace.attached.push(id) },
    }
    return workspace
  }
  return {
    created,
    resolveByPath: async (path) => byPath.get(path),
    create: async (path, title) => {
      const workspace = make(path, title)
      byPath.set(path, workspace)
      created.push({ path, title })
      return workspace
    },
    list: () => [...byPath.values()],
  }
}

test('workspace titles use the Codex project name and never embed a path', () => {
  const home = codexHomeWithProject()
  invalidateCodexIndex(home)
  const index = loadCodexIndex(home)
  const projectNameOf = (cwd) => codexProjectNameForPath(index, cwd)

  const repo = String.raw`\\?\D:\ws\ZBWX\2.0\zbwx-frontend-v2`
  if (sqlite !== undefined) {
    assert.equal(codexProjectNameForPath(index, repo), 'zbwx-v2')
    assert.equal(workspaceTitle(repo, projectNameOf), 'zbwx-v2')
  }
  // No project → the folder name, still no path in the title.
  const loose = String.raw`C:\Users\neo\Documents\Codex\2026-11-06\new-chat-2`
  assert.equal(workspaceTitle(loose, projectNameOf), 'new-chat-2')
  assert.ok(!workspaceTitle(loose, projectNameOf).includes('\\'))
  assert.ok(!workspaceTitle(repo, projectNameOf).includes('('))
})

test('attach renames only auto-generated titles, leaving custom ones alone', async () => {
  const home = codexHomeWithProject()
  invalidateCodexIndex(home)
  const index = loadCodexIndex(home)
  const registry = fakeRegistry()
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  const repo = String.raw`D:\ws\ZBWX\2.0\zbwx-frontend-v2`

  // First attach creates the workspace under the project name.
  await attachSessionsToWorkspaces(ctx, [{ id: 'codex-1', cwd: repo }], {
    projectNameOf: (cwd) => codexProjectNameForPath(index, cwd),
  })
  const expected = sqlite === undefined ? 'zbwx-frontend-v2' : 'zbwx-v2'
  assert.equal(registry.created.length, 1)
  assert.equal(registry.created[0].title, expected)

  // A legacy path-style title (what older builds wrote) is migrated.
  const workspace = registry.list()[0]
  workspace.title = 'zbwx-frontend-v2 (~/ws/ZBWX/2.0/zbwx-frontend-v2)'
  await attachSessionsToWorkspaces(ctx, [{ id: 'codex-2', cwd: repo }], {
    projectNameOf: (cwd) => codexProjectNameForPath(index, cwd),
  })
  assert.equal(workspace.title, expected)
  assert.deepEqual(workspace.attached, ['codex-1', 'codex-2'])

  // A user-chosen title is preserved.
  workspace.title = '我的项目'
  await attachSessionsToWorkspaces(ctx, [{ id: 'codex-3', cwd: repo }], {
    projectNameOf: (cwd) => codexProjectNameForPath(index, cwd),
  })
  assert.equal(workspace.title, '我的项目')
})

test('unifyWorkspaceTitles strips path-form titles but keeps custom ones', async () => {
  const home = codexHomeWithProject()
  invalidateCodexIndex(home)
  const index = loadCodexIndex(home)
  const registry = fakeRegistry()
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  const repo = String.raw`D:\ws\ZBWX\2.0\zbwx-frontend-v2`
  await registry.create(repo, 'zbwx-frontend-v2 (~/ws/ZBWX/2.0/zbwx-frontend-v2)')
  const loose = String.raw`C:\Users\neo\Documents\Codex\2026-11-06\new-chat-2`
  await registry.create(loose, 'new-chat-2 (new-chat-2)')
  await registry.create('D:/custom', '自定义名字 (x)')

  const changed = await unifyWorkspaceTitles(ctx, { projectNameOf: (cwd) => codexProjectNameForPath(index, cwd) })
  const titles = registry.list().map((w) => w.title)
  assert.equal(changed, 2)
  assert.ok(titles.includes(sqlite === undefined ? 'zbwx-frontend-v2' : 'zbwx-v2'))
  assert.ok(titles.includes('new-chat-2'))
  assert.ok(titles.includes('自定义名字 (x)'))
})
