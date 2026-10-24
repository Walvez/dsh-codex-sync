import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeRequire } from '../scripts/run-contract-tests.mjs'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { temporary, environment, eventually } from './live-helpers.mjs'
import * as plugin from '../lib/index.js'
import { registerCodexSkillProvider } from '../lib/skill-provider.js'

// Isolate each supported DSH peer graph from the historical session-format
// fixtures. The runner installs locked fixtures and selects each via the allowlist.
const require = runtimeRequire('skills')
const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: Skills } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-skill')).href)
const skill = (name, body = 'body', extra = '') => `---\nname: ${name}\ndescription: Description for ${name}\n${extra}---\n${body}\n`
async function host(t, root, config = {}) {
  const ctx = new Context()
  class Prompt extends Service { constructor(c) { super(c, 'systemPrompt', true) } section() { return () => {} } }
  class Commands extends Service { constructor(c) { super(c, 'commands', true); this.rows = new Map() } register(row) { this.rows.set(row.name, row); return () => this.rows.delete(row.name) } }
  class Web extends Service { constructor(c) { super(c, 'webServer', true) } register(row) { this.row = row; return () => { this.row = undefined } } }
  const fibers = []
  for (const p of [Prompt, Commands, Web, Skills]) fibers.push(await ctx.plugin(p))
  const fiber = ctx.plugin(plugin, { codexHome: root, mcpMirror: false, autoImport: false, enableInstructions: false, enableConfig: false, ...config })
  await fiber.await()
  await eventually(async () => (await ctx.skills.list({ cwd: root })).some(s => s.provider === 'dsh-codex-sync'))
  const dispose = async () => { await fiber.dispose(); for (const f of fibers.reverse()) await f.dispose() }
  return {
    ctx, fiber, dispose,
    names: async () => (await ctx.skills.list({ cwd: root })).filter(s => s.provider === 'codex').map(s => s.name),
    command: async (name, rawInput) => ctx.commands.rows.get(name).handler({ rawInput }),
    http: async (key, value) => {
      const req = Readable.from([Buffer.from(JSON.stringify({ key, value }))]); req.method = 'POST'; req.url = '/dsh-codex-sync/setting'
      let text = ''
      const res = { setHeader() {}, end(chunk) { text += chunk ?? '' } }
      await ctx.webServer.row.handler(req, res)
      return JSON.parse(text)
    },
  }
}

test('current registry cache observes command and HTTP master/item/default/all changes', async t => {
  const f = await temporary(t); environment(t, { DSH_HOME: f.root })
  await mkdir(join(f.root, 'skills', 'alpha'), { recursive: true })
  await mkdir(join(f.root, 'skills', 'beta-folder'), { recursive: true })
  await writeFile(join(f.root, 'skills', 'alpha', 'SKILL.md'), skill('alpha'))
  await writeFile(join(f.root, 'skills', 'beta-folder', 'SKILL.md'), skill('beta'))
  const h = await host(t, f.root); f.own(h.dispose)
  assert.deepEqual(await h.names(), ['alpha', 'beta'])
  await h.names() // populate the real completed-catalog cache
  await h.command('codex-setting', 'enableSkills off'); assert.deepEqual(await h.names(), [])
  await h.http('enableSkills', true); assert.deepEqual(await h.names(), ['alpha', 'beta'])
  await h.command('codex-skill', 'beta-folder off'); assert.deepEqual(await h.names(), ['alpha'])
  await h.command('codex-setting', 'skillSyncDefault off'); assert.deepEqual(await h.names(), [])
  await h.command('codex-skill', 'all on'); assert.deepEqual(await h.names(), ['alpha', 'beta'])
  await h.command('codex-skill', 'all off'); assert.deepEqual(await h.names(), [])
  await h.http('skillSyncDefault', true); assert.deepEqual(await h.names(), []) // explicit per-item overrides survive defaults
})
test('current cached catalog observes external add/edit/rename/delete and full-body reload', async t => {
  const f = await temporary(t); environment(t, { DSH_HOME: f.root })
  await mkdir(join(f.root, 'skills'))
  const h = await host(t, f.root); f.own(h.dispose)
  assert.deepEqual(await h.names(), [])
  const first = join(f.root, 'skills', 'alpha.md'); const next = join(f.root, 'skills', 'renamed.md')
  await writeFile(first, skill('alpha', 'body-v1'))
  await eventually(async () => (await h.names()).includes('alpha'))
  assert.equal((await h.ctx.skills.get('alpha', { cwd: f.root })).resourceBase.path, join(f.root, 'skills'))
  await writeFile(first, skill('alpha', 'body-v2', 'disable-model-invocation: true\n'))
  await eventually(async () => (await h.ctx.skills.list({ cwd: f.root })).find(s => s.name === 'alpha')?.invocation.modelInvocable === false)
  assert.match((await h.ctx.skills.get('alpha', { cwd: f.root })).content, /body-v2/)
  assert.equal(resolve(first), join(f.root, 'skills', 'alpha.md')); assert.equal(resolve(next), join(f.root, 'skills', 'renamed.md'))
  await rename(first, next)
  await writeFile(next, skill('renamed'))
  await eventually(async () => (await h.names()).join(',') === 'renamed')
  assert.equal(resolve(next), join(f.root, 'skills', 'renamed.md')); await unlink(next)
  await eventually(async () => (await h.names()).length === 0)
})
test('missing skill roots created after the first cached empty observation are discovered', async t => {
  const f = await temporary(t); environment(t, { DSH_HOME: f.root })
  const home = join(f.root, 'later-home'); const h = await host(t, home); f.own(h.dispose)
  assert.deepEqual(await h.names(), [])
  await mkdir(join(home, 'skills', 'alpha'), { recursive: true })
  await writeFile(join(home, 'skills', 'alpha', 'SKILL.md'), skill('alpha'))
  await eventually(async () => (await h.names()).includes('alpha'))
})
test('YAML policies, invalid policy exclusion, maxSkills and flat resource bases remain safe', async t => {
  const f = await temporary(t); environment(t, { DSH_HOME: f.root })
  const root = join(f.root, 'skills'); await mkdir(root)
  await writeFile(join(root, 'alpha.md'), '---\nname: alpha\ndescription: |\n  multiline description\ndisable-model-invocation: yes\nuser-invocable: off\n---\nalpha body\n')
  await writeFile(join(root, 'beta.md'), skill('beta', 'body', 'disable-model-invocation: maybe\n'))
  const controller = new AbortController()
  const provider = registerCodexSkillProvider(f.root, { maxSkills: 1 }, { signal: controller.signal, invalidate() {} }); f.own(() => provider.dispose())
  const rows = await provider.list(); assert.equal(rows.length, 1)
  assert.equal(rows[0].description, 'multiline description\n')
  assert.deepEqual(rows[0].invocation, { modelInvocable: false, userInvocable: false })
  assert.equal((await provider.get(rows[0])).resourceBase.path, root)
  assert.equal(rows[0].rank, 800)
  controller.abort(); assert.deepEqual(await provider.list(), [])
})
test('plugin teardown unregisters current providers and closes watchers', async t => {
  const f = await temporary(t); environment(t, { DSH_HOME: f.root })
  await mkdir(join(f.root, 'skills')); await writeFile(join(f.root, 'skills', 'alpha.md'), skill('alpha'))
  const h = await host(t, f.root)
  assert.deepEqual(await h.names(), ['alpha'])
  await h.fiber.dispose()
  assert.deepEqual(await h.names(), [])
  await h.dispose()
})
