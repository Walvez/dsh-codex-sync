import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { readCodexTitles } from '../lib/codex-titles.mjs'
import { listImportCatalog, importCodex } from '../lib/import-service.js'
import { parseCodexSession } from '../lib/codex-reader.mjs'

function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-titles-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function sql(root, statement) {
  execFileSync('sqlite3', [join(root, 'state_5.sqlite'), statement])
}
function rollout(root, id, title, text = 'First prompt') {
  const dir = join(root, 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${id}.jsonl`)
  const events = [
    { type: 'session_meta', payload: { id, cwd: '/tmp/project', title, timestamp: '2026-10-20T00:00:00Z' } },
    { type: 'response_item', timestamp: '2026-10-20T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  ]
  writeFileSync(file, events.map(x => JSON.stringify(x)).join('\n'))
  return file
}
function dest() {
  const store = new Map()
  return { store, persistence: {
    async list() { return [...store.values()].map(x => x.meta) },
    async create(meta) { store.set(meta.id, { meta, events: [] }) },
    async append(id, events) { store.get(id).events.push(...events) },
    async inspect(id) { return store.get(id) },
  } }
}

test('latest index entries survive malformed lines; current DB name/title take precedence', t => {
  const root = home(t)
  writeFileSync(join(root, 'session_index.jsonl'), [
    { id: 'a', thread_name: 'Old' }, { id: 'a', thread_name: 'Index renamed' },
    { id: 'b', thread_name: 'Index B' }, { id: 'c', thread_name: 'Index C' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n{partial')
  assert.equal(readCodexTitles(root).get('a'), 'Index renamed')
  sql(root, "CREATE TABLE threads(id TEXT, name TEXT, title TEXT); INSERT INTO threads VALUES('a','Renamed 正式标题','Old DB'),('b',' ','DB B'),('c',NULL,'');")
  const titles = readCodexTitles(root)
  assert.equal(titles.get('a'), 'Renamed 正式标题')
  assert.equal(titles.get('b'), 'DB B')
  assert.equal(titles.get('c'), 'Index C')
  sql(root, "UPDATE threads SET name='Changed again' WHERE id='a';")
  assert.equal(readCodexTitles(root).get('a'), 'Changed again')
})

test('older DB schemas and corrupt/missing databases retain title fallbacks', t => {
  const root = home(t)
  assert.equal(readCodexTitles(root).size, 0)
  sql(root, "CREATE TABLE threads(id TEXT,title TEXT); INSERT INTO threads VALUES('a','Legacy title');")
  assert.equal(readCodexTitles(root).get('a'), 'Legacy title')
  rmSync(join(root, 'state_5.sqlite'))
  writeFileSync(join(root, 'state_5.sqlite'), 'invalid sqlite')
  writeFileSync(join(root, 'session_index.jsonl'), JSON.stringify({ id: 'a', thread_name: 'Index title' }))
  assert.equal(readCodexTitles(root).get('a'), 'Index title')
})

test('catalog and actual import use full saved titles; rollout, first-prompt and ID fallbacks remain', async t => {
  const root = home(t)
  const full = '正式标题'.repeat(30)
  sql(root, `CREATE TABLE threads(id TEXT,title TEXT); INSERT INTO threads VALUES('a','${full}');`)
  rollout(root, 'a', 'Old rollout title')
  const file = rollout(root, 'b', 'Rollout title')
  assert.equal(parseCodexSession(file).header.title, 'Rollout title')
  rollout(root, 'c', undefined)
  rollout(root, 'd', undefined, '')
  const { persistence, store } = dest()
  const catalog = await listImportCatalog(persistence, {}, root)
  const names = new Map(catalog.projects.flatMap(p => p.sessions.map(n => [n.rawId, n.title])))
  assert.equal(names.get('a'), '[codex] ' + full)
  assert.equal(names.get('b'), '[codex] Rollout title')
  assert.equal(names.get('c'), '[codex] First prompt')
  assert.equal(names.get('d'), 'codex-d')
  await importCodex({ get: () => undefined }, persistence, {}, root)
  const title = store.get('codex-a').events.find(e => e.type === 'session/title')
  assert.equal(title.data.title, '[codex] ' + full)
  sql(root, "UPDATE threads SET title='Renamed later' WHERE id='a';")
  const refreshed = await listImportCatalog(persistence, {}, root)
  assert.equal(refreshed.projects[0].sessions.find(n => n.rawId === 'a').title, '[codex] Renamed later')
  await importCodex({ get: () => undefined }, persistence, {}, root)
  assert.equal(store.get('codex-a').events.filter(e => e.type === 'session/title').length, 1)
})
