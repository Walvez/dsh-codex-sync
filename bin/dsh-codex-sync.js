#!/usr/bin/env node
/**
 * dsh-codex-sync CLI — the Codex side of the sync.
 *
 *   dsh-codex-sync codex-install   [--profile web] [--allow-runtime] [--dir ~/.dsh-bridge] [--no-build]
 *       Clone + build the reverse MCP server (deepseek-harness-plugin-mcp,
 *       (c) bobleer, MIT) and wire it into ~/.codex/config.toml as
 *       [mcp_servers.dsh-plugins], so Codex can discover/inspect/install dsh
 *       plugins through dsh__* MCP tools. Re-runs update the block in place.
 *
 *   dsh-codex-sync codex-uninstall
 *       Remove the managed block from ~/.codex/config.toml (and, with
 *       --dir, optionally delete the cloned server).
 *
 *   dsh-codex-sync doctor
 *       Print a health report: codex skills/sessions found, oversized-file
 *       risk, cloudflare token presence + MCP handshake, reverse-MCP status.
 *
 * Everything here edits only two places: ~/.codex/config.toml (inside a
 * clearly-marked managed block) and the clone dir. No other config is touched.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const HOME = homedir()
const CODEX_CONFIG = join(HOME, '.codex', 'config.toml')
const CODEX_HOME = join(HOME, '.codex')
const REVERSE_REPO = 'https://github.com/bobleer/deepseek-harness-plugin-mcp.git'
const MARKER_START = '# >>> dsh-codex-sync managed block >>>'
const MARKER_END = '# <<< dsh-codex-sync managed block <<<'

function log(...args) {
  console.log(...args)
}

/** Parse CLI args into a map of flag -> value(true for bare flags). */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out[a.slice(2)] = argv[i + 1]
        i += 1
      } else {
        out[a.slice(2)] = true
      }
    }
  }
  return out
}

/** PATH for the spawned MCP server so `dsh` (and friends) resolve. */
function serverEnvPath() {
  return [
    join(HOME, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':')
}

/** Build the managed config.toml block for the reverse MCP server. */
function buildManagedBlock(cliPath, profile, allowRuntime) {
  const args = allowRuntime
    ? ['--profile', profile, '--allow-install', '--allow-runtime']
    : ['--profile', profile, '--allow-install']
  const lines = []
  lines.push(MARKER_START)
  lines.push('# Reverse bridge: let Codex discover/inspect/install dsh plugins')
  lines.push('# (--allow-runtime off by default to avoid spawning a second dsh instance)')
  lines.push('[mcp_servers.dsh-plugins]')
  lines.push(`command = "${cliPath}"`)
  lines.push(`args = [${args.map((a) => `"${a}"`).join(', ')}]`)
  lines.push('startup_timeout_sec = 120')
  lines.push('')
  lines.push('[mcp_servers.dsh-plugins.env]')
  lines.push(`PATH = "${serverEnvPath()}"`)
  lines.push(MARKER_END)
  return lines.join('\n')
}

/** Insert or replace the managed block in ~/.codex/config.toml. */
export function upsertCodexConfig(block) {
  let content = ''
  try {
    content = readFileSync(CODEX_CONFIG, 'utf8')
  } catch {
    content = ''
  }
  const start = content.indexOf(MARKER_START)
  const end = content.indexOf(MARKER_END)
  if (start >= 0 && end > start) {
    content = content.slice(0, start) + block + content.slice(end + MARKER_END.length)
  } else {
    content = content.replace(/\s*$/u, '\n') + '\n' + block + '\n'
  }
  writeFileSync(CODEX_CONFIG, content)
}

/** Ensure the reverse MCP server exists (clone + install + build on demand). */
export function ensureReverseServer(dir, noBuild) {
  const cliPath = join(dir, 'dist', 'cli.js')
  if (existsSync(cliPath)) {
    log(`✓ reverse MCP server already built: ${cliPath}`)
    return cliPath
  }
  log(`→ cloning ${REVERSE_REPO} into ${dir}`)
  execFileSync('git', ['clone', '--depth', '1', REVERSE_REPO, dir], { stdio: 'inherit' })
  if (noBuild) {
    log('! --no-build: server cloned but not built; run `pnpm install && pnpm build` inside the dir')
    return cliPath
  }
  log('→ pnpm install')
  execFileSync('pnpm', ['install'], { cwd: dir, stdio: 'inherit' })
  log('→ pnpm build')
  execFileSync('pnpm', ['build'], { cwd: dir, stdio: 'inherit' })
  if (!existsSync(cliPath)) {
    throw new Error(`build finished but ${cliPath} is missing`)
  }
  log(`✓ built: ${cliPath}`)
  return cliPath
}

async function cmdCodexInstall(args) {
  const dir = args.dir ?? join(HOME, '.dsh-bridge', 'deepseek-harness-plugin-mcp')
  const profile = args.profile ?? 'web'
  const cliPath = ensureReverseServer(dir, args['no-build'] === true)
  const block = buildManagedBlock(cliPath, profile, args['allow-runtime'] === true)
  upsertCodexConfig(block)
  log(`✓ wired [mcp_servers.dsh-plugins] into ${CODEX_CONFIG}`)
  log(`  restart Codex (or start a new session) to pick it up; tools: dsh_plugin_search / dsh_plugin_install / …`)
}

function cmdCodexUninstall(args) {
  let content = ''
  try {
    content = readFileSync(CODEX_CONFIG, 'utf8')
  } catch {
    log('! no ~/.codex/config.toml found — nothing to remove')
    return
  }
  const start = content.indexOf(MARKER_START)
  const end = content.indexOf(MARKER_END)
  if (start < 0 || end <= start) {
    log('! no managed block found in ~/.codex/config.toml')
  } else {
    writeFileSync(CODEX_CONFIG, content.slice(0, start) + content.slice(end + MARKER_END.length))
    log('✓ removed managed block from ~/.codex/config.toml')
  }
  if (args.dir) {
    const dir = String(args.dir)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      log(`✓ deleted ${dir}`)
    }
  }
}

/** Quick cloudflare MCP handshake test (initialize only). */
async function testCloudflareMcp(token) {
  try {
    const res = await fetch('https://mcp.cloudflare.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-codex-sync-doctor', version: PKG_VERSION } },
      }),
    })
    const text = await res.text()
    if (text.includes('insufficient_scope')) {
      return '✗ token lacks user:read / account:read (add Account → Account Settings → Read)'
    }
    if (text.includes('"result"')) return '✓ handshake OK (cloudflare-api)'
    return `? unexpected response: ${text.slice(0, 120)}`
  } catch (error) {
    return `✗ request failed: ${error.message}`
  }
}

async function cmdDoctor(args) {
  const lines = []

  // codex skills
  try {
    const { countCodexSkills } = await import('../lib/bridge.js')
    const n = countCodexSkills(CODEX_HOME)
    lines.push(`codex skills: ${n} in ${join(CODEX_HOME, 'skills')}`)
  } catch (error) {
    lines.push(`codex skills: read failed (${error.message})`)
  }

  // codex sessions + oversized risk
  try {
    const { listCodexSessions, parseCodexSession } = await import('../lib/codex-reader.mjs')
    const files = listCodexSessions(join(CODEX_HOME, 'sessions'))
    let big = 0
    let ok = 0
    let subagents = 0
    const { statSync } = await import('node:fs')
    for (const f of files) {
      let size = 0
      try {
        size = statSync(f).size
      } catch {
        continue
      }
      if (size > 256 * 1024 * 1024) big += 1
      else {
        try {
          const header = parseCodexSession(f).header
          if (header.id) {
            ok += 1
            if (header.parentThreadId) subagents += 1
          }
        } catch {
          /* unreadable */
        }
      }
    }
    lines.push(`codex sessions: ${files.length} files, ${ok} importable, ${subagents} sub-agent threads (filtered from import), ${big} oversized (>256MiB, skipped)`)
  } catch (error) {
    lines.push(`codex sessions: scan failed (${error.message})`)
  }

  // cloudflare token (only reported, never printed)
  const tokenEnv = join(HOME, '.dsh', '.env')
  let token = ''
  try {
    const env = readFileSync(tokenEnv, 'utf8')
    const m = env.match(/^CLOUDFLARE_API_TOKEN=(.*)$/mu)
    if (m && m[1].trim()) {
      token = m[1].trim()
      lines.push(`cloudflare token: present in ${tokenEnv} (${token.length} chars)`)
      lines.push(`cloudflare MCP: ${await testCloudflareMcp(token)}`)
    } else {
      lines.push('cloudflare token: not set in ~/.dsh/.env')
    }
  } catch {
    lines.push(`cloudflare token: ${tokenEnv} unreadable`)
  }

  // reverse MCP status
  const dir = args.dir ?? join(HOME, '.dsh-bridge', 'deepseek-harness-plugin-mcp')
  const cliPath = join(dir, 'dist', 'cli.js')
  lines.push(`reverse MCP server: ${existsSync(cliPath) ? `built at ${cliPath}` : `not built (run \`dsh-codex-sync codex-install\`)`}`)
  try {
    const cfg = readFileSync(CODEX_CONFIG, 'utf8')
    lines.push(`codex config: ${cfg.includes('[mcp_servers.dsh-plugins]') ? 'dsh-plugins MCP wired' : 'dsh-plugins MCP NOT wired'}`)
  } catch {
    lines.push('codex config: ~/.codex/config.toml unreadable')
  }

  console.log(lines.join('\n'))
}

const requireSR = createRequire(import.meta.url)
function runRepairCli(args) {
  const { runRepairCli: run } = requireSR('../lib/session-repair.mjs')
  return run(args)
}

const [cmd, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)

switch (cmd) {
  case 'codex-install':
    await cmdCodexInstall(args)
    break
  case 'codex-uninstall':
    cmdCodexUninstall(args)
    break
  case 'doctor':
    await cmdDoctor(args)
    break
  case 'repair-sessions':
    runRepairCli(args)
    break
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    console.log(`dsh-codex-sync ${PKG_VERSION} — Codex ↔ dsh sync CLI

Usage:
  dsh-codex-sync codex-install     [--profile web] [--allow-runtime] [--dir ~/.dsh-bridge] [--no-build]
  dsh-codex-sync codex-uninstall   [--dir ~/.dsh-bridge]
  dsh-codex-sync doctor
  dsh-codex-sync repair-sessions   [--fix] [--root <~/.dsh/sessions>]

Docs: https://github.com/Walvez/dsh-codex-sync
`)
    break
  default:
    console.error(`unknown command: ${cmd}`)
    process.exitCode = 1
}

void fileURLToPath
