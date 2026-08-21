/**
 * dsh-codex-sync client bundle (browser side).
 *
 * Registers the "Sync settings" panel in the composer tool row
 * (`conversation.input.left` slot). One button toggles a menu with:
 *
 *   操作 (Actions)
 *     立即导入 / 查看镜像状态 / 刷新状态 — each with an ⓘ explainer
 *   功能开关 (Features) — one row per persisted setting, ⓘ explainer each
 *     enableImport / autoImport / enableInstructions / enableConfig /
 *     enableSkills / mcpMirror — toggle writes /codex-setting <key> on|off
 *   Language 语言 — switches the whole UI between English and 中文
 *                   (default: English, persisted in localStorage)
 *
 * Badge seeding: the panel seeds its badges by running /codex-settings once
 * (cards as feedback). Seeding starts on mount, retries on every open while
 * any badge is still unknown, and is only marked "done" after at least one
 * value was actually parsed — a failed seed can never leave permanent '？'.
 * After a successful seed, badges mirror in localStorage and opening the
 * menu adds no card. All other action feedback lives in conversation cards.
 *
 * Hand-authored CJS bundle (no build step). Adapted from dsh-import-agents'
 * SyncButton (MIT, (c) Chang-Tong / dongzhangust) — see NOTICE.
 */
window.__ModuleLoader__.load({ id: "dsh-codex-sync", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

const React = require('react')
const h = React.createElement
const { useEffect, useRef, useState } = React

/** Inline styles: reuse dsh global CSS variables (--dsw-*), literal fallbacks. */
const styles = {
  wrapper: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '24px',
    padding: '0 8px',
    border: '1px solid var(--dsw-border-subtle, rgba(127,127,127,0.35))',
    borderRadius: '6px',
    background: 'var(--dsw-surface-subtle, rgba(127,127,127,0.08))',
    color: 'var(--dsw-text-secondary, #555)',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  busy: { opacity: 0.6, cursor: 'progress' },
  menu: {
    position: 'absolute',
    left: '0',
    minWidth: '248px',
    zIndex: 1000,
    border: '1px solid var(--dsw-border-subtle, #e0e0e0)',
    borderRadius: '8px',
    background: 'var(--dsw-surface, #fff)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    padding: '4px',
    fontSize: '12px',
  },
  menuDown: { top: 'calc(100% + 4px)' },
  menuUp: { bottom: 'calc(100% + 4px)' },
  sectionTitle: {
    padding: '4px 8px 2px',
    color: 'var(--dsw-text-secondary, #888)',
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  rowWrap: { position: 'relative', width: '100%' },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: '6px',
    flex: '1 1 auto',
    minWidth: '0',
    width: '100%',
    padding: '6px 8px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-text-primary, #222)',
    fontSize: '12px',
    textAlign: 'left',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  itemHover: { background: 'var(--dsw-surface-hover, rgba(0,0,0,0.05))' },
  rowLabel: { color: 'var(--dsw-text-primary, #222)' },
  infoIcon: {
    flex: '0 0 auto',
    color: 'var(--dsw-text-secondary, #888)',
    fontSize: '12px',
    lineHeight: '1',
    cursor: 'default',
  },
  spacer: { flex: '1 1 auto' },
  tooltip: {
    position: 'absolute',
    left: '8px',
    top: 'calc(100% - 2px)',
    zIndex: 1200,
    maxWidth: '224px',
    padding: '6px 8px',
    borderRadius: '6px',
    background: 'var(--dsw-surface, #fff)',
    border: '1px solid var(--dsw-border-subtle, #e0e0e0)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.14)',
    color: 'var(--dsw-text-secondary, #555)',
    fontSize: '11px',
    lineHeight: '1.5',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    pointerEvents: 'none',
  },
  badge: {
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-border-subtle, #e0e0e0)',
    color: 'var(--dsw-text-secondary, #666)',
    minWidth: '24px',
    textAlign: 'center',
  },
  badgeOn: {
    color: 'var(--dsw-text-success, #2e7d32)',
    borderColor: 'var(--dsw-text-success, #2e7d32)',
  },
}

/** Settings exposed as on/off switches, in display order. */
const SETTING_KEYS = ['enableImport', 'autoImport', 'enableInstructions', 'enableConfig', 'enableSkills', 'mcpMirror']

/** Per-action explainers shown by the ⓘ icon (bilingual). */
const ACTION_INFO = {
  importNow: {
    zh: '立即增量导入全部 Codex 会话（幂等，已导入会自动跳过，子代理线程默认过滤）。',
    en: 'Incrementally import all Codex sessions now (idempotent — already imported ones are skipped; sub-agent threads are filtered by default).',
  },
  status: {
    zh: '查看 MCP 镜像状态：每个镜像服务器一行，附原因（已挂载/已排除/静音/失败…）。',
    en: 'Show MCP mirror state: one row per mirrored server with its reason (mounted/denied/silent/failed…).',
  },
  refresh: {
    zh: '重新读取宿主机上全部开关的真实值并刷新徽章。',
    en: 'Re-read the real value of every switch from the host and refresh the badges.',
  },
}
/** Per-setting explainers shown by the ⓘ icon (bilingual). */
const SETTING_INFO = {
  enableImport: {
    zh: '是否注册 /import-codex、/import-all 等导入命令。关闭后命令仍存在，但会提示"已关闭"。',
    en: 'Registers the /import-codex command family. When off, the commands keep existing but answer "disabled".',
  },
  autoImport: {
    zh: '启动时（第一个 startup 会话）自动增量导入 Codex 会话历史。',
    en: 'Automatically runs the incremental import at the first startup session.',
  },
  enableInstructions: {
    zh: '把 ~/.codex/instructions.md（无则 AGENTS.md）注入系统提示词，供 dsh 会话参考。适合关闭以避免与其它指令源冲突。',
    en: 'Injects ~/.codex/instructions.md (or AGENTS.md) into the system prompt. Turn off to avoid clashing with other instruction sources.',
  },
  enableConfig: {
    zh: '把 ~/.codex/config.toml 的模型配置摘要注入系统提示词。',
    en: 'Injects a summary of the ~/.codex/config.toml model settings into the system prompt.',
  },
  enableSkills: {
    zh: '把 ~/.codex/skills 注册为 dsh 一等公民技能（skill 工具可加载完整 SKILL.md）。',
    en: 'Registers ~/.codex/skills as first-class dsh skills (the skill tool can load full SKILL.md bodies).',
  },
  mcpMirror: {
    zh: '自动镜像 ~/.codex/config.toml 的 [mcp_servers.*] 到 dsh，并监听文件实时增删改。切换后需重启 dsh 生效。',
    en: 'Auto-mirrors [mcp_servers.*] from ~/.codex/config.toml into dsh and watches the file live. Takes effect after a dsh restart.',
  },
}

/** Language choice: default English; 'zh' when the user switched once. */
const LANG_KEY = 'codex-sync.lang'
function readLang() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LANG_KEY) === 'zh' ? 'zh' : 'en'
  } catch { return 'en' }
}
function writeLang(lang) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LANG_KEY, lang)
  } catch { /* no storage: session-local language */ }
}

/** Labels for the chosen UI language (default English). */
function labels(lang) {
  return lang === 'zh'
    ? {
        button: '同步设置',
        actions: '操作',
        importNow: '立即导入',
        status: '查看镜像状态',
        switches: '功能开关',
        refresh: '刷新状态',
        language: 'Language 语言',
        on: '开',
        off: '关',
        unknown: '？',
        noSession: '当前没有会话',
        commandMissing: '命令未找到',
        done: '完成',
        settingNames: {
          enableImport: '导入命令',
          autoImport: '自动导入',
          enableInstructions: '指令注入',
          enableConfig: '配置摘要',
          enableSkills: '技能注册',
          mcpMirror: 'MCP 镜像',
        },
      }
    : {
        button: 'Sync',
        actions: 'Actions',
        importNow: 'Import now',
        status: 'Mirror status',
        switches: 'Features',
        refresh: 'Refresh states',
        language: 'Language',
        on: 'on',
        off: 'off',
        unknown: '?',
        noSession: 'no active session',
        commandMissing: 'command not found',
        done: 'done',
        settingNames: {
          enableImport: 'Import commands',
          autoImport: 'Auto import',
          enableInstructions: 'Instructions',
          enableConfig: 'Config summary',
          enableSkills: 'Skills',
          mcpMirror: 'MCP mirror',
        },
      }
}

/** Success marker: set ONLY after /codex-settings actually populated badges. */
const SEEDED_KEY = 'codex-sync.seeded.v2'
function readSeeded() {
  try {
    if (typeof localStorage === 'undefined') return false
    if (localStorage.getItem('codex-sync.seeded') !== null) localStorage.removeItem('codex-sync.seeded') // legacy buggy marker
    return localStorage.getItem(SEEDED_KEY) === '1'
  } catch { return false }
}
function writeSeeded() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SEEDED_KEY, '1')
  } catch { /* no storage: retry next open */ }
}

const PREFIX = 'codex-sync.setting.'
function readBadge(key) {
  try {
    if (typeof localStorage === 'undefined') return undefined
    const v = localStorage.getItem(PREFIX + key)
    return v === 'on' ? true : v === 'off' ? false : undefined
  } catch { return undefined }
}
function writeBadge(key, on) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(PREFIX + key, on ? 'on' : 'off')
  } catch { /* storage unavailable: badge stays session-local */ }
}

/** Parse `key=on` / `key=off` machine tokens from a command result. */
function parseStateLines(text) {
  const out = {}
  const re = /\b([A-Za-z]+)=(on|off)\b/g
  let m
  while ((m = re.exec(text ?? '')) !== null) {
    out[m[1]] = m[2] === 'on'
  }
  return out
}

function SyncMenu({ runCommand }) {
  const [lang, setLang] = useState(readLang)
  const t = labels(lang)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null) // null | 'seed' | 'import' | 'status' | 'refresh' | 'toggle'
  const [settings, setSettings] = useState(() => (
    Object.fromEntries(SETTING_KEYS.map((k) => [k, readBadge(k)]))
  )) // key -> true|false|undefined
  const [seeded, setSeeded] = useState(readSeeded)
  const [hover, setHover] = useState(null)
  const [tooltipId, setTooltipId] = useState(null) // which ⓘ tooltip is hovering
  const [up, setUp] = useState(false)
  const rootRef = useRef(undefined)

  const run = async (kind, line) => {
    if (busy !== null) return
    setBusy(kind)
    try {
      const outcome = await runCommand(line)
      if (kind === 'seed' || kind === 'refresh' || kind === 'toggle') {
        applyParsed(outcome.text)
      }
    } catch {
      /* the card shows command failures; nothing inline to render */
    } finally {
      setBusy(null)
    }
  }

  const applyParsed = (text) => {
    const parsed = parseStateLines(text)
    let any = false
    for (const k of SETTING_KEYS) {
      if (parsed[k] !== undefined) {
        any = true
        setSettings((prev) => ({ ...prev, [k]: parsed[k] }))
        writeBadge(k, parsed[k])
      }
    }
    if (any) {
      setSeeded(true)
      writeSeeded()
    }
    return any
  }

  // Seed badges on mount (before the user ever opens the menu) — one card per
  // page load until a seed succeeds; afterwards everything mirrors locally.
  useEffect(() => {
    if (!readSeeded()) void run('seed', '/codex-settings')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = () => {
    if (busy !== null) return
    const el = rootRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      setUp(spaceBelow < 280) // the taller settings panel needs more room
    }
    setOpen(!open)
    // Retry seeding on open while any badge is still unknown (a failed seed
    // must never leave permanent '？').
    if (!open && !readSeeded()) {
      void run('seed', '/codex-settings')
    }
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggleSetting = (key) => {
    const next = !(settings[key] === true)
    setSettings((prev) => ({ ...prev, [key]: next }))
    writeBadge(key, next)
    setOpen(false)
    void run('toggle', `/codex-setting ${key} ${next ? 'on' : 'off'}`)
  }

  const switchLang = () => {
    const next = lang === 'zh' ? 'en' : 'zh'
    setLang(next)
    writeLang(next)
  }

  const badgeLabel = (v) => (v === undefined ? t.unknown : v ? t.on : t.off)

  /**
   * One Switch/action row. Layout: 「name ⓘ ……… badge」 — the ⓘ sits right
   * after the name (inside the row button), the badge stays pinned to the
   * right edge, and hovering ⓘ shows a floating tooltip (no click expands).
   */
  const row = (id, label, badge, onActivate) => {
    const info = (SETTING_INFO[id] ?? ACTION_INFO[id])?.[lang]
    return h(
      'div', { key: id, style: styles.rowWrap },
      h('button', {
        type: 'button',
        style: Object.assign({}, styles.item, hover === id ? styles.itemHover : {}),
        onMouseEnter: () => setHover(id),
        onMouseLeave: () => setHover(null),
        onClick: onActivate,
      },
        h('span', { style: styles.rowLabel }, label),
        info === undefined
          ? null
          : h('span', {
            style: styles.infoIcon,
            onMouseEnter: () => setTooltipId(id),
            onMouseLeave: () => setTooltipId(null),
            onClick: (event) => { event.stopPropagation(); event.preventDefault() },
          }, 'ⓘ'),
        h('span', { style: styles.spacer }),
        badge === undefined
          ? null
          : h('span', {
            style: Object.assign({}, styles.badge, badge === true ? styles.badgeOn : {}),
          }, badgeLabel(badge)),
      ),
      tooltipId === id && info !== undefined
        ? h('div', { style: styles.tooltip }, info)
        : null,
    )
  }

  const items = [
    h('div', { key: 'actions', style: styles.sectionTitle }, t.actions),
    row('importNow', t.importNow, undefined, () => { setOpen(false); void run('import', '/import-all') }),
    row('status', t.status, undefined, () => { setOpen(false); void run('status', '/mcp-status') }),
    row('refresh', t.refresh, undefined, () => { setOpen(false); void run('refresh', '/codex-settings') }),
    h('div', { key: 'switches', style: styles.sectionTitle }, t.switches),
    ...SETTING_KEYS.map((key) => row(key, t.settingNames[key], settings[key], () => { setOpen(false); toggleSetting(key) })),
    h('div', { key: 'langGap', style: styles.sectionTitle }, ' '),
    row('lang', t.language, undefined, () => { switchLang() }),
  ]

  return h('span', { ref: rootRef, style: styles.wrapper },
    h('button', {
      type: 'button',
      title: t.button,
      style: Object.assign({}, styles.button, busy !== null ? styles.busy : {}),
      onClick: toggle,
      disabled: busy !== null,
    }, t.button, ' ', open ? '▴' : '▾'),
    open
      ? h('div', { style: Object.assign({}, styles.menu, up ? styles.menuUp : styles.menuDown) }, items)
      : null,
  )
}

/** This client plugin's entry name. */
exports.name = 'dsh-codex-sync'
/** Slot registry + remote command execution surfaces. */
exports.inject = ['slots', 'remote', 'remote.commands']

/**
 * Mount the Sync settings panel into the composer tool row.
 * `slots.inject` waits for ui-conversation to declare `conversation.input.left`
 * and auto-unmounts if the declaration disappears.
 */
exports.apply = function apply(ctx) {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      name: 'conversation.input.left',
      id: 'codex-sync-sync-button',
      inject: (sessionId) => ({
        runCommand: async (line) => {
          if (sessionId === undefined) {
            return { ok: false, text: 'no active session' }
          }
          const result = await ctx.remote.commands.execute(sessionId, line)
          if (!result.ok) {
            return { ok: false, text: `${result.error.code}: ${result.error.message}` }
          }
          if (result.value === undefined) {
            return { ok: true, text: 'command not found' }
          }
          const outcome = result.value.result
          return { ok: outcome.kind === 'success', text: outcome.text ?? 'done' }
        },
      }),
    },
    SyncMenu,
  ))
}

return module.exports; } });