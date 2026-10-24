import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import semver from 'semver'
import * as bundle from '../lib/index.js'
import { prepareNativeMcp, assertSkillControl, RuntimeCompatibilityError } from '../lib/runtime-compat.js'
import { launchMcp } from '../lib/mcp-lifecycle.js'
import { safeMcpError } from '../lib/mcp-config.js'
import { mcpSchema, Config } from './mcp-schema-fixture.mjs'
import { temporary, environment, eventually } from './live-helpers.mjs'

const http = { serverName: 'fixture', transport: 'streamable-http', url: 'https://example.invalid/mcp', headers: { Authorization: 'synthetic-secret' }, reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 20 } }
const stdio = { serverName: 'fixture', transport: 'stdio', command: 'synthetic-command', args: ['synthetic'], env: { TEST_VALUE: 'synthetic' }, cwd: 'synthetic-cwd' }
const moduleFor = Config => ({ Config, async apply() {} })

test('Host compatibility admits a bounded patch/prerelease family without RC pins', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const version of ['0.0.1-rc.1', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.999', '0.2.1', '0.2.2-alpha.1', '0.2.2-rc.1', '0.2.8']) {
    assert.equal(semver.satisfies(version, pkg.engines.dsh, { includePrerelease: true }), true, version)
  }
  for (const version of ['0.2.0-rc.1', '0.3.0-0', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
    assert.equal(semver.satisfies(version, pkg.engines.dsh, { includePrerelease: true }), false, version)
  }
  // npm's peer matcher does not use the Host's includePrerelease option.
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.999']) assert.equal(semver.satisfies(version, pkg.peerDependencies['@deepseek-ai/dsh-mcp-client']), true, version)
})
test('native namespace/default exports and declared settings remain compatible', () => {
  const plugin = async () => {}
  const input = structuredClone(http)
  const result = prepareNativeMcp({ default: plugin, Config }, input)
  assert.equal(result.plugin, plugin)
  assert.deepEqual(result.config.headers, input.headers)
  assert.deepEqual(input, http)
  assert.throws(() => prepareNativeMcp({ apply() {} }, http), /mcp-client-api-unsupported/)
})
test('passthrough of a removed cwd field cannot masquerade as native support', () => {
  const schema = mcpSchema(); delete schema.list[0].dict.cwd
  assert.equal(schema(structuredClone(stdio)).cwd, stdio.cwd)
  assert.throws(() => prepareNativeMcp(moduleFor(schema), stdio), /mcp-config-contract-changed/)
})
test('removed nested reconnect fields and unknown transports fail closed', () => {
  const schema = mcpSchema({ reconnect: z.object({ initialDelayMs: z.number(), maxDelayMs: z.number(), maxAttempts: z.number() }) })
  assert.equal(schema(structuredClone(http)).reconnect.enabled, true)
  assert.throws(() => prepareNativeMcp(moduleFor(schema), http), /mcp-config-contract-changed/)
  assert.throws(() => prepareNativeMcp(moduleFor(Config), { ...http, transport: 'unknown' }), /mcp-config-contract-changed/)
})
test('added native defaults are allowed but explicit env/header maps cannot broaden', () => {
  const schema = mcpSchema({ addedDefault: z.boolean().default(true) })
  assert.equal(prepareNativeMcp(moduleFor(schema), http).config.addedDefault, true)
  const modified = input => { const output = Config(input); output.headers.EXTRA_CREDENTIAL = 'synthetic'; return output }
  Object.assign(modified, { type: Config.type, list: Config.list })
  assert.throws(() => prepareNativeMcp(moduleFor(modified), http), /mcp-config-contract-changed/)
})
test('native schema errors and unfamiliar schema forms never expose configuration values', () => {
  const schema = Object.assign(() => { throw new Error('synthetic-secret') }, { type: Config.type, list: Config.list })
  try { prepareNativeMcp(moduleFor(schema), http); assert.fail('expected rejection') }
  catch (error) { assert.equal(safeMcpError(error), 'mcp-config-rejected'); assert.ok(!error.message.includes('synthetic-secret')) }
  assert.throws(() => prepareNativeMcp(moduleFor(Object.assign(input => input, { type: 'lazy' })), http), /mcp-config-contract-changed/)
})
test('unsupported native config is rejected before creating a child or resolving an executable', async () => {
  let calls = 0
  const ctx = { get: () => ({ resolveExecutable() { calls++ } }), plugin() { calls++ } }
  const schema = mcpSchema(); delete schema.list[0].dict.env
  await assert.rejects(launchMcp(ctx, stdio, { load: async () => moduleFor(schema) }), /mcp-config-contract-changed/)
  assert.equal(calls, 0)
})
test('a changed optional stdio resolver does not disable HTTP clients', async () => {
  const ctx = new Context(); let starts = 0
  ctx.provide('subprocess', { resolveExecutable: true })
  const native = { Config, async apply() { starts++ } }
  await assert.rejects(launchMcp(ctx, stdio, { load: async () => native }), /subprocess-api-unsupported/)
  assert.equal(starts, 0)
  const handle = await launchMcp(ctx, http, { load: async () => native })
  try { assert.equal(starts, 1) } finally { await handle.dispose() }
})
test('Skill provider control requires owned cancellation and invalidation', () => {
  assert.doesNotThrow(() => assertSkillControl({ signal: new AbortController().signal, invalidate() {} }))
  for (const control of [undefined, {}, { signal: new AbortController().signal }, { signal: { aborted: false }, invalidate() {} }]) {
    assert.throws(() => assertSkillControl(control), /skills-provider-control-unsupported/)
  }
})

async function host(t, { skills, native } = {}) {
  const f = await temporary(t); environment(t, { DSH_HOME: f.root, CODEX_HOME: f.root })
  await mkdir(join(f.root, 'skills'))
  await writeFile(join(f.root, 'skills', 'synthetic.md'), '---\nname: synthetic\ndescription: Synthetic test skill\n---\nfixture body\n')
  await writeFile(join(f.root, 'config.toml'), "[mcp_servers.synthetic]\nurl='https://example.invalid/mcp'\n")
  const ctx = new Context(); const commands = new Map(); const providers = new Set(); let starts = 0
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('commands', { register(row) { commands.set(row.name, row); return () => commands.delete(row.name) } })
  ctx.provide('skills', skills ?? { registerProvider(create) {
    const controller = new AbortController()
    const provider = create({ signal: controller.signal, invalidate() {} })
    providers.add(provider)
    return () => { controller.abort(); providers.delete(provider) }
  } })
  ctx.provide('loader', { import: async () => {
    if (native === false) throw new Error('synthetic-sensitive-import-error')
    return { Config, async apply() { starts++ } }
  } })
  const fiber = ctx.plugin(bundle, { codexHome: f.root, autoImport: false, enableInstructions: false, enableConfig: false })
  f.own(() => fiber.dispose())
  await fiber.await()
  return { ctx, fiber, commands, providers, starts: () => starts }
}
test('unsupported Skills registry leaves commands and MCP active', async t => {
  const h = await host(t, { skills: { registerProvider: true } })
  await eventually(() => h.starts() === 1)
  assert.equal(h.fiber.state, 2); assert.ok(h.commands.has('mcp-status'))
})
test('unsupported provider control leaves no Skills registration or watcher behind', async t => {
  const h = await host(t, { skills: { registerProvider(create) { create({ signal: new AbortController().signal }); throw new Error('must not create a watcher') } } })
  await eventually(() => h.starts() === 1)
  assert.equal(h.fiber.state, 2); assert.equal(h.providers.size, 0)
})
test('a second Skills registration failure rolls back the first and closes its watcher', async t => {
  const rows = new Set(), created = []; let attempts = 0, released = 0
  const h = await host(t, { skills: { registerProvider(create) {
    const controller = new AbortController()
    const provider = create({ signal: controller.signal, invalidate() {} }); created.push(provider)
    if (++attempts === 2) throw new Error('synthetic-sensitive-registration-error')
    rows.add(provider)
    return () => { released++; controller.abort(); rows.delete(provider) }
  } } })
  await eventually(() => created.length === 2 && released === 1 && rows.size === 0)
  await eventually(async () => (await created.find(p => p.name === 'codex').list()).length === 0)
  assert.equal(h.fiber.state, 2)
  await eventually(() => h.starts() === 1)
})
test('native MCP import failure preserves both watched Skill providers and status', async t => {
  const h = await host(t, { native: false })
  await eventually(() => h.providers.size === 2)
  const result = await h.commands.get('mcp-status').handler({ rawInput: '' })
  assert.equal(h.fiber.state, 2); assert.equal(h.starts(), 0)
  assert.ok(!JSON.stringify(result).includes('synthetic-sensitive'))
})
