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
import { registerCodexSkillProvider, registerPluginSkillProvider } from './skill-provider.js'
import { importCodex, attachAllImported, listImportCatalog } from './import-service.js'
import { exportToCodex, listExportCatalog } from './export-codex.js'
import { mountMcpServers, startMcpMirror, formatMcpStatus, parseCodexMcpServers, hardDenyNames } from './mcp.js'
import { effectiveSetting, readState, writeState, readSyncGroup, effectiveItemSync, writeItemSync, writeSyncDefault, writeAllItemSync, statePath } from './state.js'
import { readdirSync, readFileSync } from 'node:fs'

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
  mcpMirror:           { label: 'MCP 镜像',    default: (c) => c.mcpMirror !== false,      apply: 'hot' },
  skillSyncDefault:    { label: '新技能默认同步', default: () => readSyncGroup('skill').default, apply: 'hot' },
  mcpSyncDefault:      { label: '新 MCP 默认同步', default: () => readSyncGroup('mcp').default, apply: 'hot' },
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

  let mirrorHandle = null
  const setMirror = (on) => {
    if (on) {
      if (mirrorHandle) return
      mirrorHandle = startMcpMirror(ctx, codexHome, config)
      return
    }
    try { mirrorHandle?.dispose?.() } catch { /* ignore */ }
    mirrorHandle = null
  }

  /** Raw names under ~/.codex/skills (SKILL.md folders or flat .md files). */
  const listCodexSkillNames = (home, cfg) => {
    let entries
    try {
      entries = readdirSync(join(home, 'skills'))
    } catch {
      return []
    }
    return entries
      .filter((e) => !e.startsWith('.'))
      .filter((e) => {
        // keep the same shapes the provider accepts: dir/SKILL.md or flat *.md
        try {
          if (readdirSync(join(home, 'skills', e)).includes('SKILL.md')) return true
          return false
        } catch {
          return e.endsWith('.md') // not a directory → flat .md file
        }
      })
      .slice(0, cfg?.maxSkills ?? 100)
  }

  /** Server names parsed from ~/.codex/config.toml [mcp_servers.*]. */
  const listCodexMcpNames = (home) => {
    try {
      return [...parseCodexMcpServers(readFileSync(join(home, 'config.toml'), 'utf8')).keys()]
    } catch {
      return [] // config.toml missing/unreadable → nothing to list
    }
  }

  /** Nudge skill consumers to rescan after a per-item toggle. */
  const invalidateSkills = () => {
    try {
      ctx.get('skills')?.invalidate?.()
    } catch {
      /* older dsh builds rescan on their own schedule */
    }
  }

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
      () => skills.registerProvider((control) => registerPluginSkillProvider(codexHome, config, control)),
      'codex-sync.plugin-skills()',
    )
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
      description: 'Import Codex session history into dsh (idempotent; options: --dry-run, --list, --ids id1,id2, --limit N, --project 子串, --since ISO|ms, --include-subagents)',
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
        if (options['dry-run'] === true || options.dryRun === true) {
          options.dryRun = true
        }
        if (typeof options.ids === 'string' && options.ids.length > 0) {
          options.ids = options.ids.split(',').map((s) => s.trim()).filter(Boolean)
        }
        if (options.list === true || options['list'] === true) {
          const catalog = await listImportCatalog(persistence, options, codexHome)
          return { kind: 'success', text: JSON.stringify(catalog, null, 2) }
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
      name: 'export-codex',
      description: 'Export DSH sessions to new Codex rollouts (options: --dry-run, --ids id1,id2)',
      handler: async (invocation) => {
        if (!ef('enableImport', true)) {
          return { kind: 'success', text: '导入/导出功能已关闭（同步设置中开启后可用）' }
        }
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          return { kind: 'success', text: 'sessionPersistence 服务未加载，无法导出' }
        }
        const options = parseInput(rawInputOf(invocation))
        if (options['dry-run'] === true || options.dryRun === true) options.dryRun = true
        if (typeof options.ids === 'string' && options.ids.length > 0) {
          options.ids = options.ids.split(',').map((s) => s.trim()).filter(Boolean)
        }
        if (options.list === true) {
          if (options['include-subagents'] === true || options.includeSubagents === true) {
            options.includeSubagents = true
          }
          if (options['include-codex'] === true || options.includeCodex === true) {
            options.includeCodex = true
          }
          const catalog = await listExportCatalog(persistence, options, codexHome)
          return { kind: 'success', text: JSON.stringify(catalog, null, 2) }
        }
        const lines = await exportToCodex(persistence, options, codexHome)
        return { kind: 'success', text: lines.join('\n') }
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
        const next = val === 'on'
        // The two group-default keys live inside skillSync/mcpSync objects,
        // not as top-level booleans; route them through writeSyncDefault.
        if (key === 'skillSyncDefault') {
          writeSyncDefault('skill', next)
          invalidateSkills()
        } else if (key === 'mcpSyncDefault') {
          writeSyncDefault('mcp', next)
          void mirrorHandle?.refresh?.()
        } else {
          writeState({ [key]: next })
        }
        if (key === 'mcpMirror') setMirror(next)
        ctx.logger?.info?.(`dsh-codex-sync: setting ${key}=${val}`)
        return { kind: 'success', text: `${key}=${val}  ${meta.label} 已${next ? '开启' : '关闭'}（${APPLY_NOTE[meta.apply]}）` }
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

  // ── per-item sync management (skills + MCP servers) ───────────────────────
  // Shared helpers for the /codex-skill(s) and /codex-mcp(s) command family.

  /** List every known item of a kind with its effective on/off. */
  const listItems = (kind) => {
    const names = kind === 'skill'
      ? listCodexSkillNames(codexHome, config)
      : listCodexMcpNames(codexHome)
    const group = readSyncGroup(kind)
    const lines = names.map((name) => {
      const stored = group.items[name]
      const eff = typeof stored === 'boolean' ? stored : group.default
      const src = typeof stored === 'boolean' ? '' : '  (默认)'
      return `${name}=${eff ? 'on' : 'off'}${src}`
    })
    return [
      `${kind === 'skill' ? 'skills' : 'mcp'} (${names.length}) default=${group.default ? 'on' : 'off'}`,
      ...lines,
      kind === 'skill'
        ? 'hint: /codex-skill <名> on|off · /codex-skill all on|off · /codex-setting skillSyncDefault on|off'
        : 'hint: /codex-mcp <名> on|off · /codex-mcp all on|off · /codex-setting mcpSyncDefault on|off',
    ].join('\n')
  }

  /** Set one item (or all items with name='all'); returns report text. */
  const setItemSync = async (kind, rawName, rawVal) => {
    const val = String(rawVal ?? '').toLowerCase()
    if (val !== 'on' && val !== 'off') {
      return { kind: 'success', text: `用法: /${kind === 'skill' ? 'codex-skill' : 'codex-mcp'} <名|all> on|off` }
    }
    const next = val === 'on'
    if (String(rawName ?? '').toLowerCase() === 'all') {
      const names = kind === 'skill'
        ? listCodexSkillNames(codexHome, config)
        : listCodexMcpNames(codexHome)
      const n = writeAllItemSync(kind, names, next)
      if (kind === 'mcp') await mirrorHandle?.refresh?.()
      else invalidateSkills()
      return { kind: 'success', text: `${kind === 'skill' ? '技能' : 'MCP'} 全部=${next ? 'on' : 'off'}（${n} 项，即时生效）` }
    }
    const name = String(rawName ?? '').trim()
    if (!name) return { kind: 'success', text: '缺少名称' }
    const eff = writeItemSync(kind, name, next)
    if (kind === 'mcp') await mirrorHandle?.refresh?.()
    else invalidateSkills()
    return { kind: 'success', text: `${name}=${next ? 'on' : 'off'}（当前生效: ${eff ? 'on' : 'off'}）已持久化` }
  }

  ctx.commands.register({
    name: 'codex-skills',
    description: 'List every ~/.codex/skills entry and its per-item sync switch',
    handler: () => ({ kind: 'success', text: listItems('skill') }),
  })
  ctx.commands.register({
    name: 'codex-skill',
    description: 'Toggle one skill\'s sync: /codex-skill <名> on|off; "all" sets every skill',
    handler: (invocation) => {
      const [name, val] = String(rawInputOf(invocation)).trim().split(/\s+/u)
      return setItemSync('skill', name, val)
    },
  })
  ctx.commands.register({
    name: 'codex-mcps',
    description: 'List every ~/.codex/config.toml [mcp_servers.*] entry and its per-item sync switch',
    handler: () => ({ kind: 'success', text: listItems('mcp') }),
  })
  ctx.commands.register({
    name: 'codex-mcp',
    description: 'Toggle one mirrored MCP server: /codex-mcp <名> on|off; "all" sets every server (hot-applies)',
    handler: (invocation) => {
      const [name, val] = String(rawInputOf(invocation)).trim().split(/\s+/u)
      return setItemSync('mcp', name, val)
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
  if (ef('mcpMirror', config.mcpMirror !== false)) setMirror(true)
  ctx.effect(() => () => { try { mirrorHandle?.dispose?.() } catch { /* ignore */ } }, 'codex-sync.mcp-mirror()')

  // Silent JSON API for the import picker. Nested so we WAIT for webServer
  // (ctx.get at apply-time is often undefined and the SPA fallback ate GET).
  ctx.plugin({
    name: 'codex-sync-http',
    inject: ['webServer'],
    apply(inner) {
    const sendJson = (res, status, body) => {
      const text = JSON.stringify(body)
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(text)
    }
    const readBody = (req) => new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
    inner.effect(() => inner.webServer.register({
      kind: 'prefix',
      path: '/dsh-codex-sync',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const sub = url.pathname.replace(/^\/dsh-codex-sync/, '') || '/'
        if (sub === '/settings' && (req.method === 'GET' || req.method === 'HEAD')) {
          sendJson(res, 200, {
            settings: Object.fromEntries(Object.keys(SETTING_META).map((k) => [k, ef(k, SETTING_META[k].default(config))])),
          })
          return
        }
        if (sub === '/items' && (req.method === 'GET' || req.method === 'HEAD')) {
          // Per-item sync state for both groups: name → effective on/off plus
          // the raw override (null = follows group default) for UI badges.
          const buildGroup = (kind, names) => {
            const group = readSyncGroup(kind)
            return {
              default: group.default,
              items: Object.fromEntries(names.map((name) => {
                const stored = group.items[name]
                return [name, { on: typeof stored === 'boolean' ? stored : group.default, override: typeof stored === 'boolean' ? stored : null }]
              })),
            }
          }
          sendJson(res, 200, {
            skills: buildGroup('skill', listCodexSkillNames(codexHome, config)),
            mcps: buildGroup('mcp', listCodexMcpNames(codexHome)),
            hardDenyMcp: [...hardDenyNames()],
            mirrorStatus: mirrorHandle?.getStatus?.() ?? null,
          })
          return
        }
        if (sub === '/item' && req.method === 'POST') {
          let payload = {}
          try {
            payload = JSON.parse(await readBody(req) || '{}')
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' })
          }
          const kindRaw = String(payload.kind ?? '').toLowerCase()
          const kind = kindRaw.startsWith('skill') ? 'skill' : kindRaw.startsWith('mcp') ? 'mcp' : null
          if (!kind) return sendJson(res, 400, { error: "kind must be 'skill' or 'mcp'" })
          if (kind === 'mcp' && hardDenyNames().has(String(payload.name ?? ''))) {
            return sendJson(res, 403, { error: `${payload.name} is system-denied and cannot be mirrored` })
          }
          if (!['on', 'off', 'default'].includes(String(payload.value ?? ''))) {
            return sendJson(res, 400, { error: "value must be 'on' | 'off' | 'default'" })
          }
          const value = payload.value === 'on' ? true : payload.value === 'off' ? false : null
          const eff = writeItemSync(kind, String(payload.name ?? ''), value)
          if (kind === 'mcp') await mirrorHandle?.refresh?.()
          else invalidateSkills()
          inner.logger?.info?.(`dsh-codex-sync: item ${kind}/${payload.name}=${payload.value}`)
          sendJson(res, 200, { ok: true, kind, name: payload.name, value: payload.value, effective: eff })
          return
        }
        if (sub === '/item-all' && req.method === 'POST') {
          let payload = {}
          try {
            payload = JSON.parse(await readBody(req) || '{}')
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' })
          }
          const kindRaw = String(payload.kind ?? '').toLowerCase()
          const kind = kindRaw.startsWith('skill') ? 'skill' : kindRaw.startsWith('mcp') ? 'mcp' : null
          if (!kind) return sendJson(res, 400, { error: "kind must be 'skill' or 'mcp'" })
          if (typeof payload.value !== 'boolean') {
            return sendJson(res, 400, { error: 'value must be boolean' })
          }
          // Select-all covers every currently known item; HARD_DENY servers are
          // skipped — they can never be mirrored.
          const names = (kind === 'skill'
            ? listCodexSkillNames(codexHome, config)
            : listCodexMcpNames(codexHome).filter((n) => !hardDenyNames().has(n)))
          const n = writeAllItemSync(kind, names, payload.value)
          if (kind === 'mcp') await mirrorHandle?.refresh?.()
          else invalidateSkills()
          inner.logger?.info?.(`dsh-codex-sync: item-all ${kind}=${payload.value} (${n})`)
          sendJson(res, 200, { ok: true, kind, value: payload.value, count: n })
          return
        }
        if (sub === '/open-path' && req.method === 'POST') {
          // Reveal a codex-related config file / directory on the user's
          // machine. STRICT allowlist: only known sync-relevant paths, so the
          // endpoint can never be abused as an arbitrary file opener.
          let payload = {}
          try {
            payload = JSON.parse(await readBody(req) || '{}')
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' })
          }
          const targets = {
            instructions: { path: join(codexHome, 'instructions.md'), file: true },
            agents: { path: join(codexHome, 'AGENTS.md'), file: true },
            config: { path: join(codexHome, 'config.toml'), file: true },
            skills: { path: join(codexHome, 'skills'), file: false },
            codexHome: { path: codexHome, file: false },
            dshState: { path: statePath(), file: true },
            dshSessions: { path: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions'), file: false },
          }
          const target = targets[String(payload.target ?? '')]
          if (!target) {
            return sendJson(res, 400, { error: `unknown target; allowed: ${Object.keys(targets).join(', ')}` })
          }
          const { existsSync } = await import('node:fs')
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const run = promisify(execFile)
          try {
            if (!existsSync(target.path)) {
              return sendJson(res, 404, { error: `not found: ${target.path}` })
            }
            if (process.platform === 'darwin') {
              // Files: default app first; when nothing claims the extension
              // (e.g. .toml), fall back to default TEXT editor, then reveal
              // in Finder. Directories: Finder directly.
              if (target.file) {
                try {
                  await run('open', [target.path])
                } catch {
                  try {
                    await run('open', ['-t', target.path])
                  } catch {
                    await run('open', ['-R', target.path])
                  }
                }
              } else {
                await run('open', [target.path])
              }
            } else if (process.platform === 'win32') {
              await run('cmd', ['/c', 'start', '', target.path])
            } else {
              try {
                await run('xdg-open', [target.path])
              } catch {
                // Headless fallback: still reveal something useful.
                await run('open', ['-R', target.path])
              }
            }
            inner.logger?.info?.(`dsh-codex-sync: opened ${payload.target} → ${target.path}`)
            sendJson(res, 200, { ok: true, path: target.path })
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          }
          return
        }
        if (sub === '/setting' && req.method === 'POST') {
          let payload = {}
          try {
            payload = JSON.parse(await readBody(req) || '{}')
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' })
          }
          const { key: rawKey, value } = payload
          const key = keyAliases[String(rawKey ?? '').toLowerCase()] ?? rawKey
          const meta = key === undefined ? undefined : SETTING_META[key]
          if (!meta) {
            return sendJson(res, 400, { error: `unknown setting: ${rawKey}` })
          }
          if (typeof value !== 'boolean') {
            return sendJson(res, 400, { error: 'value must be boolean' })
          }
          if (key === 'skillSyncDefault') {
            writeSyncDefault('skill', value)
            invalidateSkills()
          } else if (key === 'mcpSyncDefault') {
            writeSyncDefault('mcp', value)
            void mirrorHandle?.refresh?.()
          } else {
            writeState({ [key]: value })
          }
          if (key === 'mcpMirror') setMirror(value)
          inner.logger?.info?.(`dsh-codex-sync: setting ${key}=${value ? 'on' : 'off'}`)
          sendJson(res, 200, { ok: true, key, value })
          return
        }
        if (sub === '/mcp-status' && (req.method === 'GET' || req.method === 'HEAD')) {
          const text = mirrorHandle?.getStatus ? formatMcpStatus(mirrorHandle.getStatus()) : 'MCP 镜像未启用'
          sendJson(res, 200, { text, autoImport: store.get() })
          return
        }
        if (sub === '/catalog' && (req.method === 'GET' || req.method === 'HEAD')) {
          const persistence = inner.get('sessionPersistence')
          if (persistence === undefined) return sendJson(res, 503, { error: 'sessionPersistence unavailable' })
          const include = url.searchParams.get('includeSubagents') === '1' || url.searchParams.get('includeSubagents') === 'true'
          try {
            const catalog = await listImportCatalog(persistence, { importSubagents: include }, codexHome)
            sendJson(res, 200, catalog)
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          }
          return
        }
        if (sub === '/export-catalog' && (req.method === 'GET' || req.method === 'HEAD')) {
          const persistence = inner.get('sessionPersistence')
          if (persistence === undefined) return sendJson(res, 503, { error: 'sessionPersistence unavailable' })
          const includeSubagents = url.searchParams.get('includeSubagents') === '1' || url.searchParams.get('includeSubagents') === 'true'
          const includeCodex = url.searchParams.get('includeCodex') === '1' || url.searchParams.get('includeCodex') === 'true'
          try {
            sendJson(res, 200, await listExportCatalog(persistence, { includeSubagents, includeCodex }, codexHome))
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          }
          return
        }
        if (sub === '/export' && req.method === 'POST') {
          if (!ef('enableImport', true)) return sendJson(res, 403, { error: 'export disabled' })
          const persistence = inner.get('sessionPersistence')
          if (persistence === undefined) return sendJson(res, 503, { error: 'sessionPersistence unavailable' })
          let payload = {}
          try {
            payload = JSON.parse(await readBody(req) || '{}')
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' })
          }
          const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : []
          const dryRun = payload.dryRun === true
          try {
            const lines = await exportToCodex(persistence, { ids, dryRun }, codexHome)
            sendJson(res, 200, { ok: true, text: lines.join('\n') })
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          }
          return
        }
        if (sub === '/import' && req.method === 'POST') {
          if (!ef('enableImport', true)) return sendJson(res, 403, { error: 'import disabled' })
          const persistence = inner.get('sessionPersistence')
          if (persistence === undefined) return sendJson(res, 503, { error: 'sessionPersistence unavailable' })
          let payload = {}
          try {
            payload = JSON.parse(await readBody(req) || '{}')
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' })
          }
          const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : []
          const includeSubagents = payload.includeSubagents === true
          try {
            const lines = await importCodex(inner, persistence, { ids, importSubagents: includeSubagents }, codexHome)
            sendJson(res, 200, { ok: true, text: lines.join('\n') })
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          }
          return
        }
        sendJson(res, 404, { error: 'not found' })
      },
    }), 'codex-sync.http')
    },
  })
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
