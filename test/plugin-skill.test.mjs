import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../lib/bridge.js'
import { registerPluginSkillProvider } from '../lib/skill-provider.js'

const ROOT = join(import.meta.dirname, '..')

test('bundled codex-sync skill has name, description, whenToUse, and import dry-run docs', () => {
  const raw = readFileSync(join(ROOT, 'skills', 'codex-sync', 'SKILL.md'), 'utf8')
  const { meta, body } = parseFrontmatter(raw)
  assert.equal(meta.name, 'codex-sync')
  assert.match(String(meta.description), /import|sync|MCP/i)
  assert.ok(meta.whenToUse)
  assert.match(body, /\/import-codex --dry-run/)
  assert.match(body, /\/codex-settings/)
  assert.match(body, /\/mcp-status/)
})

test('plugin skill provider lists codex-sync', async () => {
  const control = { signal: { aborted: false } }
  const provider = registerPluginSkillProvider('', {}, control)
  const list = await provider.list()
  const names = list.map((s) => s.name)
  assert.ok(names.includes('codex-sync'), `got ${names.join(',')}`)
  const full = await provider.get(list.find((s) => s.name === 'codex-sync'))
  assert.match(full.content, /dry-run/)
})
