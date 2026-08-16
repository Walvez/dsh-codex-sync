/**
 * dsh-codex-sync client bundle (browser side).
 *
 * Registers a "Sync settings" dropdown in the composer tool row
 * (`conversation.input.left` slot, same slot the dsh-import-agents plugin
 * used). The button toggles a small menu (chevron ▾/▴) with three items:
 *
 *   1. 立即导入 — runs /import-all (incremental, idempotent codex import)
 *   2. 自动导入 — toggles the persisted /auto-import setting
 *   3. 查看镜像状态 — runs /mcp-status
 *
 * Action results render inline next to the button. Hand-authored CJS bundle
 * (no build step). Adapted from dsh-import-agents' SyncButton (MIT, (c)
 * Chang-Tong / dongzhangust) — see NOTICE.
 */
window.__ModuleLoader__.load({ id: "dsh-codex-sync", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

const React = require('react')
const h = React.createElement
const { useEffect, useRef, useState } = React

/** Result toast auto-hide delay. */
const RESULT_HIDE_MS = 8000

/** Inline styles: reuse dsh global CSS variables (--dsw-*), literal fallbacks. */
const styles = {
  wrapper: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '24px',
    padding: '0 8px',
    border: '1px solid var(--dsw-border-subtle, #e0e0e0)',
    borderRadius: '6px',
    background: 'var(--dsw-surface-subtle, transparent)',
    color: 'var(--dsw-text-secondary, #666)',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  busy: { opacity: 0.6, cursor: 'progress' },
  menu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: '0',
    minWidth: '180px',
    zIndex: 1000,
    border: '1px solid var(--dsw-border-subtle, #e0e0e0)',
    borderRadius: '8px',
    background: 'var(--dsw-surface, #fff)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    padding: '4px',
    fontSize: '12px',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
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
  badge: {
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-border-subtle, #e0e0e0)',
    color: 'var(--dsw-text-secondary, #666)',
  },
  badgeOn: {
    color: 'var(--dsw-text-success, #2e7d32)',
    borderColor: 'var(--dsw-text-success, #2e7d32)',
  },
  result: {
    maxWidth: '260px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
  },
  ok: { color: 'var(--dsw-text-success, #2e7d32)' },
  error: { color: 'var(--dsw-text-danger, #c62828)' },
}

/** Hide the result toast after a delay. */
function scheduleClear(timer, set, delayMs) {
  if (timer.current !== undefined) window.clearTimeout(timer.current)
  timer.current = window.setTimeout(() => {
    set(undefined)
    timer.current = undefined
  }, delayMs)
}

/** Whether the UI language is Chinese (labels follow the browser). */
function isChineseUi() {
  return typeof navigator !== 'undefined' && /^zh\b/u.test(navigator.language ?? '')
}

/** Labels for the current UI language. */
function labels() {
  return isChineseUi()
    ? {
        button: '同步设置',
        importNow: '立即导入',
        auto: '自动导入',
        status: '查看镜像状态',
        busyImport: '导入中…',
        busyToggle: '保存中…',
        busyStatus: '查询中…',
        on: '开',
        off: '关',
        noSession: '当前没有会话',
        commandMissing: '命令未找到',
        done: '完成',
      }
    : {
        button: 'Sync',
        importNow: 'Import now',
        auto: 'Auto import',
        status: 'Mirror status',
        busyImport: 'Importing…',
        busyToggle: 'Saving…',
        busyStatus: 'Querying…',
        on: 'on',
        off: 'off',
        noSession: 'no active session',
        commandMissing: 'command not found',
        done: 'done',
      }
}

/** The Sync settings dropdown: pure presentation, actions injected via props. */
function SyncMenu({ runCommand }) {
  const t = labels()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null) // null | 'import' | 'toggle' | 'status'
  const [result, setResult] = useState(undefined) // { ok, text } | undefined
  const [auto, setAuto] = useState(null) // null | true | false
  const [hover, setHover] = useState(null)
  const timer = useRef(undefined)
  const rootRef = useRef(undefined)

  // refresh the persisted auto-import state on mount and on every open
  useEffect(() => {
    if (!open) return
    let alive = true
    void runCommand('/auto-import').then((outcome) => {
      if (!alive) return
      if (outcome.ok) {
        const m = /autoImport=(on|off)/u.exec(outcome.text ?? '')
        if (m) setAuto(m[1] === 'on')
      }
    })
    return () => { alive = false }
  }, [open, runCommand])

  // close on outside click / Escape
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

  const run = async (kind, line, label) => {
    if (busy !== null) return
    setBusy(kind)
    setResult(undefined)
    try {
      const outcome = await runCommand(line)
      setResult(outcome)
      scheduleClear(timer, () => setResult(undefined), RESULT_HIDE_MS)
      if (kind === 'toggle' && outcome.ok) {
        const m = /autoImport=(on|off)/u.exec(outcome.text ?? '')
        if (m) setAuto(m[1] === 'on')
      }
    } catch (error) {
      setResult({ ok: false, text: `${label}: ${error instanceof Error ? error.message : String(error)}` })
      scheduleClear(timer, () => setResult(undefined), RESULT_HIDE_MS)
    } finally {
      setBusy(null)
    }
  }

  const busyLabel = busy === 'import' ? t.busyImport : busy === 'toggle' ? t.busyToggle : busy === 'status' ? t.busyStatus : null

  return h('span', { ref: rootRef, style: styles.wrapper },
    h('button', {
      type: 'button',
      title: t.button,
      style: Object.assign({}, styles.button, busy !== null ? styles.busy : {}),
      onClick: () => setOpen(!open),
      disabled: busy !== null,
    }, t.button, ' ', open ? '▴' : '▾'),
    open
      ? h('div', { style: styles.menu },
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.item, hover === 'import' ? styles.itemHover : {}),
            onMouseEnter: () => setHover('import'),
            onMouseLeave: () => setHover(null),
            onClick: () => { setOpen(false); void run('import', '/import-all', t.importNow) },
          }, t.importNow),
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.item, hover === 'auto' ? styles.itemHover : {}),
            onMouseEnter: () => setHover('auto'),
            onMouseLeave: () => setHover(null),
            onClick: () => void run('toggle', auto === true ? '/auto-import off' : '/auto-import on', t.auto),
          },
            t.auto,
            h('span', {
              style: Object.assign({}, styles.badge, auto === true ? styles.badgeOn : {}),
            }, auto === null ? '…' : auto === true ? t.on : t.off),
          ),
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.item, hover === 'status' ? styles.itemHover : {}),
            onMouseEnter: () => setHover('status'),
            onMouseLeave: () => setHover(null),
            onClick: () => { setOpen(false); void run('status', '/mcp-status', t.status) },
          }, t.status),
        )
      : null,
    busyLabel !== null
      ? h('span', { style: styles.result }, busyLabel)
      : result !== undefined
        ? h('span', { style: Object.assign({}, styles.result, result.ok ? styles.ok : styles.error) }, result.text)
        : null,
  )
}

/** This client plugin's entry name. */
exports.name = 'dsh-codex-sync'
/** Slot registry + remote command execution surfaces. */
exports.inject = ['slots', 'remote', 'remote.commands']

/**
 * Mount the Sync settings dropdown into the composer tool row.
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
            return { ok: false, text: isChineseUi() ? '当前没有会话' : 'no active session' }
          }
          const result = await ctx.remote.commands.execute(sessionId, line)
          if (!result.ok) {
            return { ok: false, text: `${result.error.code}: ${result.error.message}` }
          }
          if (result.value === undefined) {
            return { ok: true, text: isChineseUi() ? '命令未找到' : 'command not found' }
          }
          const outcome = result.value.result
          return { ok: outcome.kind === 'success', text: outcome.text ?? (isChineseUi() ? '完成' : 'done') }
        },
      }),
    },
    SyncMenu,
  ))
}

return module.exports; } });
