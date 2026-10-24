import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseCodexMcpServers, toMcpClientConfig, silenceStdio, startMcpMirror } from '../lib/mcp.js'
import { startupTimeout, safeMcpError, isReverseBridge } from '../lib/mcp-config.js'
import { launchMcp } from '../lib/mcp-lifecycle.js'
import { Config } from './mcp-schema-fixture.mjs'
import { temporary, environment, eventually, deferred, delay } from './live-helpers.mjs'

const server = (name, argument = 'ok') => `[mcp_servers.${name}]\ncommand='synthetic-executable'\nargs=['${argument}']\n`
function runtime() {
  const ctx = new Context()
  const active = new Set()
  const calls = []
  const entered = new Map()
  const closures = new Map()
  const plugin = { name: 'mcp-contract-fixture', Config, async apply(inner, cfg) {
    if (active.has(cfg.serverName)) throw new Error('duplicate fixture namespace')
    active.add(cfg.serverName); calls.push(`start:${cfg.serverName}:${cfg.args[0]}`)
    inner.effect(() => async () => {
      if (cfg.args[0] === 'slow-close') { const gate = deferred(); closures.set(cfg.serverName, gate); await gate.promise }
      await delay(2); active.delete(cfg.serverName); calls.push(`stop:${cfg.serverName}`)
    })
    if (cfg.args[0] === 'pending') {
      const gate = deferred(); entered.set(cfg.serverName, gate)
      inner.on('internal/plugin', fiber => { if (fiber === inner.fiber && fiber.uid === null) gate.resolve() }, { global: true })
      await gate.promise
    }
    if (cfg.args[0] === 'failure') throw new Error('synthetic-sensitive-error')
  } }
  ctx.provide('loader', { import: async () => plugin })
  return { ctx, plugin, active, calls, entered, closures }
}

test('full TOML: quoted names, literal Windows paths, multiline/comma args and disabled comments', () => {
  const parsed = parseCodexMcpServers(`[mcp_servers."quoted.name"]\ncommand='C:\\tools\\mcp.exe'\nargs=[\n 'one,two', # comment\n 'three',\n]\nenv={ TOKEN='synthetic' }\n[mcp_servers.off]\ncommand='x'\nenabled=false # disabled\n`)
  assert.deepEqual(parsed.get('quoted.name').args, ['one,two', 'three'])
  assert.equal(parsed.get('quoted.name').command, 'C:\\tools\\mcp.exe')
  assert.equal(parsed.get('quoted.name').env.TOKEN, 'synthetic')
  assert.equal(toMcpClientConfig('off', parsed.get('off')), null)
  assert.throws(() => toMcpClientConfig('quoted.name', parsed.get('quoted.name')), /invalid-server-name/)
})
test('TOML failures do not include source excerpts', () => {
  try { parseCodexMcpServers('sensitive="synthetic-secret"\n[broken') } catch (error) {
    assert.equal(error.message, 'invalid-toml')
    assert.ok(!safeMcpError(error).includes('synthetic-secret'))
  }
})
test('stdio mapping preserves literal env and only forwards named present variables', () => {
  const mapped = toMcpClientConfig('stdio', { command: 'fixture', env: { X: '${LITERAL}' }, env_vars: ['TOKEN', 'ABSENT'] }, { TOKEN: 'synthetic', AMBIENT_SECRET: 'not-forwarded' })
  assert.deepEqual(mapped.env, { X: '${LITERAL}', TOKEN: 'synthetic' })
  assert.throws(() => toMcpClientConfig('bad', { command: 'x', args: 'not-an-array' }), /invalid-field/)
  assert.throws(() => toMcpClientConfig('bad', { command: 'x', enabled: 'false' }), /invalid-field/)
  assert.throws(() => toMcpClientConfig('bad', { command: 'x', cwd: 'relative' }), /relative-cwd/)
})
test('HTTP mapping includes static/env headers and fail-closes missing bearer variables', () => {
  const mapped = toMcpClientConfig('http', { url: 'https://example.invalid/mcp', http_headers: { 'X-Static': 'static', authorization: 'old' }, env_http_headers: { 'X-Env': 'VALUE' }, bearer_token_env_var: 'TOKEN' }, { VALUE: 'value', TOKEN: 'synthetic' })
  assert.deepEqual(mapped.headers, { 'X-Static': 'static', 'X-Env': 'value', Authorization: 'Bearer synthetic' })
  assert.throws(() => toMcpClientConfig('http', { url: 'https://example.invalid', bearer_token_env_var: 'ABSENT' }, {}), /missing-env/)
})
test('environment HTTP headers replace static spellings case-insensitively', () => {
  const cfg = toMcpClientConfig('headers', { url: 'https://example.invalid', http_headers: { Authorization: 'old' }, env_http_headers: { authorization: 'TOKEN' } }, { TOKEN: 'synthetic-correct-token' })
  assert.equal(new Headers(cfg.headers).get('authorization'), 'synthetic-correct-token')
})
test('reverse detection checks launch entrypoints, not unrelated data paths', () => {
  assert.equal(isReverseBridge('files', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', join('synthetic', 'upstream-dsh-codex-sync')] }), false)
  assert.equal(isReverseBridge('alias', { command: 'node', args: [join('synthetic', 'dsh-codex-sync.js'), 'serve'] }), true)
})
test('tool restrictions are never silently broadened; timeouts are bounded', () => {
  for (const policy of [{ enabled_tools: [] }, { disabled_tools: ['delete'] }, { tool_approval: {} }]) assert.throws(() => toMcpClientConfig('x', { command: 'x', ...policy }), /unsupported-tool-policy/)
  assert.throws(() => startupTimeout({ startup_timeout_sec: 86400 }), /invalid-timeout/)
  assert.equal(startupTimeout({ startup_timeout_sec: 0.5 }), 500)
})
test('silent stdio has correct token boundaries and Windows does not assume /bin/sh', () => {
  const cfg = { transport: 'stdio', command: 'fixture command', args: ["a'b", 'two'] }
  const silent = silenceStdio(cfg, 'linux')
  assert.equal(silent.command, '/bin/sh')
  assert.match(silent.args[1], /^exec 'fixture command' /)
  assert.match(silent.args[1], /'two' 2>\/dev\/null$/)
  assert.equal(silenceStdio(cfg, 'win32'), cfg)
})

test('real Cordis Fiber mount/change/off/on/remove retains no namespaces', async t => {
  const fixture = await temporary(t); environment(t, { DSH_HOME: fixture.root })
  const r = runtime(); const configPath = join(fixture.root, 'config.toml')
  await writeFile(configPath, server('alpha'))
  const mirror = startMcpMirror(r.ctx, fixture.root, {}); fixture.own(() => mirror.dispose())
  await mirror.refresh(); assert.ok(r.active.has('alpha'))
  const starts = r.calls.length
  await mirror.refresh(); assert.equal(r.calls.length, starts)
  await writeFile(configPath, server('alpha', 'changed')); await mirror.refresh()
  assert.deepEqual(r.calls.slice(-2), ['stop:alpha', 'start:alpha:changed'])
  await writeFile(configPath, server('alpha') + 'enabled=false # off\n'); await mirror.refresh()
  assert.equal(r.active.size, 0)
  await writeFile(configPath, server('alpha')); await mirror.refresh(); assert.equal(r.active.size, 1)
  await writeFile(configPath, ''); await mirror.refresh(); assert.equal(r.active.size, 0)
  await mirror.dispose(); await mirror.dispose()
})
test('invalid configuration retains last-good clients and redacts errors', async t => {
  const fixture = await temporary(t); environment(t, { DSH_HOME: fixture.root })
  const r = runtime(); const file = join(fixture.root, 'config.toml')
  await writeFile(file, server('alpha'))
  const mirror = startMcpMirror(r.ctx, fixture.root); fixture.own(() => mirror.dispose())
  await mirror.refresh()
  await writeFile(file, 'token="synthetic-secret"\n[broken'); await mirror.refresh()
  assert.ok(r.active.has('alpha')); assert.equal(mirror.getStatus().issue, 'invalid-toml')
  assert.ok(!JSON.stringify(mirror.getStatus()).includes('synthetic-secret'))
})
test('a pending beta cannot postpone disabling ready alpha', async t => {
  const fixture = await temporary(t); environment(t, { DSH_HOME: fixture.root })
  const r = runtime(); const file = join(fixture.root, 'config.toml')
  await writeFile(file, server('alpha'))
  const mirror = startMcpMirror(r.ctx, fixture.root); fixture.own(() => mirror.dispose())
  await mirror.refresh()
  await writeFile(file, server('alpha') + server('beta', 'pending'))
  const pending = mirror.refresh()
  await eventually(() => r.entered.has('beta'))
  await writeFile(file, server('beta', 'pending'))
  const revoked = mirror.refresh()
  await eventually(() => !r.active.has('alpha'))
  assert.ok(r.active.has('beta'))
  await mirror.dispose(); await Promise.all([pending, revoked])
  assert.equal(r.active.size, 0)
})
test('a slow beta teardown cannot postpone a later alpha revocation', async t => {
  const fixture = await temporary(t); environment(t, { DSH_HOME: fixture.root })
  const r = runtime(); const file = join(fixture.root, 'config.toml')
  await writeFile(file, server('alpha') + server('beta', 'slow-close'))
  const mirror = startMcpMirror(r.ctx, fixture.root)
  fixture.own(() => mirror.dispose())
  await mirror.refresh()
  let first, second
  try {
    await writeFile(file, server('alpha')); first = mirror.refresh()
    await eventually(() => r.closures.has('beta'))
    await writeFile(file, ''); second = mirror.refresh()
    await eventually(() => !r.active.has('alpha'))
    assert.ok(r.active.has('beta'))
  } finally {
    r.closures.get('beta')?.resolve()
    await Promise.all([first, second])
  }
})
test('unload while dependency lookup is pending creates no late Fiber', async () => {
  const r = runtime(); const gate = deferred(); const controller = new AbortController()
  const task = launchMcp(r.ctx, { serverName: 'late', transport: 'stdio', args: ['ok'] }, { signal: controller.signal, timeoutMs: 1000, load: async () => { await gate.promise; return r.plugin } })
  controller.abort(); await assert.rejects(task, /cancelled/)
  gate.resolve(); await delay(15)
  assert.equal(r.active.size, 0); assert.equal(r.calls.length, 0)
})
test('startup deadline includes executable resolution, not only plugin startup', async () => {
  const r = runtime(); const gate = deferred(); r.ctx.provide('subprocess', { resolveExecutable: async () => { await gate.promise; return 'unused' } })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(launchMcp(r.ctx, { serverName: 'late', transport: 'stdio', command: 'x', args: ['ok'] }, { timeoutMs: 20 }), /startup-timeout/)
    gate.resolve(); await delay(10); assert.equal(r.calls.length, 0)
  } finally { clearTimeout(keepAlive) }
})
test('external saves recover missing roots and repeated atomic replacements', async t => {
  const fixture = await temporary(t); environment(t, { DSH_HOME: fixture.root })
  const home = join(fixture.root, 'later'); const file = join(home, 'config.toml'); const r = runtime()
  const mirror = startMcpMirror(r.ctx, home, { mcpMirrorPollIntervalMs: 50 }); fixture.own(() => mirror.dispose())
  await mkdir(home); await writeFile(file, server('alpha'))
  await eventually(() => r.active.has('alpha'))
  for (const argument of ['atomic-one', 'atomic-two']) {
    const from = join(home, 'config.new'); await writeFile(from, server('alpha', argument))
    assert.equal(resolve(from), join(home, 'config.new')); assert.equal(resolve(file), join(home, 'config.toml'))
    await rename(from, file)
    await eventually(() => r.calls.includes(`start:alpha:${argument}`))
  }
})
