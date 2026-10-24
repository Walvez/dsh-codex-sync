/**
 * Portable, watched DSH skill providers. Codex skills remain lower priority
 * within their registration layer (rank 800); nearer Agent layers still win.
 */
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import chokidar from 'chokidar'
import { parseDocument } from 'yaml'
import { readSyncGroup, statePath } from './state.js'

const CODEX_SKILL_RANK = 800
const PLUGIN_SKILL_RANK = 500
const PLUGIN_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
const MAX_SKILL_BYTES = 1024 * 1024
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

function invocationBoolean(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('invalid skill invocation policy')
  const token = String(value).toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(token)) return true
  if (['false', 'no', 'off', '0'].includes(token)) return false
  throw new Error('invalid skill invocation policy')
}

/** Parse actual YAML, not a line-oriented subset; rejected policies never grant invocation. */
async function readSkill(file, fallbackName, signal) {
  if (signal?.aborted) return undefined
  try {
    if ((await stat(file)).size > MAX_SKILL_BYTES) return undefined
    const text = await readFile(file, { encoding: 'utf8', ...(signal ? { signal } : {}) })
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u)
    if (!match) return undefined
    const document = parseDocument(match[1], { uniqueKeys: true })
    if (document.errors.length) return undefined
    const meta = document.toJS({ maxAliasCount: 100 })
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
    const name = meta.name ?? fallbackName
    if (typeof name !== 'string' || !NAME.test(name)) return undefined
    if (typeof meta.description !== 'string' || !meta.description.trim()) return undefined
    if (!match[2].trim()) return undefined
    return {
      name, description: meta.description,
      ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
      invocation: {
        modelInvocable: !invocationBoolean(meta['disable-model-invocation'], false),
        userInvocable: invocationBoolean(meta['user-invocable'], true),
      },
      metadata: meta, content: match[2], path: await realpath(file),
    }
  } catch (error) {
    if (signal?.aborted || ['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE'].includes(error.code)) throw error
    // Invalid YAML, disappeared files and oversized skills are not candidates.
    return undefined
  }
}

async function discover(root) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) {
    if (error.code === 'ENOENT') return []
    throw error // let the registry retain its last-good view on unexpected I/O
  }
  const files = []
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name.startsWith('.')) continue
    const base = join(root, entry.name)
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(base).then(s => s.isDirectory(), () => false))
    if (isDirectory) files.push({ entry: entry.name, file: join(base, 'SKILL.md'), dir: base })
    else if (entry.name.endsWith('.md')) files.push({ entry: entry.name, file: base, dir: root })
  }
  return files
}

function relevantSkillEvent(root, file) {
  const parts = relative(resolve(root), resolve(file)).split(/[\\/]/u)
  return parts.length === 1 || (parts.length === 2 && parts[1] === 'SKILL.md')
}

/** Existing exported factory stays synchronous as required by registerProvider. */
export function registerCodexSkillProvider(codexHome, config = {}, control, enabled = () => true) {
  const root = join(codexHome, 'skills')
  const limit = Number.isInteger(config.maxSkills) && config.maxSkills >= 0 ? config.maxSkills : 100
  let closed = false
  let closing
  let rootWatcher
  let stateWatcher
  let probe
  let checking
  let catalogStamp
  let nextStampAt = 0
  const state = resolve(statePath())
  const notify = () => {
    if (!closed && !control.signal.aborted) control.invalidate?.()
  }
  const invalidate = () => {
    // An observed edit can return to the same stat signature before the next
    // probe (add then delete). Re-baseline once so a missed final event heals.
    catalogStamp = undefined
    notify()
  }
  const watchOptions = {
    depth: 1, ignoreInitial: true, persistent: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
  }
  const attach = watcher => {
    watcher.on('ready', invalidate)
    watcher.on('error', invalidate)
    return watcher
  }
  const ensureRoot = () => {
    if (closed) return Promise.resolve()
    if (checking) return checking
    checking = (async () => {
      const exists = await stat(root).then(info => info.isDirectory(), error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      if (closed) return
      if (exists && !rootWatcher) {
        rootWatcher = attach(chokidar.watch(root, watchOptions))
        rootWatcher.on('all', (_event, file) => { if (relevantSkillEvent(root, file)) invalidate() })
        invalidate()
      } else if (!exists && rootWatcher) {
        const old = rootWatcher
        rootWatcher = undefined
        await old.close()
        invalidate()
      }
      // Watch startup and OS event delivery can race with an editor save. A
      // metadata-only fallback closes that gap without copying/reading bodies.
      if (Date.now() >= nextStampAt) {
        nextStampAt = Date.now() + 2000
        const files = [state, ...(await discover(root)).map(entry => entry.file)]
        const marks = await Promise.all(files.map(async file => {
          const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
          return [file, info?.mtimeMs, info?.ctimeMs, info?.size, info?.ino]
        }))
        const stamp = JSON.stringify(marks)
        if (stamp !== catalogStamp) { catalogStamp = stamp; notify() }
      }
    })().catch(invalidate).finally(() => { checking = undefined })
    return checking
  }
  const dispose = () => {
    if (closing) return closing
    closed = true
    clearInterval(probe)
    control.signal.removeEventListener?.('abort', dispose)
    closing = (async () => {
      await checking
      await Promise.all([rootWatcher?.close(), stateWatcher?.close()])
    })()
    return closing
  }
  if (!control.signal.aborted && config.watchSkills !== false) {
    stateWatcher = attach(chokidar.watch(state, watchOptions))
    stateWatcher.on('all', invalidate)
    // A root may not have any existing parent below the home directory yet.
    // Probe that fixed root; a slower metadata signature recovers lost events.
    probe = setInterval(() => { void ensureRoot() }, 500)
    probe.unref?.()
    void ensureRoot()
    control.signal.addEventListener?.('abort', dispose, { once: true })
  }
  return {
    name: 'codex', invalidate, dispose,
    async list(options = {}) {
      if (closed || control.signal.aborted || enabled() === false) return []
      const group = readSyncGroup('skill')
      const candidates = []
      for (const { entry, file, dir } of await discover(root)) {
        if (closed || control.signal.aborted || options.signal?.aborted) break
        const selected = typeof group.items[entry] === 'boolean' ? group.items[entry] : group.default
        if (!selected || candidates.length >= limit) continue
        const skill = await readSkill(file, entry.replace(/\.md$/u, ''), options.signal)
        if (!skill) continue
        const { content, ...summary } = skill
        candidates.push({ ...summary, source: 'custom', provider: 'codex', rank: CODEX_SKILL_RANK, locator: { file, dir, entry } })
      }
      return candidates
    },
    async get(candidate, options = {}) {
      if (closed || control.signal.aborted || enabled() === false) return undefined
      const { file, dir, entry } = candidate.locator
      const group = readSyncGroup('skill')
      if (!(typeof group.items[entry] === 'boolean' ? group.items[entry] : group.default)) return undefined
      const skill = await readSkill(file, entry.replace(/\.md$/u, ''), options.signal)
      if (!skill) return undefined
      return { ...skill, source: 'custom', provider: 'codex', resourceBase: { kind: 'directory', path: dir } }
    },
  }
}

/** Bundled plugin instructions do not need mutable-user-directory watchers. */
export function registerPluginSkillProvider(_codexHome, _config, control) {
  return {
    name: 'dsh-codex-sync',
    async list(options = {}) {
      const candidates = []
      for (const { entry, file, dir } of await discover(PLUGIN_SKILLS_DIR)) {
        if (control.signal.aborted) break
        const skill = await readSkill(file, entry, options.signal)
        if (!skill) continue
        const { content, ...summary } = skill
        candidates.push({ ...summary, source: 'custom', provider: 'dsh-codex-sync', rank: PLUGIN_SKILL_RANK, locator: { file, dir } })
      }
      return candidates
    },
    async get(candidate, options = {}) {
      if (control.signal.aborted) return undefined
      const { file, dir } = candidate.locator
      const skill = await readSkill(file, candidate.name, options.signal)
      return skill ? { ...skill, source: 'custom', provider: 'dsh-codex-sync', resourceBase: { kind: 'directory', path: dir } } : undefined
    },
  }
}
