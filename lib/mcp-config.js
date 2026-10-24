/** Portable Codex TOML mapping. No credential files or machine-specific paths. */
import { parse } from 'smol-toml'
import { RuntimeCompatibilityError } from './runtime-compat.js'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export class McpConfigError extends Error {
  constructor(code, field) { super(field ? `${code}: ${field}` : code); this.code = code }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const HARD_DENY = new Set(['dsh-plugins', 'dsh-plugins-runtime'])
export function parseCodexMcpServers(text) {
  let doc
  try { doc = parse(text) } catch { throw new McpConfigError('invalid-toml') }
  if (doc.mcp_servers !== undefined && !record(doc.mcp_servers)) throw new McpConfigError('invalid-mcp-servers')
  return new Map(Object.entries(doc.mcp_servers ?? {}).map(([name, srv]) => {
    if (!record(srv)) throw new McpConfigError('invalid-server')
    return [name, { args: [], env: {}, ...srv, name }]
  }))
}
function strings(value, field) {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new McpConfigError('invalid-field', field)
  return [...value]
}
function dictionary(value, field) {
  if (!record(value) || Object.values(value).some(v => typeof v !== 'string')) throw new McpConfigError('invalid-field', field)
  return { ...value }
}
function envValue(name, env) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new McpConfigError('invalid-env-name')
  if (typeof env[name] !== 'string' || !env[name]) throw new McpConfigError('missing-env', name)
  return env[name]
}
function timeout(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 300000) throw new McpConfigError('invalid-timeout', field)
  return Math.ceil(value)
}
export function startupTimeout(srv, config = {}) {
  if (srv.startup_timeout_sec !== undefined && typeof srv.startup_timeout_sec !== 'number') throw new McpConfigError('invalid-timeout', 'startup_timeout_sec')
  const ms = srv.startup_timeout_sec === undefined ? srv.startup_timeout_ms : srv.startup_timeout_sec * 1000
  return timeout(ms, timeout(config.mcpStartupTimeoutMs, 20000, 'mcpStartupTimeoutMs'), 'startup_timeout_sec')
}
export function toMcpClientConfig(name, srv, env = process.env) {
  if (!record(srv)) throw new McpConfigError('invalid-server')
  if (srv.enabled !== undefined && typeof srv.enabled !== 'boolean') throw new McpConfigError('invalid-field', 'enabled')
  if (srv.enabled === false) return null
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) throw new McpConfigError('invalid-server-name')
  for (const field of ['enabled_tools', 'disabled_tools', 'tool_approval']) {
    if (srv[field] !== undefined && !(field === 'disabled_tools' && Array.isArray(srv[field]) && srv[field].length === 0)) throw new McpConfigError('unsupported-tool-policy', field)
  }
  if (srv.tool_timeout_sec !== undefined && typeof srv.tool_timeout_sec !== 'number') throw new McpConfigError('invalid-timeout', 'tool_timeout_sec')
  const toolMs = srv.tool_timeout_sec === undefined ? 60000 : srv.tool_timeout_sec * 1000
  const common = { serverName: name, toolCallTimeoutMs: timeout(toolMs, 60000, 'tool_timeout_sec') }
  if (srv.command !== undefined) {
    if (typeof srv.command !== 'string' || !srv.command.trim() || srv.url !== undefined) throw new McpConfigError('invalid-field', 'command/url')
    const extra = dictionary(srv.env ?? {}, 'env')
    for (const key of strings(srv.env_vars ?? [], 'env_vars')) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new McpConfigError('invalid-env-name')
      if (!Object.hasOwn(extra, key) && typeof env[key] === 'string') extra[key] = env[key]
    }
    let cwd
    if (srv.cwd !== undefined) {
      if (typeof srv.cwd !== 'string' || !srv.cwd) throw new McpConfigError('invalid-field', 'cwd')
      cwd = srv.cwd.startsWith('~/') ? join(homedir(), srv.cwd.slice(2)) : srv.cwd
      if (!isAbsolute(cwd)) throw new McpConfigError('relative-cwd-not-portable')
    }
    return { ...common, transport: 'stdio', command: srv.command, args: strings(srv.args ?? [], 'args'), env: extra, ...(cwd ? { cwd } : {}) }
  }
  if (typeof srv.url === 'string') {
    let url
    try { url = new URL(srv.url) } catch { throw new McpConfigError('invalid-field', 'url') }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new McpConfigError('invalid-field', 'url')
    const headers = {}
    const setHeader = (name, value) => {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
      headers[name] = value
    }
    for (const [name, value] of Object.entries(dictionary(srv.http_headers ?? {}, 'http_headers'))) setHeader(name, value)
    for (const [name, variable] of Object.entries(dictionary(srv.env_http_headers ?? {}, 'env_http_headers'))) setHeader(name, envValue(variable, env))
    if (srv.bearer_token_env_var !== undefined) setHeader('Authorization', `Bearer ${envValue(srv.bearer_token_env_var, env)}`)
    return { ...common, transport: 'streamable-http', url: srv.url, headers }
  }
  throw new McpConfigError('unsupported-transport')
}
export function isReverseBridge(name, srv) {
  if (HARD_DENY.has(name)) return true
  const base = value => String(value).split(/[\\/]/u).at(-1).replace(/\.(?:exe|cmd)$/iu, '')
  const command = base(srv.command ?? '')
  const args = Array.isArray(srv.args) ? srv.args.filter(v => typeof v === 'string') : []
  const bridge = /^(?:dsh-codex-sync(?:\.js)?|dsh-plugins-runtime)(?:@[^/\\]+)?$/u
  if (bridge.test(command)) return true
  if (/^node(?:js)?$/u.test(command)) return bridge.test(base(args[0] ?? ''))
  if (/^(?:npx|npm|pnpm|bunx)$/u.test(command)) {
    const entry = args.filter(value => !value.startsWith('-') && !['exec', 'dlx'].includes(value))[0]
    return entry !== undefined && bridge.test(entry)
  }
  return false
}
/** Never serialize upstream error.message/cause: it can contain URLs, headers or TOML. */
export function safeMcpError(error) {
  if (error instanceof McpConfigError || error instanceof RuntimeCompatibilityError) return error.message
  if (error?.name === 'AbortError') return 'cancelled'
  if (error?.code === 'ENOENT') return 'config-missing (last-good connections retained)'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'config-unreadable (last-good connections retained)'
  return 'MCP connection failed'
}
