/**
 * dsh-codex-sync — one-stop bidirectional sync between OpenAI Codex and
 * DeepSeek Harness (dsh).
 *
 * What this single plugin row mounts:
 *   1. First-class DSH skills from ~/.codex/skills (ctx.skills provider;
 *      full SKILL.md bodies, directory resource base — no system-prompt hack).
 *   2. System-prompt sections for ~/.codex/instructions.md (or AGENTS.md) and
 *      a summary of ~/.codex/config.toml model settings.
 *   3. Slash commands to import Codex session history into dsh as real,
 *      resumable sessions (with the >512MB-single-file crash fix and
 *      workspace auto-attach):
 *        /import-codex [--limit N] [--project 子串] [--since ISO|ms]
 *        /import-all           (codex only today; same as /import-codex)
 *        /attach-workspaces    (retro-fit all imported sessions)
 *        /mcp-status           (auto-mirror state, one row per server)
 *        /auto-import [on|off] (persisted auto-import toggle; no arg = show)
 *   5. Optional MCP servers mounted through @deepseek-ai/dsh-mcp-client,
 *      configured under `mcpServers` (e.g. the Cloudflare code-mode MCP).
 *   6. autoImport (config default; the /auto-import toggle overrides it):
 *      incrementally import codex sessions at the first startup session.
 *
 * The Codex side (reverse direction) is handled by the CLI:
 *   npx dsh-codex-sync codex-install    # wires [mcp_servers.dsh-plugins]
 *
 * The composer Sync button (client bundle, lib/client.js) drives
 * /import-all, /auto-import and /mcp-status from the GUI.
 *
 * @module dsh-codex-sync
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bridgeInstructionsSection, bridgeConfigSection } from './bridge.js'
import { registerCodexSkillProvider } from './skill-provider.js'
import { importCodex, attachAllImported } from './import-service.js'
import { mountMcpServers, startMcpMirror, formatMcpStatus } from './mcp.js'
import { effectiveSetting, readState, writeState } from './state.js'

/**
 * Persistent auto-import toggle, stored in the state file
 * (~/.dsh/codex-sync.json). The web client mirrors the value in
 * localStorage (badge) and flips it through /auto-import; /mcp-status
 * reports the authoritative value. The platform settings seam does not
 * expose third-party namespaces to the web client (dsh-host-apiproxy
 * allowlist), so the settings service is deliberately not used.
 * @param {object} ctx - plugin context.
 * @param {boolean} configDefault - config.autoImport default.
 * @returns {{get: () => boolean, set: (value: boolean) => void}}
 */
function autoImportStore(configDefault) {
  return {
    get: () => effectiveSetting('autoImport', configDefault === true),
    set: (value) => { writeState({ autoImport: value }) },
  }
}

/**
 * On/off features exposed in the Sync settings UI (client bundle) and via
 * /codex-settings + /codex-setting. Each maps to a persisted key in
 * ~/.dsh/codex-sync.json; the persisted value overrides the config default.
 * `apply` describes when a change takes effect (hot ≈ next prompt/build).
 */
const SETTING_META = {
  enableImport:        { label: '导入命令',     default: (c) => c.enableImport !== false,  apply: 'hot' },
  autoImport:          { label: '自动导入',     default: (c) => c.autoImport === true,      apply: 'startup' },
  enableInstructions:  { label: '指令注入',     default: (c) => c.enableInstructions !== false, apply: 'next-session' },
  enableConfig:        { label: '配置摘要',     default: (c) => c.enableConfig !== false,   apply: 'next-session' },
  enableSkills:        { label: '技能注册',     default: (c) => c.enableSkills !== false,   apply: 'next-session' },
  mcpMirror:           { label: 'MCP 镜像',    default: (c) => c.mcpMirror !== false,      apply: 'restart' },
}
/** Lowercase alias map so /codex-setting accept case-insensitive keys. */
const keyAliases = Object.fromEntries(Object.keys(SETTING_META).map((k) => [k.toLowerCase(), k]))

const APPLY_NOTE = {
  hot: '当前会话相关提示擦除后即生效',
  startup: '下次启动会话生效',
  'next-session': '下次会话生效',
  restart: '重启 dsh 生效',
}

export const name = 'codex-sync'
/** Hard dependencies; sessionPersistence / skills / workspaceRegistry are read via ctx.get(). */
export const inject = ['systemPrompt', 'commands']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @param {string} [config.codexHome] - Codex config dir (default ~/.codex)
 * @param {boolean} [config.enableInstructions] - inject codex instructions into the prompt
 * @param {boolean} [config.enableConfig] - inject a codex config summary into the prompt
 * @param {boolean} [config.enableSkills] - register ~/.codex/skills as first-class dsh skills
 * @param {number} [config.maxSkills] - max codex skills to register (default 100)
 * @param {boolean} [config.enableImport] - register /import-codex etc. (default true)
 * @param {number} [config.maxSessionBytes] - skip codex rollout files larger than this
 * @param {boolean} [config.importSubagents] - import codex sub-agent threads
 *   too (default false: they are filtered so the session list stays clean)
 *   (default 256 MiB; guards against the Node string-limit crash on >512MB files)
 * @param {Record<string, object>} [config.mcpServers] - explicit MCP servers to mount,
 *   keyed by serverName, value = dsh-mcp-client config minus serverName
 * @param {boolean} [config.mcpMirror] - auto-mirror ~/.codex/config.toml [mcp_servers.*]
 *   into dsh (default true); 'dsh-plugins' is always excluded to avoid recursion
 * @param {string[]} [config.mcpMirrorDeny] - extra server names never mirrored
 * @param {string[]} [config.mcpMirrorOnly] - if set, mirror ONLY these server names
 * @param {string[]} [config.mcpMirrorSilent] - mirror these stdio servers with stderr
 *   discarded (silences chatty servers like mcp-remote; MCP protocol runs on
 *   stdin/stdout so this is safe) — e.g. ['exa']
 * @param {boolean} [config.autoImport] - import codex sessions at the first
 *   startup session (default false; the settings toggle — or the state-file
 *   fallback — overrides this when set)
 */
export function apply(ctx, config = {}) {
  const codexHome = config.codexHome ?? join(homedir(), '.codex')
  const store = autoImportStore(config.autoImport === true)
  /** Effective persisted value for a setting key, config default as fallback. */
  const ef = (key, configDefault) => effectiveSetting(key, configDefault)

  const runImport = async () => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      return { kind: 'success', text: 'sessionPersistence 服务未加载，无法导入' }
    }
    const lines = await importCodex(ctx, persistence, { importSubagents: config.importSubagents === true }, codexHome)
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * Command handlers receive a CommandInvocation object (`{ rawInput, … }`)
   * in current dsh; older builds passed the raw string. Normalize both.
   */
  const rawInputOf = (input) => {
    if (typeof input === 'string') return input
    if (input && typeof input === 'object' && typeof input.rawInput === 'string') return input.rawInput
    return ''
  }

  // ── 1. first-class skills from ~/.codex/skills ────────────────────────────
  // Provider stays mounted; its list() consults the persisted toggle so the
  // Switch in Sync settings takes effect without re-applying the plugin.
  const skills = ctx.get('skills')
  if (skills !== undefined) {
    ctx.effect(
      () => skills.registerProvider((control) => registerCodexSkillProvider(
        codexHome, config, control,
        () => ef('enableSkills', config.enableSkills !== false),
      )),
      'codex-sync.skills()',
    )
  }

  // ── 2. system-prompt sections (instructions + config summary) ─────────────
  // Sections always mount; their text() is gated by the persisted toggle, so
  // disabling emits an empty section and re-enabling needs no restart.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'codex-sync:instructions',
    order: 122,
    text: () => ef('enableInstructions', config.enableInstructions !== false) ? bridgeInstructionsSection(codexHome) : '',
  }), 'codex-sync.instructions()')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'codex-sync:config',
    order: 123,
    text: () => ef('enableConfig', config.enableConfig !== false) ? bridgeConfigSection(codexHome) : '',
  }), 'codex-sync.config()')

  // ── 3. import slash commands + sync controls ─────────────────────────────
  // Commands always mount; their handlers honor the persisted toggle so the
  // Sync settings Switch disables them without a restart.
  {
    ctx.commands.register({
      name: 'import-codex',
      description: 'Import Codex session history into dsh (idempotent; options: --limit N, --project 子串, --since ISO|ms, --include-subagents 连子代理线程一起导入)',
      handler: async (invocation) => {
        if (!ef('enableImport', true)) {
          return { kind: 'success', text: '导入功能已关闭（同步设置中开启后可导入）' }
        }
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          return { kind: 'success', text: 'sessionPersistence 服务未加载，无法导入' }
        }
        const options = parseInput(rawInputOf(invocation))
        if (options['include-subagents'] === true || config.importSubagents === true) {
          options.importSubagents = true
        }
        const lines = await importCodex(ctx, persistence, options, codexHome)
        return { kind: 'success', text: lines.join('\n') }
      },
    })
    ctx.commands.register({
      name: 'import-all',
      description: 'Import all supported agent history (codex today) — same as /import-codex',
      handler: async () => {
        if (!ef('enableImport', true)) {
          return { kind: 'success', text: '导入功能已关闭（同步设置中开启后可导入）' }
        }
        return runImport()
      },
    })
    ctx.commands.register({
      name: 'attach-workspaces',
      description: 'Attach all imported sessions to their cwd-matched workspace (creates missing ones)',
      handler: async () => {
        if (!ef('enableImport', true)) {
          return { kind: 'success', text: '导入功能已关闭（同步设置中开启后可导入）' }
        }
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          return { kind: 'success', text: 'sessionPersistence 服务未加载' }
        }
        const lines = await attachAllImported(ctx, persistence)
          return { kind: 'success', text: lines.length === 0 ? '没有可归位的会话（或 workspace 服务未加载）' : lines.join('\n') }
      },
    })
  }

  // /codex-settings — machine-readable key=on|off, one line per feature
  ctx.commands.register({
    name: 'codex-settings',
    description: 'Show every Sync setting (key=on|off) — the Sync settings UI reads this, no arg',
    handler: () => {
      const lines = Object.entries(SETTING_META).map(([key, meta]) => {
        const on = ef(key, meta.default(config))
        return `${key}=${on ? 'on' : 'off'}  ${meta.label}（${APPLY_NOTE[meta.apply]}）`
      })
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  // /codex-setting — persist one toggle: /codex-setting <key> on|off|show
  ctx.commands.register({
    name: 'codex-setting',
    description: 'Toggle one Sync setting: /codex-setting <key> on|off (no arg shows state). Keys: ' + Object.keys(SETTING_META).join(', '),
    handler: (invocation) => {
      const [rawKey, rawVal] = String(rawInputOf(invocation)).trim().split(/\s+/u)
      // case-insensitive lookup, canonical key (enableInstructions) in output
      const key = (keyAliases[String(rawKey ?? '').toLowerCase()])
      const meta = key === undefined ? undefined : SETTING_META[key]
      if (!meta) {
        return { kind: 'success', text: `/codex-setting 未知设置 "${rawKey ?? ''}"\n可用: ${Object.keys(SETTING_META).join(', ')}` }
      }
      const val = String(rawVal ?? '').toLowerCase()
      if (val === 'on' || val === 'off') {
        writeState({ [key]: val === 'on' })
        ctx.logger?.info?.(`dsh-codex-sync: setting ${key}=${val}`)
        return { kind: 'success', text: `${key}=${val}  ${meta.label} 已${val === 'on' ? '开启' : '关闭'}（${APPLY_NOTE[meta.apply]}）` }
      }
      const on = ef(key, meta.default(config))
      return { kind: 'success', text: `${key}=${on ? 'on' : 'off'}  ${meta.label}（${APPLY_NOTE[meta.apply]}）` }
    },
  })

  // /mcp-status — one line per mirror server with its reason
  ctx.commands.register({
    name: 'mcp-status',
    description: 'Show the codex MCP auto-mirror state (per-server reason: mounted/denied/silent/failed…)',
    handler: () => {
      const status = mirrorHandle?.getStatus?.()
      if (!status) {
        return { kind: 'success', text: `MCP 镜像未启用（mcpMirror: false）\nautoImport: ${store.get() ? 'on' : 'off'}` }
      }
      return { kind: 'success', text: formatMcpStatus(status) + `\nautoImport: ${store.get() ? 'on' : 'off'}` }
    },
  })

  // /auto-import — persisted toggle (settings namespace; state-file fallback);
  // no arg returns machine-readable first line
  ctx.commands.register({
    name: 'auto-import',
    description: 'Toggle automatic codex session import at startup: /auto-import on|off (no arg shows the state)',
    handler: (invocation) => {
      const arg = rawInputOf(invocation).trim().toLowerCase()
      const current = store.get()
      if (arg === 'on' || arg === 'off') {
        const next = arg === 'on'
        store.set(next)
        ctx.logger?.info?.(`dsh-codex-sync: autoImport set to ${next}`)
        return { kind: 'success', text: `autoImport=${next ? 'on' : 'off'}\n自动导入已${next ? '开启' : '关闭'}（下次启动生效）` }
      }
      return { kind: 'success', text: `autoImport=${current ? 'on' : 'off'}\n当前：${current ? '开启' : '关闭'}` }
    },
  })

  // ── autoImport: run once at the first startup session ────────────────────
  if (store.get()) {
    let ran = false
    ctx.effect(() => ctx.on('agent/session-start', ({ source }) => {
      if (ran || source !== 'startup') return
      ran = true
      void runImport().then((result) => {
        ctx.logger?.info?.('dsh-codex-sync: auto import\n' + result.text)
      }).catch((error) => {
        ctx.logger?.warn?.(`dsh-codex-sync: auto import failed: ${error?.message ?? error}`)
      })
    }), 'codex-sync.auto-import()')
  }

  // ── 4. MCP: explicit servers + auto mirror of ~/.codex/config.toml ────────
  if (config.mcpServers && typeof config.mcpServers === 'object') {
    const servers = Object.entries(config.mcpServers)
    if (servers.length > 0) {
      void mountMcpServers(ctx, servers)
    }
  }
  let mirrorHandle = null
  if (ef('mcpMirror', config.mcpMirror !== false)) {
    ctx.effect(() => {
      mirrorHandle = startMcpMirror(ctx, codexHome, config)
      return () => {
        mirrorHandle?.dispose?.()
        mirrorHandle = null
      }
    }, 'codex-sync.mcp-mirror()')
  }
}

/** Parse `--key value` / `--key=value` command input (same grammar as dsh-import-agents). */
export function parseInput(rawInput) {
  const options = {}
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const eq = token.indexOf('=')
    if (token.startsWith('--') && eq >= 0) {
      options[token.slice(2, eq)] = token.slice(eq + 1)
    } else if (token.startsWith('--')) {
      // bare boolean flag: `--flag` (→ true) or `--flag value`
      if (i + 1 >= tokens.length || tokens[i + 1].startsWith('--')) options[token.slice(2)] = true
      else options[token.slice(2)] = tokens[++i]
    }
  }
  if (options.limit !== undefined) options.limit = Number(options.limit)
  if (options.since !== undefined && !/^\d+$/u.test(options.since)) {
    const ms = Date.parse(options.since)
    if (!Number.isNaN(ms)) options.since = ms
  }
  return options
}

export default { name, inject, apply }
