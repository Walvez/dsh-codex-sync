/**
 * Per-item sync preferences (skillSync / mcpSync): state model, skill
 * filtering, MCP mirror gating, and the management command family.
 * Hermetic — throwaway DSH_HOME and codex home; no dsh install needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const PROJECT = join(import.meta.dirname, '..')

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'cx-sync-items-'))
  process.env.DSH_HOME = home
  return home
}

test('state: per-item sync groups default on, override, clear-to-default', async () => {
  const home = freshHome()
  try {
    const { readSyncGroup, effectiveItemSync, writeItemSync, writeSyncDefault, writeAllItemSync } =
      await import(join(PROJECT, 'lib', 'state.js'))
    // untouched → everything follows the default (true)
    assert.equal(readSyncGroup('skill').default, true)
    assert.equal(effectiveItemSync('skill', 'pdf'), true)
    // explicit off overrides the default
    assert.equal(writeItemSync('mcp', 'exa', false), false)
    assert.equal(effectiveItemSync('mcp', 'exa'), false)
    assert.equal(effectiveItemSync('mcp', 'cloudflare-api'), true)
    // clearing the override falls back to the group default
    assert.equal(writeItemSync('mcp', 'exa', null), true)
    assert.equal('exa' in readSyncGroup('mcp').items, false)
    // group default flip changes items without overrides
    writeSyncDefault('skill', false)
    assert.equal(readSyncGroup('skill').default, false)
    assert.equal(effectiveItemSync('skill', 'pdf'), false)
    assert.equal(writeItemSync('skill', 'pdf', true), true)
    assert.equal(effectiveItemSync('skill', 'pdf'), true)
    // select-all writes explicit overrides for the given names only
    const n = writeAllItemSync('skill', ['a', 'b'], false)
    assert.equal(n, 2)
    assert.equal(effectiveItemSync('skill', 'a'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('skills: provider list() hides user-disabled entries', async () => {
  const home = freshHome()
  const codexHome = mkdtempSync(join(tmpdir(), 'cx-sync-codexhome-'))
  try {
    const skillsDir = join(codexHome, 'skills')
    mkdirSync(join(skillsDir, 'alpha'), { recursive: true })
    mkdirSync(join(skillsDir, 'beta'), { recursive: true })
    writeFileSync(join(skillsDir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\nbody-a\n')
    writeFileSync(join(skillsDir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: b\n---\nbody-b\n')
    const { registerCodexSkillProvider } = await import(join(PROJECT, 'lib', 'skill-provider.js'))
    const { writeItemSync } = await import(join(PROJECT, 'lib', 'state.js'))

    const control = { signal: new AbortController().signal, invalidate: () => {} }
    const provider = registerCodexSkillProvider(codexHome, {}, control, () => true)
    let names = (await provider.list()).map((c) => c.name)
    assert.deepEqual(names.sort(), ['alpha', 'beta'])

    writeItemSync('skill', 'beta', false)
    names = (await provider.list()).map((c) => c.name)
    assert.deepEqual(names, ['alpha'])

    writeItemSync('skill', 'beta', null) // back to default-on
    names = (await provider.list()).map((c) => c.name)
    assert.deepEqual(names.sort(), ['alpha', 'beta'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(codexHome, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})

test('mirror: sync() gates servers by per-item preference and refresh() re-applies', async () => {
  const home = freshHome()
  const codexHome = mkdtempSync(join(tmpdir(), 'cx-sync-mcphome-'))
  try {
    writeFileSync(join(codexHome, 'config.toml'), `
[mcp_servers.alpha]
type = "stdio"
command = "echo"
[mcp_servers.beta]
type = "stdio"
command = "echo"
`)
    // Distinct fixture dir: node --test runs test FILES concurrently, and
    // host.smoke.mjs owns the canonical FAKE path — sharing it races the
    // two files' install/remove cycles.
    const fakeDir = join(PROJECT, 'node_modules', '.cx-sync-item-fixture', '@deepseek-ai', 'dsh-mcp-client')
    mkdirSync(fakeDir, { recursive: true })
    writeFileSync(join(fakeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', version: '0.0.0-fake', type: 'module', main: 'index.js' }))
    writeFileSync(join(fakeDir, 'index.js'), `
export default class FakeMcpClient {
  constructor(opts) { this.opts = opts; FakeMcpClient.instances.push(this) }
}
FakeMcpClient.instances = []
`)
    // Point the module resolver at the isolated fixture for this test.
    process.env.DSH_CX_SYNC_MCP_CLIENT_DIR = dirname(fakeDir)
    const { startMcpMirror } = await import(join(PROJECT, 'lib', 'mcp.js'))
    const { writeItemSync, effectiveItemSync } = await import(join(PROJECT, 'lib', 'state.js'))

    const mounted = []
    const ctx = {
      logger: { info() {}, warn() {} },
      plugin: async () => { mounted.push(1); return () => {} },
    }
    const mirror = startMcpMirror(ctx, codexHome, {})
    await mirror.refresh()
    let reasons = Object.fromEntries(mirror.getStatus().servers.map((s) => [s.name, s.reason]))
    assert.equal(reasons.alpha, 'mounted')
    assert.equal(reasons.beta, 'mounted')

    writeItemSync('mcp', 'beta', false)
    await mirror.refresh()
    reasons = Object.fromEntries(mirror.getStatus().servers.map((s) => [s.name, s.reason]))
    assert.equal(reasons.alpha, 'mounted')
    assert.equal(reasons.beta, 'user-disabled')

    writeItemSync('mcp', 'beta', null)
    await mirror.refresh()
    reasons = Object.fromEntries(mirror.getStatus().servers.map((s) => [s.name, s.reason]))
    assert.equal(reasons.beta, 'mounted')
    assert.equal(effectiveItemSync('mcp', 'beta'), true)

    mirror.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(codexHome, { recursive: true, force: true })
    rmSync(join(PROJECT, 'node_modules', '.cx-sync-item-fixture'), { recursive: true, force: true })
    delete process.env.DSH_CX_SYNC_MCP_CLIENT_DIR
    delete process.env.DSH_HOME
  }
})

test('commands: /codex-skills, /codex-skill all|one persist and report', async () => {
  const home = freshHome()
  const codexHome = mkdtempSync(join(tmpdir(), 'cx-sync-cmdhome-'))
  try {
    const skillsDir = join(codexHome, 'skills')
    mkdirSync(join(skillsDir, 'alpha'), { recursive: true })
    mkdirSync(join(skillsDir, 'gamma'), { recursive: true })
    writeFileSync(join(skillsDir, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nx\n')
    writeFileSync(join(skillsDir, 'gamma', 'SKILL.md'), '---\nname: gamma\n---\nx\n')

    const registered = new Map()
    const ctx = {
      commands: { register: (cmd) => registered.set(cmd.name, cmd) },
      logger: { info() {}, warn() {} },
      get: () => undefined,
      effect: () => () => {},
      plugin: () => ({ apply() {} }), // nested http plugin: stub, never applied
      systemPrompt: { section: () => {} },
    }
    const plugin = await import(join(PROJECT, 'lib', 'index.js'))
    plugin.apply(ctx, { codexHome })

    const raw = (inv) => ({ rawInput: inv })
    // list shows both, default on
    const listText = registered.get('codex-skills').handler().text
    assert.match(listText, /alpha=on/)
    assert.match(listText, /gamma=on/)
    assert.match(listText, /default=on/)
    // toggle one off → persisted + listed off
    const offReport = await registered.get('codex-skill').handler(raw('gamma off'))
    assert.match(offReport.text, /gamma=off/)
    const list2 = registered.get('codex-skills').handler().text
    assert.match(list2, /gamma=off/)
    assert.match(list2, /alpha=on/)
    // select-all off flips every known item
    await registered.get('codex-skill').handler(raw('all off'))
    const list3 = registered.get('codex-skills').handler().text
    assert.match(list3, /alpha=off/)
    assert.match(list3, /gamma=off/)
    // group default via /codex-setting
    const defRep = registered.get('codex-setting').handler(raw('skillSyncDefault off')).text
    assert.match(defRep, /skillSyncDefault=off/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(codexHome, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})
