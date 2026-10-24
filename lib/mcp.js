/**
 * One-way Codex MCP mirroring with per-generation, awaited Cordis ownership.
 * Configuration stays in Codex; no profile rewrites or persistent snapshots.
 */
import { readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { effectiveItemSync } from './state.js'
import { HARD_DENY, parseCodexMcpServers, toMcpClientConfig, startupTimeout, isReverseBridge, safeMcpError } from './mcp-config.js'
import { launchMcp } from './mcp-lifecycle.js'
export { parseCodexMcpServers, toMcpClientConfig } from './mcp-config.js'

export function hardDenyNames() { return new Set(HARD_DENY) }
const shq = token => `'${String(token).replace(/'/gu, `'\\''`)}'`
/** POSIX-only compatibility option; never require /bin/sh on Windows. */
export function silenceStdio(cfg, platform = process.platform) {
  if (cfg.transport !== 'stdio' || platform === 'win32') return cfg
  const command = [cfg.command, ...(cfg.args ?? [])].map(shq).join(' ')
  return { ...cfg, command: '/bin/sh', args: ['-c', `exec ${command} 2>/dev/null`] }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
function nativeConfig(cfg, requireReady = true) {
  return {
    ...cfg, failOnStartupError: requireReady,
    reconnect: cfg.reconnect ?? { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 2147483647 },
  }
}

/** Explicit clients share the same cancellation/ownership rules as the mirror. */
export async function mountMcpServers(ctx, servers) {
  const controller = new AbortController()
  const handles = new Set()
  const timers = new Set()
  let stopped = false
  const dispose = async () => {
    stopped = true
    controller.abort()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    await Promise.allSettled([...handles].map(handle => handle.dispose()))
  }
  ctx.effect?.(() => dispose, 'codex-sync.explicit-mcp()')
  const mountOne = async ([serverName, cfg]) => {
    if (stopped) return
    try {
      if (!cfg || typeof cfg !== 'object' || isReverseBridge(serverName, cfg)) return
      // Explicit clients retain the native supervisor after an initial failure.
      // Mirrored clients instead require readiness and own their retry state.
      const handle = await launchMcp(ctx, nativeConfig({ ...cfg, serverName }, false), { signal: controller.signal, timeoutMs: 20000, allowWaiting: true })
      if (stopped) await handle.dispose()
      else handles.add(handle)
    } catch (error) {
      if (!stopped) {
        ctx.logger?.warn?.(`dsh-codex-sync: explicit MCP ${serverName}: ${safeMcpError(error)}`)
        if (['startup-timeout', 'mcp-client-unavailable'].includes(error.code) && cfg?.reconnect?.enabled !== false) {
          const timer = setTimeout(() => { timers.delete(timer); void mountOne([serverName, cfg]) }, 30000)
          timer.unref?.()
          timers.add(timer)
        }
      }
    }
  }
  await Promise.all(servers.map(mountOne))
  return { dispose }
}

export function formatMcpStatus(status) {
  const lines = [
    `MCP mirror: ${status.enabled ? 'on' : 'off'}  ·  ${status.configPath}`,
    status.lastSyncAt ? `last sync: ${status.lastSyncAt}` : 'last sync: (initial mount in progress…)',
    ...(status.issue ? [`config: ${status.issue}`] : []), '',
  ]
  const rows = [...status.servers].sort((a, b) => a.name.localeCompare(b.name))
  for (const server of rows) {
    const flags = [server.silent ? 'silent' : null, server.reason === 'mounted' ? '✓' : null].filter(Boolean).join(' ')
    const detail = server.reason === 'failed' ? ` (${server.error ?? 'MCP connection failed'})` : ''
    lines.push(`${server.name.padEnd(16)} ${server.transport.padEnd(15)} ${server.reason}${flags ? ' ' + flags : ''}${detail}`)
  }
  lines.push('', `servers: ${rows.length}`, 'hint: /codex-mcp <名> on|off · codex config edits live-sync')
  return lines.join('\n')
}

/**
 * Reconcile configuration independently of connection handshakes. A slow beta
 * must never postpone revocation of an already-ready alpha. refresh() waits for
 * the current generation's starts, but those waits are NOT the reconcile queue.
 */
export function startMcpMirror(ctx, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), config = {}) {
  const configPath = join(codexHome, 'config.toml')
  const deny = new Set([...HARD_DENY, ...(config.mcpMirrorDeny ?? [])])
  const only = config.mcpMirrorOnly ? new Set(config.mcpMirrorOnly) : null
  const silent = new Set(config.mcpMirrorSilent ?? [])
  const explicit = new Set(Object.keys(config.mcpServers ?? {}))
  const entries = new Map()
  const retiring = new Map()
  let status = new Map()
  let stopped = false
  let stopping
  let queue = Promise.resolve()
  let queued = false
  let forceRetry = false
  let lastSyncAt = null
  let issue = null
  let watcher
  let debounce
  const pollMs = Number.isFinite(config.mcpMirrorPollIntervalMs) ? Math.max(50, Math.min(60000, config.mcpMirrorPollIntervalMs)) : 2000
  const retryMs = 30000
  const isCurrent = entry => !stopped && entries.get(entry.name) === entry && !entry.controller.signal.aborted

  async function remove(entry) {
    entry.controller.abort()
    await entry.handle?.dispose()
    await entry.task?.catch(() => {})
  }
  function retire(entry) {
    entry.controller.abort()
    const prior = retiring.get(entry.name)
    const task = Promise.all([prior, remove(entry)])
    retiring.set(entry.name, task)
    task.then(() => {
      if (retiring.get(entry.name) === task) retiring.delete(entry.name)
    }, () => { issue = 'MCP teardown failed; replacement namespace remains blocked' })
    return task
  }
  async function waitForRetirement(entry) {
    const barrier = retiring.get(entry.name)
    const signal = entry.controller.signal
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (!barrier) return
    let abort
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new DOMException('Cancelled', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try { await Promise.race([barrier, cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  function start(entry) {
    entry.row.reason = 'mounting'
    delete entry.row.error
    entry.task = (async () => {
      await waitForRetirement(entry)
      return launchMcp(ctx, nativeConfig(entry.cfg), { signal: entry.controller.signal, timeoutMs: entry.timeoutMs })
    })()
      .then(async handle => {
        if (!isCurrent(entry)) { await handle.dispose(); return }
        entry.handle = handle
        entry.row.reason = 'mounted'
        entry.retryAt = 0
      }, error => {
        if (!isCurrent(entry)) return
        entry.row.reason = 'failed'
        entry.row.error = safeMcpError(error)
        entry.retryAt = Date.now() + retryMs
      })
      .finally(() => { entry.pending = false })
    entry.pending = true
  }
  async function reconcile(force) {
    let parsed
    try { parsed = parseCodexMcpServers(await readFile(configPath, 'utf8')) }
    catch (error) { issue = safeMcpError(error); return }
    if (stopped) return
    const wanted = new Map()
    const nextStatus = new Map()
    for (const [name, srv] of parsed) {
      const row = { name, transport: srv.command !== undefined ? 'stdio' : srv.url !== undefined ? 'streamable-http' : '?', silent: silent.has(name) && process.platform !== 'win32' }
      if (srv.enabled === false) row.reason = 'disabled'
      else if (deny.has(name) || isReverseBridge(name, srv)) row.reason = 'denied'
      else if (only && !only.has(name)) row.reason = 'only-filtered'
      else if (!effectiveItemSync('mcp', name)) row.reason = 'user-disabled'
      else if (explicit.has(name)) row.reason = 'explicit-wins'
      else {
        try {
          let cfg = toMcpClientConfig(name, srv)
          if (!cfg) row.reason = 'unmapped'
          else {
            const timeoutMs = startupTimeout(srv, config)
            if (row.silent) cfg = silenceStdio(cfg)
            const key = JSON.stringify(canonical([cfg, timeoutMs]))
            const old = entries.get(name)
            if (old?.key === key) {
              wanted.set(name, old)
              nextStatus.set(name, old.row)
              continue
            }
            const entry = { name, cfg, key, row, timeoutMs, controller: new AbortController(), retryAt: 0 }
            wanted.set(name, entry)
            row.reason = 'mounting'
          }
        } catch (error) { row.reason = 'failed'; row.error = safeMcpError(error) }
      }
      nextStatus.set(name, row)
    }
    status = nextStatus
    // Admit later revisions immediately, even while an unrelated name closes.
    // Only replacement startup waits for its own namespace retirement barrier.
    for (const [name, old] of entries) if (wanted.get(name) !== old) {
      entries.delete(name)
      void retire(old)
    }
    if (stopped) return
    for (const [name, entry] of wanted) {
      entries.set(name, entry)
      if (!entry.handle && !entry.pending && (force || entry.retryAt <= Date.now())) start(entry)
    }
    issue = null
    lastSyncAt = new Date().toISOString()
  }
  function enqueue(force = false) {
    if (stopped) return queue
    forceRetry ||= force
    if (!queued) {
      queued = true
      queue = queue.then(async () => {
        queued = false
        const force = forceRetry
        forceRetry = false
        if (!stopped) await reconcile(force)
      }).catch(error => { issue = safeMcpError(error) })
    }
    return queue.then(() => Promise.allSettled([...entries.values()].map(entry => entry.task).concat([...retiring.values()])))
  }
  function armWatcher() {
    if (stopped || watcher) return
    try {
      watcher = watch(codexHome, (_event, file) => {
        if (file && String(file) !== 'config.toml') return
        clearTimeout(debounce)
        debounce = setTimeout(() => { void enqueue() }, 150)
        debounce.unref?.()
      })
      watcher.on('error', () => { watcher?.close(); watcher = undefined })
      watcher.unref?.()
    } catch { /* bounded polling recovers a missing parent or failed watch */ }
  }
  const interval = setInterval(() => { armWatcher(); void enqueue() }, pollMs)
  interval.unref?.()
  armWatcher()
  void enqueue()
  return {
    refresh: () => enqueue(true),
    getStatus: () => ({ configPath, enabled: !stopped, lastSyncAt, issue, servers: [...status.values()].map(row => ({ ...row })) }),
    dispose() {
      if (stopping) return stopping
      stopped = true
      clearInterval(interval)
      clearTimeout(debounce)
      watcher?.close()
      for (const entry of entries.values()) entry.controller.abort()
      stopping = (async () => {
        await queue
        await Promise.allSettled([...entries.values()].map(remove).concat([...retiring.values()]))
        entries.clear()
        retiring.clear()
        status.clear()
      })()
      return stopping
    },
  }
}
