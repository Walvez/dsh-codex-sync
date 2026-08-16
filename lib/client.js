/**
 * dsh-codex-sync client bundle (browser side).
 *
 * Registers a persistent "Sync" button in the composer tool row
 * (`conversation.input.left` slot, same slot the dsh-import-agents plugin
 * used). Clicking it runs `/import-all` (incremental, idempotent codex
 * session import) through `ctx.remote.commands.execute` and shows the
 * result inline. Hand-authored CJS bundle — no build step.
 *
 * Adapted from dsh-import-agents' SyncButton (MIT, (c) Chang-Tong /
 * dongzhangust): same slot registration shape and button component, with
 * labels and command routing matching dsh-codex-sync. See NOTICE.
 */
window.__ModuleLoader__.load({ id: "dsh-codex-sync", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

const React = require('react')
const h = React.createElement
const { useRef, useState } = React

/** Result toast auto-hide delay. */
const RESULT_HIDE_MS = 6000

/** Inline styles: reuse dsh global CSS variables (--dsw-*), literal fallbacks. */
const styles = {
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

/** Whether the UI language is Chinese (button labels follow the browser). */
function isChineseUi() {
  return typeof navigator !== 'undefined' && /^zh\b/u.test(navigator.language ?? '')
}

/** Labels for the current UI language. */
function labels() {
  return isChineseUi()
    ? {
        idle: '同步',
        busy: '同步中…',
        failed: '同步失败',
        title: '增量导入 codex 历史会话、补挂工作区（/import-all，幂等）',
      }
    : {
        idle: 'Sync',
        busy: 'Syncing…',
        failed: 'Sync failed',
        title: 'Incrementally import codex sessions and attach workspaces (/import-all, idempotent)',
      }
}

/** The Sync button: pure presentation, action injected via props.sync. */
function SyncButton({ sync, resultHideMs = RESULT_HIDE_MS }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(undefined)
  const timer = useRef(undefined)

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    setResult(undefined)
    try {
      const outcome = await sync()
      setResult(outcome)
      scheduleClear(timer, () => setResult(undefined), resultHideMs)
    } catch (error) {
      setResult({ ok: false, text: `${labels().failed}: ${error instanceof Error ? error.message : String(error)}` })
      scheduleClear(timer, () => setResult(undefined), resultHideMs)
    } finally {
      setBusy(false)
    }
  }

  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
    h('button', {
      type: 'button',
      title: labels().title,
      style: Object.assign({}, styles.button, busy ? styles.busy : {}),
      onClick: () => void onClick(),
      disabled: busy,
    }, busy ? labels().busy : labels().idle),
    result !== undefined
      ? h('span', { style: Object.assign({}, styles.result, result.ok ? styles.ok : styles.error) }, result.text)
      : null,
  )
}

/** This client plugin's entry name (also the slot registration id prefix). */
exports.name = 'dsh-codex-sync'
/** Slot registry + remote command execution surfaces. */
exports.inject = ['slots', 'remote', 'remote.commands']

/**
 * Mount the Sync button into the composer tool row.
 * `slots.inject` waits for ui-conversation to declare `conversation.input.left`
 * and auto-unmounts if the declaration disappears.
 */
exports.apply = function apply(ctx) {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      name: 'conversation.input.left',
      id: 'codex-sync-sync-button',
      inject: (sessionId) => ({
        sync: async () => {
          if (sessionId === undefined) {
            return { ok: false, text: labels().failed + ': ' + (isChineseUi() ? '当前没有会话' : 'no active session') }
          }
          const result = await ctx.remote.commands.execute(sessionId, '/import-all')
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
    SyncButton,
  ))
}

return module.exports; } });
