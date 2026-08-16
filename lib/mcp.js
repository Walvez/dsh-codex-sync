/**
 * MCP mounting for dsh-codex-sync.
 *
 * Two sources of MCP servers:
 *
 *   A. EXPLICIT — config.mcpServers from the plugin row (see the plugin
 *      README). Each entry becomes one @deepseek-ai/dsh-mcp-client instance.
 *
 *   B. AUTO MIRROR — read ~/.codex/config.toml's [mcp_servers.*] sections
 *      (the single source of truth Codex itself uses), mount every portable
 *      server in dsh, and watch the file for live add/remove/change sync.
 *      Mapping rules:
 *        - stdio entries  → transport 'stdio'   (command/args/env/cwd)
 *        - url entries    → transport 'streamable-http' (url + optional
 *          Authorization header from bearer_token_env_var)
 *        - enabled=false  → skipped
 *        - the reverse bridge 'dsh-plugins' is ALWAYS denied (it would
 *          otherwise recurse: dsh spawning a server that talks back to dsh)
 *        - names already provided by explicit mcpServers are not mirrored
 *          (explicit config wins; duplicate serverName fails the later mount)
 *
 * The client package is an optional peerDependency; if it is missing, both
 * sources degrade to a warning instead of failing the plugin.
 *
 * @module dsh-codex-sync/mcp
 */

import { readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** @type {Promise<object | undefined> | undefined} */
let mcpClientModulePromise

/** Load the mcp-client package once (ESM dynamic import, peer optional). */
function loadMcpClient() {
  if (mcpClientModulePromise === undefined) {
    mcpClientModulePromise = import('@deepseek-ai/dsh-mcp-client').then(
      (mod) => mod.default ?? mod,
      () => undefined,
    )
  }
  return mcpClientModulePromise
}

/* ─────────────────────────────────────────────────────────────────────────
 * A. Explicit servers (config.mcpServers)
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Mount one dsh-mcp-client instance per explicitly configured server.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Array<[string, object]>} servers - [serverName, dshMcpClientConfig][].
 */
export async function mountMcpServers(ctx, servers) {
  const McpClient = await loadMcpClient()
  if (McpClient === undefined) {
    ctx.logger?.warn?.('dsh-codex-sync: @deepseek-ai/dsh-mcp-client not installed; skipping mcpServers')
    return
  }
  for (const [serverName, cfg] of servers) {
    try {
      await ctx.plugin(McpClient, { serverName, ...cfg, failOnStartupError: false })
      ctx.logger?.info?.(`dsh-codex-sync: mounted explicit MCP server "${serverName}"`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-codex-sync: failed to mount MCP server "${serverName}": ${error?.message ?? error}`)
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * B. Auto mirror of ~/.codex/config.toml [mcp_servers.*]
 * ───────────────────────────────────────────────────────────────────────── */

/** One server entry parsed from codex config.toml. */
function newServer(name) {
  return { name, args: [], env: {} }
}

/**
 * Minimal TOML-lite parser for codex's [mcp_servers.*] schema.
 * @param {string} text - config.toml content.
 * @returns {Map<string, object>} server name → entry.
 */
export function parseCodexMcpServers(text) {
  const servers = new Map()
  let current = null
  let inEnv = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) {
      const path = header[1].trim()
      const top = path.match(/^mcp_servers\.([^.]+)$/)
      const env = path.match(/^mcp_servers\.([^.]+)\.env$/)
      if (top) {
        current = servers.get(top[1]) ?? newServer(top[1])
        if (!servers.has(top[1])) servers.set(top[1], current)
        inEnv = false
      } else if (env) {
        current = servers.get(env[1]) ?? newServer(env[1])
        if (!servers.has(env[1])) servers.set(env[1], current)
        inEnv = true
      } else {
        current = null
        inEnv = false
      }
      continue
    }
    if (!current) continue
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()
    let parsed
    if (value.startsWith('"')) {
      const m = value.match(/^"((?:[^"\\]|\\.)*)"/)
      parsed = m ? m[1].replace(/\\(.)/gu, '$1') : value
    } else if (value.startsWith('[')) {
      const m = value.match(/^\[(.*)\]$/)
      parsed = m
        ? m[1]
            .split(',')
            .map((s) => s.trim().replace(/^"(.*)"$/u, '$1').replace(/\\(.)/gu, '$1'))
            .filter(Boolean)
        : value
    } else if (value === 'true' || value === 'false') {
      parsed = value === 'true'
    } else {
      parsed = value.replace(/\s+#.*$/u, '')
    }
    if (inEnv) current.env[key] = parsed
    else current[key] = parsed
  }
  return servers
}

/** Interpolate ${VAR} inside a string from process.env. */
function interpolate(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_all, name) => process.env[name] ?? '')
}

/** Map one codex mcp_servers entry to a dsh-mcp-client Config, or null. */
export function toMcpClientConfig(name, srv) {
  if (srv.enabled === false) return null
  if (srv.command !== undefined) {
    const env = {}
    for (const [k, v] of Object.entries(srv.env ?? {})) env[k] = interpolate(v)
    return {
      transport: 'stdio',
      serverName: name,
      command: srv.command,
      args: Array.isArray(srv.args) ? srv.args : [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof srv.cwd === 'string' && srv.cwd.length > 0 ? { cwd: interpolate(srv.cwd) } : {}),
    }
  }
  if (srv.url !== undefined) {
    const headers = {}
    if (typeof srv.bearer_token_env_var === 'string' && srv.bearer_token_env_var.length > 0) {
      const token = process.env[srv.bearer_token_env_var]
      if (token) headers.Authorization = `Bearer ${token}`
    }
    return {
      transport: 'streamable-http',
      serverName: name,
      url: srv.url,
      headers,
    }
  }
  return null
}

/** Names that must never be mirrored (recursion guard + known-private servers). */
const HARD_DENY = new Set(['dsh-plugins', 'dsh-plugins-runtime'])

/**
 * Start the codex MCP auto-mirror: mount portable servers now and live-sync
 * on config.toml changes. Returns a disposer that unmounts everything.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - plugin config (mcpMirrorDeny / mcpMirrorOnly / mcpServers).
 * @param {string} codexHome - codex config dir.
 * @returns {() => void} disposer.
 */
export function startMcpMirror(ctx, codexHome = join(homedir(), '.codex'), config = {}) {
  const configPath = join(codexHome, 'config.toml')
  const deny = new Set(HARD_DENY)
  for (const name of config.mcpMirrorDeny ?? []) deny.add(name)
  const only = config.mcpMirrorOnly ? new Set(config.mcpMirrorOnly) : null
  const explicitNames = new Set(Object.keys(config.mcpServers ?? {}))

  const mounted = new Map() // name → { cfgJson, dispose }
  let watcher = null
  let debounce = null
  let stopped = false

  async function sync() {
    if (stopped) return
    const McpClient = await loadMcpClient()
    if (McpClient === undefined) {
      ctx.logger?.warn?.('dsh-codex-sync: @deepseek-ai/dsh-mcp-client not installed; MCP mirror disabled')
      return
    }
    let text
    try {
      text = readFileSync(configPath, 'utf8')
    } catch {
      return // config not readable; keep current state
    }
    const wanted = new Map()
    for (const [name, srv] of parseCodexMcpServers(text)) {
      if (deny.has(name)) continue
      if (only && !only.has(name)) continue
      if (explicitNames.has(name)) continue
      const cfg = toMcpClientConfig(name, srv)
      if (cfg) wanted.set(name, cfg)
    }

    // unmount removed or changed
    for (const [name, entry] of mounted) {
      const next = wanted.get(name)
      if (!next || JSON.stringify(next) !== entry.cfgJson) {
        try {
          entry.dispose()
        } catch {
          /* already disposed */
        }
        mounted.delete(name)
        ctx.logger?.info?.(`dsh-codex-sync: unmounted mirrored MCP "${name}"`)
      }
    }
    // mount new
    for (const [name, cfg] of wanted) {
      if (mounted.has(name)) continue
      try {
        const dispose = await ctx.plugin(McpClient, { ...cfg, failOnStartupError: false })
        mounted.set(name, { cfgJson: JSON.stringify(cfg), dispose })
        ctx.logger?.info?.(`dsh-codex-sync: mirrored MCP "${name}" from ~/.codex/config.toml`)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-codex-sync: failed to mirror MCP "${name}": ${error?.message ?? error}`)
      }
    }
  }

  void sync()
  try {
    watcher = watch(configPath, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => void sync(), 500)
    })
  } catch {
    // config.toml does not exist (yet); mirror resumes on the next restart
  }

  return () => {
    stopped = true
    clearTimeout(debounce)
    try {
      watcher?.close()
    } catch {
      /* watcher already closed */
    }
    for (const [, entry] of mounted) {
      try {
        entry.dispose()
      } catch {
        /* ignore */
      }
    }
    mounted.clear()
  }
}
