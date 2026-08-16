/**
 * dsh-codex-sync client bundle (browser side).
 *
 * Registers a "Sync settings" dropdown in the composer tool row
 * (`conversation.input.left` slot, same slot the dsh-import-agents plugin
 * used). The button toggles a small menu (chevron ▾/▴) with three items:
 *
 *   1. 立即导入 — runs /import-all (incremental, idempotent codex import)
 *   2. 自动导入 — toggles via /auto-import on|off (the result card is the
 *      feedback); the badge mirrors the last toggle in localStorage so
 *      opening the menu never executes a command and never adds a card
 *   3. 查看镜像状态 — runs /mcp-status (which also reports the
 *      authoritative autoImport value)
 *
 * All action feedback lives in the conversation as command cards; nothing
 * is rendered inline, so the composer row never shifts. (The platform
 * settings seam refuses third-party namespaces to the web client —
 * dsh-host-apiproxy allowlist — so a live settings read is unavailable.)
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
  /** Menu opens downward by default; flips upward when below-space is tight. */
  menu: {
    position: 'absolute',
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
  menuDown: { top: 'calc(100% + 4px)' },
  menuUp: { bottom: 'calc(100% + 4px)' },
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
        on: 'on',
        off: 'off',
        noSession: 'no active session',
        commandMissing: 'command not found',
        done: 'done',
      }
}

/** The Sync settings dropdown: pure presentation, actions injected via props. */
// localStorage key mirroring the host-side autoImport toggle. The platform
// settings seam refuses third-party namespaces to the web client, so the
// badge cannot read the live host value; it mirrors the last toggle this
// browser performed (initial: the config default, off).
const AUTO_STATE_KEY = 'codex-sync.autoImport'
function readAutoState() {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(AUTO_STATE_KEY) === 'on'
  } catch {
    return false
  }
}
function writeAutoState(on) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(AUTO_STATE_KEY, on ? 'on' : 'off')
  } catch { /* storage unavailable: badge just stays session-local */ }
}

function SyncMenu({ runCommand }) {
  const t = labels()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(null) // null | 'import' | 'toggle' | 'status'
  const [auto, setAuto] = useState(readAutoState) // true | false
  const [hover, setHover] = useState(null)
  const [up, setUp] = useState(false) // menu opens upward when below-space is tight
  const rootRef = useRef(undefined)

  // pick the menu direction: the composer sits at the bottom of the viewport,
  // so flip upward unless there is enough room below the button
  const toggle = () => {
    if (busy !== null) return
    const el = rootRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      setUp(spaceBelow < 132)
    }
    setOpen(!open)
  }

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

  // run a command: the conversation card IS the feedback (import result,
  // mirror status, toggle confirmation); the auto-import badge additionally
  // mirrors the parsed result so it stays current without extra commands
  const run = async (kind, line) => {
    if (busy !== null) return
    setBusy(kind)
    try {
      const outcome = await runCommand(line)
      if (kind === 'toggle' && outcome.ok) {
        const m = /autoImport=(on|off)/u.exec(outcome.text ?? '')
        if (m) {
          const on = m[1] === 'on'
          setAuto(on)
          writeAutoState(on)
        }
      }
    } catch {
      /* the card shows command failures; nothing inline to render */
    } finally {
      setBusy(null)
    }
  }

  return h('span', { ref: rootRef, style: styles.wrapper },
    h('button', {
      type: 'button',
      title: t.button,
      style: Object.assign({}, styles.button, busy !== null ? styles.busy : {}),
      onClick: toggle,
      disabled: busy !== null,
    }, t.button, ' ', open ? '▴' : '▾'),
    open
      ? h('div', { style: Object.assign({}, styles.menu, up ? styles.menuUp : styles.menuDown) },
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.item, hover === 'import' ? styles.itemHover : {}),
            onMouseEnter: () => setHover('import'),
            onMouseLeave: () => setHover(null),
            onClick: () => { setOpen(false); void run('import', '/import-all') },
          }, t.importNow),
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.item, hover === 'auto' ? styles.itemHover : {}),
            onMouseEnter: () => setHover('auto'),
            onMouseLeave: () => setHover(null),
            onClick: () => { setOpen(false); void run('toggle', auto ? '/auto-import off' : '/auto-import on') },
          },
            t.auto,
            h('span', {
              style: Object.assign({}, styles.badge, auto === true ? styles.badgeOn : {}),
            }, auto === true ? t.on : t.off),
          ),
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.item, hover === 'status' ? styles.itemHover : {}),
            onMouseEnter: () => setHover('status'),
            onMouseLeave: () => setHover(null),
            onClick: () => { setOpen(false); void run('status', '/mcp-status') },
          }, t.status),
        )
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
