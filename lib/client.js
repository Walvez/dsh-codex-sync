/**
 * dsh-codex-sync client bundle (browser side).
 *
 * Registers the modern "Sync settings" panel in the composer tool row
 * (`conversation.input.left` slot). One button toggles a menu with:
 *
 *   Actions (操作)
 *     - Import now (立即导入)
 *     - Mirror status (查看镜像状态)
 *     - Refresh states (刷新状态)
 *   Features (功能开关) — live iOS-style smooth toggle switches
 *     - enableImport / autoImport / enableInstructions / enableConfig /
 *       enableSkills / mcpMirror
 *   Language (语言) — seamless English ⇄ 简体中文 toggle
 *
 * Fully adapts to DSH dark and light themes via native `--dsw-alias-*` tokens.
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

/* --- SVG Icons --- */
const svgIcon = (children, viewBox = "0 0 24 24", size = 13) => h('svg', {
  width: size,
  height: size,
  viewBox,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '2',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  style: { flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }
}, children)

const Icons = {
  sync: () => svgIcon([
    h('path', { key: 1, d: 'M21.5 2v6h-6' }),
    h('path', { key: 2, d: 'M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67' })
  ], '0 0 24 24', 12),
  import: () => svgIcon([
    h('path', { key: 1, d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
    h('polyline', { key: 2, points: '7 10 12 15 17 10' }),
    h('line', { key: 3, x1: '12', y1: '15', x2: '12', y2: '3' })
  ], '0 0 24 24', 13),
  status: () => svgIcon([
    h('rect', { key: 1, x: '2', y: '2', width: '20', height: '8', rx: '2', ry: '2' }),
    h('rect', { key: 2, x: '2', y: '14', width: '20', height: '8', rx: '2', ry: '2' }),
    h('line', { key: 3, x1: '6', y1: '6', x2: '6.01', y2: '6' }),
    h('line', { key: 4, x1: '6', y1: '18', x2: '6.01', y2: '18' })
  ], '0 0 24 24', 13),
  refresh: () => svgIcon([
    h('polyline', { key: 1, points: '23 4 23 10 17 10' }),
    h('polyline', { key: 2, points: '1 20 1 14 7 14' }),
    h('path', { key: 3, d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' })
  ], '0 0 24 24', 13),
  globe: () => svgIcon([
    h('circle', { key: 1, cx: '12', cy: '12', r: '10' }),
    h('line', { key: 2, x1: '2', y1: '12', x2: '22', y2: '12' }),
    h('path', { key: 3, d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' })
  ], '0 0 24 24', 13),
  info: () => svgIcon([
    h('circle', { key: 1, cx: '12', cy: '12', r: '10' }),
    h('line', { key: 2, x1: '12', y1: '16', x2: '12', y2: '12' }),
    h('line', { key: 3, x1: '12', y1: '8', x2: '12.01', y2: '8' })
  ], '0 0 24 24', 12),
}

/** Theme-adaptive styles: full integration with DSH `--dsw-alias-*` design system. */
const styles = {
  wrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    userSelect: 'none',
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    height: '26px',
    padding: '0 9px',
    border: '1px solid var(--dsw-alias-border-l2, var(--dsw-border-subtle, rgba(127,127,127,0.28)))',
    borderRadius: '6px',
    background: 'var(--dsw-alias-button-elevated-fill, var(--dsw-surface-subtle, rgba(127,127,127,0.06)))',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-text-secondary, currentColor))',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  busy: { opacity: 0.6, cursor: 'progress' },
  menu: {
    position: 'absolute',
    left: '0',
    minWidth: '260px',
    zIndex: 1000,
    border: '1px solid var(--dsw-alias-border-l2, var(--dsw-border-subtle, rgba(127,127,127,0.22)))',
    borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-surface, #ffffff))',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    boxShadow: '0 12px 36px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.08)',
    padding: '6px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary, var(--dsw-text-primary, currentColor))',
  },
  menuDown: { top: 'calc(100% + 5px)' },
  menuUp: { bottom: 'calc(100% + 5px)' },
  sectionTitle: {
    padding: '6px 8px 3px',
    color: 'var(--dsw-alias-label-tertiary, var(--dsw-text-tertiary, #8e8e93))',
    fontSize: '10px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  divider: {
    height: '1px',
    margin: '4px 6px',
    background: 'var(--dsw-alias-border-l1, var(--dsw-border-subtle, rgba(127,127,127,0.14)))',
  },
  rowWrap: {
    position: 'relative',
    width: '100%',
    margin: '1px 0',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: '7px',
    width: '100%',
    padding: '6px 8px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary, var(--dsw-text-primary, currentColor))',
    fontSize: '12px',
    textAlign: 'left',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background 0.12s ease, color 0.12s ease',
  },
  itemHover: {
    background: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-surface-hover, rgba(127,127,127,0.12)))',
  },
  rowLabel: {
    color: 'var(--dsw-alias-label-primary, var(--dsw-text-primary, currentColor))',
    fontWeight: '400',
  },
  infoIconWrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    color: 'var(--dsw-alias-label-tertiary, var(--dsw-text-tertiary, #999))',
    borderRadius: '50%',
    cursor: 'help',
    transition: 'color 0.15s ease',
  },
  spacer: { flex: '1 1 auto' },
  switchTrack: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    width: '28px',
    height: '16px',
    borderRadius: '999px',
    flexShrink: 0,
    transition: 'background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  switchThumb: {
    position: 'absolute',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    backgroundColor: '#ffffff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  tagPill: {
    fontSize: '11px',
    fontWeight: '500',
    padding: '2px 7px',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.12))',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-text-secondary, #888))',
  },
  tooltip: {
    position: 'absolute',
    left: '6px',
    right: '6px',
    top: 'calc(100% + 2px)',
    zIndex: 1300,
    padding: '7px 10px',
    borderRadius: '8px',
    // Same contrast pair as the menu (layer + primary label). Do not use
    // --dsw-alias-label-primary-inverted: in dark theme it is a dark color
    // and becomes unreadable on a dark tooltip/menu surface.
    background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))',
    border: '1px solid var(--dsw-alias-border-l2)',
    boxShadow: '0 8px 24px var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.28))',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '11px',
    lineHeight: '1.45',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    pointerEvents: 'none',
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  dialog: {
    width: 'min(560px, 100%)',
    maxHeight: 'min(72vh, 640px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '12px',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-surface, #fff))',
    border: '1px solid var(--dsw-alias-border-l2)',
    boxShadow: '0 16px 48px var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.28))',
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
  },
  dialogHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  search: {
    flex: '1 1 auto',
    minWidth: 0,
    height: '28px',
    padding: '0 8px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    outline: 'none',
  },
  filterBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    height: '28px',
    padding: '0 8px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '11px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  dialogBody: {
    flex: '1 1 auto',
    overflowY: 'auto',
    padding: '6px 8px 10px',
  },
  dialogFoot: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '10px 12px',
    borderTop: '1px solid var(--dsw-alias-border-l1)',
  },
  ghostBtn: {
    height: '28px',
    padding: '0 12px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    cursor: 'pointer',
  },
  primaryBtn: {
    height: '28px',
    padding: '0 12px',
    borderRadius: '6px',
    border: 'none',
    background: 'var(--dsw-alias-button-info-fill, var(--dsw-static-deepseek-500, #4176e6))',
    color: '#fff',
    fontSize: '12px',
    cursor: 'pointer',
  },
  treeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    padding: '5px 6px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    fontSize: '12px',
    textAlign: 'left',
  },
  muted: { opacity: 0.45 },
  importedTag: {
    fontSize: '10px',
    color: 'var(--dsw-alias-label-tertiary)',
    marginLeft: '4px',
  },
}

/** Settings exposed as on/off switches, in display order. */
const SETTING_KEYS = ['enableImport', 'autoImport', 'enableInstructions', 'enableConfig', 'enableSkills', 'mcpMirror']

/** Per-action explainers shown by the ⓘ icon (bilingual). */
const ACTION_INFO = {
  importNow: {
    zh: '打开导入对话框：按项目勾选 Codex 对话，默认过滤子代理。',
    en: 'Open the import picker: choose Codex chats by project. Sub-agent threads hidden by default.',
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
        langBadge: '简体中文',
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
        pickerTitle: '导入 Codex 会话',
        selectAll: '全选',
        search: '搜索项目或对话标题',
        hideSub: '过滤子代理',
        cancel: '取消',
        importN: '导入',
        loading: '正在读取 Codex…',
        empty: '没有可导入的会话',
        imported: '已导入',
        error: '无法读取目录，请重启 dsh web',
        importedOk: '导入完成',
        reloadHint: '刷新页面后即可在会话列表里看到新对话，不用重启 dsh。',
        reloadNow: '刷新页面',
        reloadLater: '稍后',
      }
    : {
        button: 'Sync',
        actions: 'Actions',
        importNow: 'Import now',
        status: 'Mirror status',
        switches: 'Features',
        refresh: 'Refresh states',
        language: 'Language',
        langBadge: 'English',
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
        pickerTitle: 'Import Codex sessions',
        selectAll: 'Select all',
        search: 'Search projects or titles',
        hideSub: 'Hide sub-agents',
        cancel: 'Cancel',
        importN: 'Import',
        loading: 'Reading Codex…',
        empty: 'Nothing to import',
        imported: 'imported',
        error: 'Could not load catalog — restart dsh web',
        importedOk: 'Import finished',
        reloadHint: 'Reload the page to see new chats in the session list. No dsh restart needed.',
        reloadNow: 'Reload page',
        reloadLater: 'Later',
      }
}

/** Success marker: set ONLY after /codex-settings actually populated badges. */
const SEEDED_KEY = 'codex-sync.seeded.v2'
function readSeeded() {
  try {
    if (typeof localStorage === 'undefined') return false
    if (localStorage.getItem('codex-sync.seeded') !== null) localStorage.removeItem('codex-sync.seeded')
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

function triState(selected, total) {
  if (total <= 0) return 'empty'
  if (selected <= 0) return 'empty'
  if (selected >= total) return 'checked'
  return 'partial'
}

function walkSessions(nodes, fn) {
  for (const n of nodes || []) {
    fn(n)
    walkSessions(n.children, fn)
  }
}

function collectSelectable(projects) {
  const ids = []
  for (const p of projects || []) {
    walkSessions(p.sessions, (n) => { if (!n.imported) ids.push(n.id) })
  }
  return ids
}

function filterCatalog(projects, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return projects
  const matchNode = (n) => {
    const self = String(n.title || '').toLowerCase().includes(q)
    const kids = (n.children || []).map(matchNode).filter(Boolean)
    if (!self && kids.length === 0) return null
    return Object.assign({}, n, { children: self ? (n.children || []) : kids })
  }
  const out = []
  for (const p of projects || []) {
    if (String(p.label || '').toLowerCase().includes(q)) {
      out.push(p)
      continue
    }
    const sessions = (p.sessions || []).map(matchNode).filter(Boolean)
    if (sessions.length) out.push(Object.assign({}, p, { sessions }))
  }
  return out
}

function TriBox({ state, disabled }) {
  const border = '1px solid var(--dsw-alias-border-l3)'
  const filled = state === 'empty' ? 'transparent' : (disabled
    ? 'var(--dsw-alias-border-l2)'
    : 'var(--dsw-alias-state-success-primary, #22c55e)')
  return h('span', {
    style: {
      width: '14px',
      height: '14px',
      flexShrink: 0,
      borderRadius: '3px',
      border,
      background: filled,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: disabled ? 'var(--dsw-alias-label-tertiary)' : '#fff',
      fontSize: '10px',
      lineHeight: '1',
    },
  }, state === 'checked' ? '✓' : state === 'partial' ? '■' : '')
}

function ImportPicker({ lang, runCommand, onClose }) {
  const t = labels(lang)
  const [hideSub, setHideSub] = useState(true)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState({})
  const [expanded, setExpanded] = useState({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const load = async (includeSubagents) => {
    setError(null)
    try {
      const res = await fetch('/dsh-codex-sync/catalog?includeSubagents=' + (includeSubagents ? '1' : '0'), { credentials: 'same-origin' })
      const type = res.headers.get('content-type') || ''
      if (!res.ok || !type.includes('json')) throw new Error(String(res.status))
      const data = await res.json()
      if (!data || !Array.isArray(data.projects)) throw new Error('bad catalog')
      setCatalog(data)
      const next = {}
      collectSelectable(data.projects).forEach((id) => { next[id] = true })
      setSelected(next)
    } catch (e) {
      setError(t.error)
    }
  }

  useEffect(() => { void load(!hideSub) }, [hideSub])

  const projects = filterCatalog(catalog?.projects, query)
  const selectable = collectSelectable(projects)
  const selectedCount = selectable.filter((id) => selected[id]).length
  const allState = triState(selectedCount, selectable.length)

  const toggleTree = (nodes, on) => {
    setSelected((prev) => {
      const next = Object.assign({}, prev)
      walkSessions(nodes, (n) => { if (!n.imported) next[n.id] = on })
      return next
    })
  }
  const toggleId = (id, on) => {
    setSelected((prev) => Object.assign({}, prev, { [id]: on }))
  }

  const confirm = async () => {
    const ids = selectable.filter((id) => selected[id])
    if (ids.length === 0 || busy) return
    setBusy(true)
    const extra = hideSub ? '' : ' --include-subagents'
    const result = await runCommand('/import-codex --ids ' + ids.join(',') + extra)
    setBusy(false)
    if (result && result.ok === false) {
      setError(result.text || t.error)
      return
    }
    setDone(true)
  }

  const renderNodes = (nodes, depth) => nodes.map((n) => {
    const hasKids = (n.children || []).length > 0
    const open = expanded[n.id] === true
    const kidSelectable = []
    walkSessions(n.children, (c) => { if (!c.imported) kidSelectable.push(c.id) })
    const selfOn = n.imported ? false : !!selected[n.id]
    const kidOn = kidSelectable.filter((id) => selected[id]).length
    const box = n.imported
      ? 'checked'
      : hasKids
        ? triState((selfOn ? 1 : 0) + kidOn, 1 + kidSelectable.length)
        : (selfOn ? 'checked' : 'empty')
    return h('div', { key: n.id },
      h('div', {
        style: Object.assign({}, styles.treeRow, n.imported ? styles.muted : {}, { paddingLeft: 6 + depth * 16 }),
      },
        h('button', {
          type: 'button',
          style: { border: 'none', background: 'transparent', cursor: hasKids ? 'pointer' : 'default', color: 'inherit', width: 16, padding: 0 },
          onClick: () => hasKids && setExpanded((p) => Object.assign({}, p, { [n.id]: !open })),
        }, hasKids ? (open ? '▾' : '▸') : ''),
        h('button', {
          type: 'button',
          disabled: n.imported,
          style: { border: 'none', background: 'transparent', padding: 0, cursor: n.imported ? 'default' : 'pointer' },
          onClick: () => {
            if (n.imported) return
            const on = box !== 'checked'
            toggleId(n.id, on)
            toggleTree(n.children, on)
          },
        }, h(TriBox, { state: box, disabled: n.imported })),
        h('span', {
          style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: n.title,
          onClick: () => hasKids && setExpanded((p) => Object.assign({}, p, { [n.id]: !open })),
        }, n.title),
        n.imported ? h('span', { style: styles.importedTag }, t.imported) : null,
      ),
      open && hasKids ? renderNodes(n.children, depth + 1) : null,
    )
  })

  const body = error
    ? h('div', { style: { padding: 16, color: 'var(--dsw-alias-state-error-primary)' } }, error)
    : catalog === null
      ? h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-tertiary)' } }, t.loading)
      : projects.length === 0
        ? h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-tertiary)' } }, t.empty)
        : projects.map((p) => {
          const ids = collectSelectable([p])
          const st = ids.length === 0
            ? ((p.sessions || []).length ? 'checked' : 'empty')
            : triState(ids.filter((id) => selected[id]).length, ids.length)
          const open = expanded['p:' + (p.cwd || p.label)] === true
          return h('div', { key: p.cwd || p.label },
            h('div', { style: styles.treeRow },
              h('button', {
                type: 'button',
                style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', width: 16, padding: 0 },
                onClick: () => setExpanded((prev) => Object.assign({}, prev, { ['p:' + (p.cwd || p.label)]: !open })),
              }, open ? '▾' : '▸'),
              h('button', {
                type: 'button',
                style: { border: 'none', background: 'transparent', padding: 0, cursor: ids.length ? 'pointer' : 'default' },
                onClick: () => toggleTree(p.sessions, st !== 'checked'),
              }, h(TriBox, { state: st, disabled: ids.length === 0 })),
              h('span', {
                style: { fontWeight: 500, flex: '1 1 auto', cursor: 'pointer' },
                title: p.cwd || '',
                onClick: () => setExpanded((prev) => Object.assign({}, prev, { ['p:' + (p.cwd || p.label)]: !open })),
              }, p.label),
            ),
            open ? renderNodes(p.sessions, 1) : null,
          )
        })

  if (done) {
    return h('div', { style: styles.overlay },
      h('div', { style: Object.assign({}, styles.dialog, { maxHeight: 'none', width: 'min(420px, 100%)' }) },
        h('div', { style: Object.assign({}, styles.dialogHead, { fontWeight: 600 }) }, t.importedOk),
        h('div', { style: Object.assign({}, styles.dialogBody, { padding: '16px 14px', fontSize: '13px', lineHeight: '1.5' }) }, t.reloadHint),
        h('div', { style: styles.dialogFoot },
          h('button', { type: 'button', style: styles.ghostBtn, onClick: onClose }, t.reloadLater),
          h('button', {
            type: 'button',
            style: styles.primaryBtn,
            onClick: () => { window.location.reload() },
          }, t.reloadNow),
        ),
      ),
    )
  }

  return h('div', {
    style: styles.overlay,
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
  },
    h('div', {
      style: styles.dialog,
      onKeyDown: (e) => { if (e.key === 'Escape') onClose() },
    },
      h('div', { style: styles.dialogHead },
        h('button', {
          type: 'button',
          style: Object.assign({}, styles.filterBtn, { border: 'none' }),
          onClick: () => {
            const on = allState !== 'checked'
            const next = Object.assign({}, selected)
            selectable.forEach((id) => { next[id] = on })
            setSelected(next)
          },
        }, h(TriBox, { state: allState }), ' ', t.selectAll),
        h('input', {
          style: styles.search,
          placeholder: t.search,
          value: query,
          onChange: (e) => setQuery(e.target.value),
        }),
        h('button', {
          type: 'button',
          style: styles.filterBtn,
          onClick: () => setHideSub(!hideSub),
        }, hideSub ? '● ' : '○ ', t.hideSub),
      ),
      h('div', { style: styles.dialogBody }, body),
      h('div', { style: styles.dialogFoot },
        h('button', { type: 'button', style: styles.ghostBtn, onClick: onClose }, t.cancel),
        h('button', {
          type: 'button',
          style: Object.assign({}, styles.primaryBtn, (busy || selectedCount === 0) ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
          disabled: busy || selectedCount === 0,
          onClick: confirm,
        }, t.importN + ' ' + selectedCount),
      ),
    ),
  )
}

function SyncMenu({ runCommand }) {
  const [lang, setLang] = useState(readLang)
  const t = labels(lang)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null) // null | 'seed' | 'import' | 'status' | 'refresh' | 'toggle'
  const [settings, setSettings] = useState(() => (
    Object.fromEntries(SETTING_KEYS.map((k) => [k, readBadge(k)]))
  )) // key -> true|false|undefined
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
      /* command errors render into the card */
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
      writeSeeded()
    }
    return any
  }

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
      setUp(spaceBelow < 290)
    }
    setOpen(!open)
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

  /** Render iOS-style switch slider with theme-adaptive track */
  const renderSwitch = (isOn) => {
    const bg = isOn === true
      ? 'var(--dsw-alias-state-success-primary, var(--dsw-static-green-500, #22c55e))'
      : isOn === false
        ? 'var(--dsw-alias-border-l3, rgba(127,127,127,0.28))'
        : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.16))'
    return h('span', {
      style: Object.assign({}, styles.switchTrack, { backgroundColor: bg }),
      title: isOn === true ? t.on : isOn === false ? t.off : t.unknown
    },
      h('span', {
        style: Object.assign({}, styles.switchThumb, {
          left: isOn === true ? '14px' : '2px',
          opacity: isOn === undefined ? 0.6 : 1,
        })
      })
    )
  }

  /** One item row */
  const row = (id, label, iconComponent, rightNode, onActivate) => {
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
        iconComponent ? iconComponent() : null,
        h('span', { style: styles.rowLabel }, label),
        info === undefined
          ? null
          : h('span', {
            style: styles.infoIconWrapper,
            onMouseEnter: () => setTooltipId(id),
            onMouseLeave: () => setTooltipId(null),
            onClick: (event) => { event.stopPropagation(); event.preventDefault() },
          }, Icons.info()),
        h('span', { style: styles.spacer }),
        rightNode || null,
      ),
      tooltipId === id && info !== undefined
        ? h('div', { style: styles.tooltip }, info)
        : null,
    )
  }

  const items = [
    h('div', { key: 'actions', style: styles.sectionTitle }, t.actions),
    row('importNow', t.importNow, Icons.import, null, () => { setOpen(false); setPickerOpen(true) }),
    row('status', t.status, Icons.status, null, () => { setOpen(false); void run('status', '/mcp-status') }),
    row('refresh', t.refresh, Icons.refresh, null, () => { setOpen(false); void run('refresh', '/codex-settings') }),
    h('div', { key: 'div1', style: styles.divider }),
    h('div', { key: 'switches', style: styles.sectionTitle }, t.switches),
    ...SETTING_KEYS.map((key) => row(
      key,
      t.settingNames[key],
      null,
      renderSwitch(settings[key]),
      () => { setOpen(false); toggleSetting(key) }
    )),
    h('div', { key: 'div2', style: styles.divider }),
    row('lang', t.language, Icons.globe, h('span', { style: styles.tagPill }, t.langBadge), () => { switchLang() }),
  ]

  return h('span', { ref: rootRef, style: styles.wrapper },
    h('button', {
      type: 'button',
      title: t.button,
      style: Object.assign({}, styles.button, busy !== null ? styles.busy : {}),
      onClick: toggle,
      disabled: busy !== null,
    },
      Icons.sync(),
      t.button,
      ' ',
      open ? '▴' : '▾'
    ),
    open
      ? h('div', { style: Object.assign({}, styles.menu, up ? styles.menuUp : styles.menuDown) }, items)
      : null,
    pickerOpen
      ? h(ImportPicker, { lang, runCommand, onClose: () => setPickerOpen(false) })
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