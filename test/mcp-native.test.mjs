import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeRequire } from '../scripts/run-contract-tests.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchMcp } from '../lib/mcp-lifecycle.js'
import { mountMcpServers } from '../lib/mcp.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { temporary, eventually } from './live-helpers.mjs'
const require = runtimeRequire('native')
const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: Tools } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
const native = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-mcp-client')).href)

test('native current MCP client discovers/calls/unregisters/re-adds a hermetic stdio server', async () => {
  const ctx = new Context()
  class Prompt extends Service {
    constructor(c) { super(c, 'systemPrompt', true) }
    tools() { return () => {} }
    section() { return () => {} }
    getSectionOrder() { return 0 }
  }
  const prompt = await ctx.plugin(Prompt)
  const tools = await ctx.plugin(Tools)
  const cfg = { serverName: 'contract', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./stdio-mcp-fixture.mjs', import.meta.url))], failOnStartupError: true }
  let handle
  try {
    for (let generation = 0; generation < 2; generation++) {
      handle = await launchMcp(ctx, cfg, { timeoutMs: 10000, load: async () => native })
      assert.ok(ctx.tools.get('mcp__contract__ping'))
      const result = await ctx.tools.execute({ name: 'mcp__contract__ping', arguments: {}, callId: `synthetic-${generation}`, signal: new AbortController().signal })
      assert.equal(result.isError, false)
      assert.match(JSON.stringify(result.value), /synthetic-pong/)
      await handle.dispose()
      assert.equal(ctx.tools.get('mcp__contract__ping'), undefined)
    }
  } finally { await handle?.dispose(); await tools.dispose(); await prompt.dispose() }
})

test('explicit clients keep native reconnection after a transient initial failure', async t => {
  const fixture = await temporary(t)
  const ctx = new Context()
  class Prompt extends Service {
    constructor(c) { super(c, 'systemPrompt', true) }
    tools() { return () => {} }
    section() { return () => {} }
    getSectionOrder() { return 0 }
  }
  const prompt = await ctx.plugin(Prompt)
  const tools = await ctx.plugin(Tools)
  ctx.provide('loader', { import: async () => native })
  const counter = join(fixture.root, 'counter.txt')
  const handle = await mountMcpServers(ctx, [['retry', { transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./retry-mcp-fixture.mjs', import.meta.url)), counter], reconnect: { enabled: true, initialDelayMs: 25, maxDelayMs: 25, maxAttempts: 3 } }]])
  try {
    await eventually(() => Boolean(ctx.tools.get('mcp__retry__ping')))
    assert.ok(Number(await readFile(counter, 'utf8')) > 2)
  } finally { await handle.dispose(); await tools.dispose(); await prompt.dispose() }
})

test('explicit native clients survive tools arriving after their registration', async () => {
  const ctx = new Context()
  class Prompt extends Service {
    constructor(c) { super(c, 'systemPrompt', true) }
    tools() { return () => {} }
    section() { return () => {} }
    getSectionOrder() { return 0 }
  }
  const prompt = await ctx.plugin(Prompt)
  ctx.provide('loader', { import: async () => native })
  const handle = await mountMcpServers(ctx, [['late', { transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./stdio-mcp-fixture.mjs', import.meta.url))] }]])
  let tools
  try {
    tools = await ctx.plugin(Tools)
    await eventually(() => Boolean(ctx.tools.get('mcp__late__ping')))
  } finally { await handle.dispose(); await tools?.dispose(); await prompt.dispose() }
})
