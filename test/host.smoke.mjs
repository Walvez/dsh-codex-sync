/**
 * Host-side smoke test: plugin applies under a stub context, commands are
 * registered, invocation-style args parse, /auto-import persists, and the
 * MCP mirror reports per-server status. Run: `node --test test/host.smoke.mjs`
 *
 * The mirror's `loadMcpClient()` does a dynamic `import('@deepseek-ai/dsh-mcp-client')`;
 * for the test we drop a fake package into the project's node_modules before
 * importing the plugin and clean it up afterwards.
 *
 * The mirror is tested directly (not through the plugin row) so the test
 * owns its handle and can dispose it — closing the fs.watch handle that
 * would otherwise keep the event loop alive and hang the test runner.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dshDep } from './_env.mjs'

const PROJECT = join(import.meta.dirname, '..')
const STATE_DIR = process.env.DSH_HOME ?? join(tmpdir(), 'cx-sync-state-test')

test('state: persisted settings override config defaults (DSH_HOME temp)', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'cx-sync-state-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
  try {
    const { effectiveSetting, writeState, readState } = await import(join(PROJECT, 'lib', 'state.js'))
    // untouched → config defaults win
    assert.equal(effectiveSetting('enableInstructions', true), true)
    assert.equal(effectiveSetting('enableInstructions', false), false)
    assert.equal(effectiveSetting('autoImport', false), false)
    // persisted true overrides a false config default (the UI's "turn it on")
    writeState({ enableInstructions: true })
    assert.equal(effectiveSetting('enableInstructions', false), true)
    // persisted false overrides a true config default (the UI's "turn it off")
    writeState({ enableInstructions: false })
    assert.equal(effectiveSetting('enableInstructions', true), false)
    // autoImport still routes through the same store
    writeState({ autoImport: true })
    assert.equal(effectiveSetting('autoImport', false), true)
    const raw = readState()
    assert.equal(raw.autoImport, true)
    assert.equal(raw.enableInstructions, false)
  } finally {
    process.env.DSH_HOME = prevHome ?? ''
    rmSync(tempHome, { recursive: true, force: true })
  }
})
const FAKE = join(PROJECT, 'node_modules', '@deepseek-ai', 'dsh-mcp-client')

function installFakeMcpClient() {
  mkdirSync(FAKE, { recursive: true })
  writeFileSync(join(FAKE, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', version: '0.0.0-fake', type: 'module', main: 'index.js' }))
  writeFileSync(join(FAKE, 'index.js'), 'export default class FakeMcpClient { constructor() {} }\n')
}
function removeFakeMcpClient() {
  // remove ONLY the fake fixture package — never the whole @deepseek-ai scope
  // (it also contains real deps like cordis / schemastery)
  rmSync(FAKE, { recursive: true, force: true })
}

test('host plugin: commands, invocation args, auto-import persistence, mirror status', async (t) => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cx-sync-test-'))
  installFakeMcpClient()
  // Hermetic mirror fixture: a throwaway codex config so the mirror never
  // reads the real ~/.codex/config.toml (which changes as the user adds MCP
  // servers like gmail).
  const codexHome = join(process.env.DSH_HOME, 'codex-fixture')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(codexHome, 'config.toml'), `
[mcp_servers]
[mcp_servers.cloudflare-api]
type = "streamable-http"
url = "https://mcp.cloudflare.com/mcp"
bearer_token_env_var = "CLOUDFLARE_API_TOKEN"
[mcp_servers.exa]
type = "stdio"
command = "exa"
env = { EXA_API_KEY = "test-key" }
[mcp_servers.node_repl]
type = "stdio"
command = "node_repl"
[mcp_servers.dsh-plugins]
type = "stdio"
command = "dsh-plugins"
[mcp_servers.computer-use]
enabled = false
type = "stdio"
command = "computer"
`.trim() + '\n')
  let mirror = null // hoisted: the finally clause cannot see try-block consts
  try {
    const cordisRoot = dshDep('@deepseek-ai/cordis')
    if (!cordisRoot) {
      t.skip('cordis not found in the dsh installation')
      return
    }
    const { Context, Service } = await import(join(cordisRoot, 'lib', 'index.js'))
    const plugin = (await import(join(PROJECT, 'lib', 'index.js'))).default
    const { startMcpMirror, formatMcpStatus } = await import(join(PROJECT, 'lib', 'mcp.js'))

    class StubSystemPrompt extends Service { constructor(c) { super(c, 'systemPrompt', true) } section() { return () => {} } }
    class StubCommands extends Service {
      constructor(c) { super(c, 'commands', true) }
      register(def) { this.registered = this.registered ?? []; this.registered.push(def); return () => {} }
    }
    const ctx = new Context()
    const mounted = []
    const origPlugin = ctx.plugin.bind(ctx)
    ctx.plugin = async (p, cfg) => {
      if (typeof p === 'function' && p.name === 'FakeMcpClient') { mounted.push(cfg); return () => {} }
      return origPlugin(p, cfg)
    }
    await ctx.plugin(StubSystemPrompt)
    await ctx.plugin(StubCommands)
    const MCP_CONFIG = { codexHome, maxSkills: 30, mcpMirrorDeny: ['node_repl'], mcpMirrorSilent: ['exa'] }
    await ctx.plugin(plugin, { ...MCP_CONFIG, mcpMirror: false }) // mirror tested separately below
    await new Promise((r) => setTimeout(r, 100))

    const names = ctx.commands.registered.map((d) => d.name)
    assert.deepEqual(names, ['import-codex', 'import-all', 'attach-workspaces', 'codex-settings', 'codex-setting', 'mcp-status', 'auto-import'])

    const byName = Object.fromEntries(ctx.commands.registered.map((d) => [d.name, d]))
    const invocation = (rawInput = '') => Object.freeze({ commandId: 'x', agent: {}, rawInput, signal: null })

    // /auto-import: 'on' via CommandInvocation must WRITE, not query
    const on = await byName['auto-import'].handler(invocation(' on'))
    assert.match(on.text, /autoImport=on/, `expected on, got: ${on.text}`)
    const read = await byName['auto-import'].handler(invocation(''))
    assert.match(read.text, /autoImport=on/, `persisted toggle must read on, got: ${read.text}`)
    const off = await byName['auto-import'].handler(invocation('off'))
    assert.match(off.text, /autoImport=off/)

    // /codex-settings + /codex-setting: machine-readable key=on|off lines that
    // the Sync settings UI parses; persisted value overrides config default
    const listAll = await byName['codex-settings'].handler(invocation())
    const listText = listAll.text
    assert.match(listText, /^enableImport=on/m, 'settings list must be machine-readable')
    assert.match(listText, /^mcpMirror=off/m, 'mcpMirror must read the config default (false here)')
    assert.match(listText, /^enableInstructions=on/m)
    const turnOff = await byName['codex-setting'].handler(invocation('enableInstructions off'))
    assert.match(turnOff.text, /^enableInstructions=off/, 'toggle must echo key=value first')
    assert.match(turnOff.text, /指令注入\s*已关闭/)
    const after = await byName['codex-settings'].handler(invocation())
    assert.match(after.text, /^enableInstructions=off/m, 'persisted toggle must show in the list')
    assert.match(after.text, /^enableImport=on/m)
    const unknown = await byName['codex-setting'].handler(invocation('nope on'))
    assert.match(unknown.text, /未知设置/)

    // /import-codex: args parse from invocation.rawInput
    const { parseInput } = await import(join(PROJECT, 'lib', 'index.js'))
    assert.deepEqual(parseInput(' --limit 5 --since 2026-01-01'), { limit: 5, since: 1767225600000 })
    // bare boolean flags (e.g. --include-subagents) must not swallow the next value token
    assert.deepEqual(parseInput(' --include-subagents'), { 'include-subagents': true })
    assert.deepEqual(parseInput(' --include-subagents --limit 3'), { 'include-subagents': true, limit: 3 })
    assert.deepEqual(parseInput(' --dry-run'), { 'dry-run': true })

    // mirror: direct instance so the test owns the handle (dispose closes fs.watch)
    mirror = startMcpMirror(ctx, MCP_CONFIG.codexHome, MCP_CONFIG)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(mounted.map((c) => c.serverName).sort(), ['cloudflare-api', 'exa'])

    const status = mirror.getStatus()
    const rows = Object.fromEntries(status.servers.map((s) => [s.name, s]))
    assert.equal(rows.exa.reason, 'mounted')
    assert.equal(rows.exa.silent, true)
    assert.equal(rows.exa.transport, 'stdio')
    assert.equal(rows['cloudflare-api'].reason, 'mounted')
    assert.equal(rows['node_repl'].reason, 'denied')
    assert.equal(rows['dsh-plugins'].reason, 'denied')
    assert.equal(rows['computer-use'].reason, 'disabled')

    // /mcp-status: formatMcpStatus renders reason rows (pure function shared
    // with the plugin handler)
    const statusText = formatMcpStatus(mirror.getStatus())
    assert.match(statusText, /exa\s+stdio\s+mounted silent ✓/)
    assert.match(statusText, /cloudflare-api\s+streamable-http\s+mounted/)
    assert.match(statusText, /node_repl\s+stdio\s+denied/)

    // plugin row with mcpMirror:false reports the disabled message
    const disabled = (await byName['mcp-status'].handler(invocation())).text
    assert.match(disabled, /未启用/)
    // /mcp-status also reports the authoritative autoImport value
    assert.match(disabled, /autoImport: off/)
  } finally {
    // closing the mirror's fs.watch lets the event loop drain (no runner hang)
    try { mirror?.dispose?.() } catch { /* ignore */ }
    removeFakeMcpClient()
  }
})

