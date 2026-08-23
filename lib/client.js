/**
 * dsh-codex-sync client bundle (browser side).
 *
 * Registers the modern "Sync settings" panel in the sidebar footer action area
 * (`sidebar.footer.action` slot). One button toggles a menu with:
 *
 *   Actions (操作)
 *     - Import from Codex (从 Codex 导入)
 *     - Export to Codex (导出到 Codex)
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
let ReactDOM
try { ReactDOM = require('react-dom') } catch {}
if (!ReactDOM && typeof window !== 'undefined') ReactDOM = window.ReactDOM
const h = React.createElement
const { useEffect, useRef, useState, useCallback } = React

/* --- Inject Pure CSS for perfectly responsive hover transitions --- */
function ensureStylesInjected() {
  if (typeof document === 'undefined') return
  const id = 'dsh-codex-sync-style-v1'
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = `
    .codex-sync-card {
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease !important;
    }
    .codex-sync-card:hover {
      background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)) !important;
      border-color: var(--dsw-alias-border-l2, rgba(127,127,127,0.28)) !important;
    }
    .codex-sync-card:active {
      transform: scale(0.98);
    }
    .codex-sync-row {
      transition: background 0.15s ease !important;
    }
    .codex-sync-row:hover {
      background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)) !important;
    }
    .codex-sync-trigger-wide {
      transition: all 0.15s ease !important;
    }
    .codex-sync-trigger-wide:hover {
      background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14)) !important;
      color: var(--dsw-alias-label-primary) !important;
    }
    .codex-sync-trigger-rail {
      transition: all 0.15s ease !important;
    }
    .codex-sync-trigger-rail:hover {
      background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14)) !important;
      color: var(--dsw-alias-label-primary) !important;
    }
  `
  document.head.appendChild(style)
}

/* --- SVG Icons --- */
const svgIcon = (children, viewBox = "0 0 24 24", size = 13, style = {}) => h('svg', {
  width: size,
  height: size,
  viewBox,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '2',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  style: Object.assign({ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }, style)
}, children)

const Icons = {
  codex: (size = 16) => h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    fillRule: 'evenodd',
    style: { flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' },
  }, h('path', {
    clipRule: 'evenodd',
    d: 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z',
  })),
  sync: () => svgIcon([
    h('path', { key: 1, d: 'M21.5 2v6h-6' }),
    h('path', { key: 2, d: 'M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67' })
  ], '0 0 24 24', 12),
  import: () => svgIcon([
    h('path', { key: 1, d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
    h('polyline', { key: 2, points: '7 10 12 15 17 10' }),
    h('line', { key: 3, x1: '12', y1: '15', x2: '12', y2: '3' })
  ], '0 0 24 24', 13),
  export: () => svgIcon([
    h('path', { key: 1, d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
    h('polyline', { key: 2, points: '17 8 12 3 7 8' }),
    h('line', { key: 3, x1: '12', y1: '3', x2: '12', y2: '15' })
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
  search: () => svgIcon([
    h('circle', { key: 1, cx: '11', cy: '11', r: '7' }),
    h('line', { key: 2, x1: '21', y1: '21', x2: '16.2', y2: '16.2' })
  ], '0 0 24 24', 13),
  folder: () => svgIcon([
    h('path', { key: 1, d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' })
  ], '0 0 24 24', 13),
  folderOpen: () => svgIcon([
    h('path', { key: 1, d: 'm6 14 1.5-6.5A2 2 0 0 1 9.4 6H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2A2 2 0 0 0 12.1 6H19a2 2 0 0 1 2 2' })
  ], '0 0 24 24', 13),
  chat: () => svgIcon([
    h('path', { key: 1, d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' })
  ], '0 0 24 24', 12),
  chevronRight: () => svgIcon([
    h('polyline', { key: 1, points: '9 18 15 12 9 6' })
  ], '0 0 24 24', 11),
  chevronDown: () => svgIcon([
    h('polyline', { key: 1, points: '6 9 12 15 18 9' })
  ], '0 0 24 24', 11),
  checkCircle: () => svgIcon([
    h('path', { key: 1, d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }),
    h('polyline', { key: 2, points: '22 4 12 14.01 9 11.01' })
  ], '0 0 24 24', 28, { color: 'var(--dsw-alias-state-success-primary, #22c55e)' }),
  clear: () => svgIcon([
    h('line', { key: 1, x1: '18', y1: '6', x2: '6', y2: '18' }),
    h('line', { key: 2, x1: '6', y1: '6', x2: '18', y2: '18' })
  ], '0 0 24 24', 10),
}

/** Theme-adaptive styles: full integration with DSH `--dsw-alias-*` design system. */
const styles = {
  wrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
  },
  triggerBtn: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-text-secondary, currentColor))',
    cursor: 'pointer',
    padding: 0,
    transition: 'background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), color 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  triggerBtnHover: {
    background: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-surface-hover, rgba(127,127,127,0.12)))',
    color: 'var(--dsw-alias-label-primary, var(--dsw-text-primary, currentColor))',
  },
  triggerBtnActive: {
    background: 'var(--dsw-alias-interactive-bg-active, var(--dsw-surface-active, rgba(127,127,127,0.18)))',
    color: 'var(--dsw-alias-label-primary, var(--dsw-text-primary, currentColor))',
  },
  busy: { opacity: 0.6, cursor: 'progress' },
  menu: {
    position: 'absolute',
    left: '0',
    bottom: 'calc(100% + 8px)',
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
    background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
  },
  dialog: {
    width: 'min(640px, 95vw)',
    maxHeight: 'min(78vh, 680px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '14px',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-surface, #fff))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22))',
    boxShadow: '0 24px 64px -12px var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4)), 0 4px 16px rgba(0,0,0,0.1)',
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
  },
  settingsDialog: {
    width: 'min(500px, 95vw)',
    maxHeight: 'min(85vh, 720px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '14px',
    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-surface, #fff))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.22))',
    boxShadow: '0 24px 64px -12px var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4)), 0 4px 16px rgba(0,0,0,0.1)',
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
  },
  dialogHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 14px',
    background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.03))',
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14))',
  },
  searchWrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flex: '1 1 auto',
    minWidth: 0,
  },
  searchIcon: {
    position: 'absolute',
    left: '9px',
    color: 'var(--dsw-alias-label-tertiary)',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
  },
  search: {
    width: '100%',
    height: '30px',
    padding: '0 26px 0 28px',
    borderRadius: '7px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    outline: 'none',
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  searchClear: {
    position: 'absolute',
    right: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: 0,
    border: 'none',
    borderRadius: '50%',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
  },
  filterBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    height: '30px',
    padding: '0 10px',
    borderRadius: '7px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'all 0.15s ease',
  },
  dialogBody: {
    flex: '1 1 auto',
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '8px 12px 12px',
    boxSizing: 'border-box',
    width: '100%',
  },
  dialogFoot: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '11px 14px',
    background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.03))',
    borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14))',
    boxSizing: 'border-box',
  },
  ghostBtn: {
    height: '30px',
    padding: '0 14px',
    borderRadius: '7px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background 0.15s ease, border-color 0.15s ease',
  },
  primaryBtn: {
    height: '30px',
    padding: '0 16px',
    borderRadius: '7px',
    border: 'none',
    background: 'var(--dsw-alias-button-info-fill, var(--dsw-static-deepseek-500, #4176e6))',
    boxShadow: '0 2px 8px var(--dsw-alias-bg-mask-1, rgba(65,118,230,0.28))',
    color: '#fff',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'transform 0.1s ease, opacity 0.15s ease, box-shadow 0.15s ease',
  },
  treeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    padding: '6px 8px',
    margin: '1px 0',
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: 'inherit',
    fontSize: '12px',
    textAlign: 'left',
    transition: 'background 0.12s ease',
    overflow: 'hidden',
  },
  muted: { opacity: 0.5 },
  tagsContainer: {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    paddingLeft: '10px',
  },
  projectCount: {
    fontSize: '10px',
    fontWeight: '600',
    padding: '1px 6px',
    borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.12))',
    color: 'var(--dsw-alias-label-tertiary)',
    marginLeft: 'auto',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  updatedTag: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: '10px',
    fontWeight: '600',
    padding: '1px 6px',
    borderRadius: '4px',
    background: 'rgba(34,197,94,0.14)',
    border: '1px solid rgba(34,197,94,0.28)',
    color: 'var(--dsw-alias-state-success-primary, #22c55e)',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  importedTag: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '4px',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
    color: 'var(--dsw-alias-label-tertiary)',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  modalCloseBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary, var(--dsw-text-tertiary, #999))',
    cursor: 'pointer',
    transition: 'background 0.15s ease, color 0.15s ease',
  },
  modalSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  modalSectionTitle: {
    color: 'var(--dsw-alias-label-tertiary, var(--dsw-text-tertiary, #8e8e93))',
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    paddingLeft: '2px',
  },
  actionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '8px',
  },
  actionCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))',
    color: 'var(--dsw-alias-label-primary, var(--dsw-text-primary, currentColor))',
    fontSize: '12px',
    fontWeight: '500',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background 0.12s ease, border-color 0.12s ease, transform 0.1s ease',
  },
  actionCardHover: {
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
    borderColor: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
  },
  actionCardIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-text-secondary, #888))',
    flexShrink: 0,
  },
  actionCardLabel: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  settingsGroup: {
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))',
    overflow: 'visible',
    position: 'relative',
  },
  settingRow: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '9px 12px',
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'background 0.12s ease',
  },
  settingRowBorder: {
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.10))',
  },
  settingRowHover: {
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
  },
  settingName: {
    fontSize: '12px',
    fontWeight: '400',
    color: 'var(--dsw-alias-label-primary, var(--dsw-text-primary, currentColor))',
  },
  modalTooltip: {
    position: 'absolute',
    left: '8px',
    right: '8px',
    top: 'calc(100% + 2px)',
    zIndex: 1000,
    padding: '8px 12px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-3, var(--dsw-surface, #252526))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
    boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
    color: 'var(--dsw-alias-label-primary, #ffffff)',
    fontSize: '11px',
    lineHeight: '1.45',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    pointerEvents: 'none',
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
  exportNow: {
    zh: '把当前 DSH 会话写成新的 Codex rollout（新 uuid，只导正文）。',
    en: 'Write current DSH chats as new Codex rollouts (new uuid, text only).',
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
    zh: '自动镜像 ~/.codex/config.toml 的 [mcp_servers.*] 到 dsh，并监听文件实时增删改。开关立即生效，无需重启。',
    en: 'Auto-mirrors [mcp_servers.*] from ~/.codex/config.toml into dsh and watches the file live. Toggling applies immediately — no restart.',
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
        settingsModalTitle: 'Codex 同步设置',
        actions: '操作',
        importNow: '从 Codex 导入',
        exportNow: '导出到 Codex',
        status: '查看镜像状态',
        statusTitle: 'MCP 镜像状态',
        close: '关闭',
        switches: '功能开关',
        refresh: '刷新状态',
        language: '语言',
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
        pickerTitleExport: '导出 DSH 会话到 Codex',
        confirmExportTitle: '确认导出',
        confirmExportBody: (count) => `即将导出 ${count} 个会话。由于插件无法覆盖或追加原 Codex 对话，导出将创建全新的 Codex 会话副本；子代理会话将作为独立会话导出，无法与父会话合并。导出的对话重启 Codex 可见。`,
        confirmExportBtn: '确认导出',
        selectAll: '全选',
        search: '搜索项目或对话标题',
        hideSub: '过滤子代理',
        fromCodex: '来自 Codex',
        cancel: '取消',
        importN: '导入',
        exportN: '导出',
        exportedOk: '已写出 Codex 会话',
        exportHint: '导出完成。对话重启 Codex 可见。',
        loading: '正在读取…',
        empty: '没有可处理的会话',
        imported: '已导入',
        updated: '有更新',
        tagDshUpdated: 'DSH 已续聊',
        tagCodexUnchanged: 'Codex · 未更新',
        tagCodexSourceMissing: 'Codex · 源缺失',
        tagNotInCodex: 'Codex 无此项目',
        tagSubagent: '子代理',
        tipDshUpdated: '导出将创建新的 Codex 副本，不会覆盖原对话',
        tipNotInCodex: '该项目尚未在 Codex 中建立。请先在 Codex 中创建/打开该项目后再导出对话。',
        tipSubagent: '作为子代理展示仅用于归类组织；勾选后将作为独立 Codex 会话导出，不会与父会话合并',
        error: '无法读取目录。请完全退出并重新启动 dsh web（只刷新页面不够，后台插件不会更新）。',
        importedOk: '导入完成',
        reloadHint: '正在刷新页面，新对话会出现在会话列表里（不用重启 dsh）。点「稍后」可取消自动刷新。',
        reloadNow: '立即刷新',
        reloadLater: '稍后',
      }
    : {
        button: 'Sync',
        settingsModalTitle: 'Codex Sync Settings',
        actions: 'Actions',
        importNow: 'Import from Codex',
        exportNow: 'Export to Codex',
        status: 'Mirror status',
        statusTitle: 'MCP Mirror Status',
        close: 'Close',
        switches: 'Features',
        refresh: 'Refresh states',
        language: 'Language',
        langBadge: 'English',
        on: 'on',
        off: 'off',
        unknown: '?',
        noSession: 'no active session',
        commandMissing: 'command not found',
        done: 'Done',
        settingNames: {
          enableImport: 'Import commands',
          autoImport: 'Auto import',
          enableInstructions: 'Instructions',
          enableConfig: 'Config summary',
          enableSkills: 'Skills',
          mcpMirror: 'MCP mirror',
        },
        pickerTitle: 'Import Codex sessions',
        pickerTitleExport: 'Export DSH sessions to Codex',
        confirmExportTitle: 'Confirm export',
        confirmExportBody: (count) => `About to export ${count} session(s). Because the plugin cannot overwrite or append to original Codex threads, exporting will create new, independent Codex conversation copies; subagents will export separately and cannot merge into parent sessions. Exported conversations will be visible after restarting Codex.`,
        confirmExportBtn: 'Confirm export',
        selectAll: 'Select all',
        search: 'Search projects or titles',
        hideSub: 'Hide sub-agents',
        fromCodex: 'From Codex',
        cancel: 'Cancel',
        importN: 'Import',
        exportN: 'Export',
        exportedOk: 'Wrote Codex sessions',
        exportHint: 'Export complete. Conversations will be visible after restarting Codex.',
        loading: 'Reading sessions…',
        empty: 'Nothing to display',
        imported: 'imported',
        updated: 'updated',
        tagDshUpdated: 'Updated in DSH',
        tagCodexUnchanged: 'Codex · unchanged',
        tagCodexSourceMissing: 'Codex · source missing',
        tagNotInCodex: 'Not in Codex',
        tagSubagent: 'Sub-agent',
        tipDshUpdated: 'Export creates a new Codex copy and does not overwrite original',
        tipNotInCodex: 'This workspace is not recognized in Codex. Open or create this project in Codex first before exporting chats.',
        tipSubagent: 'Shown nested for organization; selected child exports separately, not merged.',
        error: 'Could not load catalog. Fully quit and restart dsh web (a page refresh does not reload the host plugin).',
        importedOk: 'Import finished',
        reloadHint: 'Reloading so new chats show up in the session list (no dsh restart). Tap Later to cancel.',
        reloadNow: 'Reload now',
        reloadLater: 'Later',
      }
}

/** Success marker: set ONLY after settings actually populated badges. */
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

function isNodeSelectable(n, isExport) {
  if (isExport) {
    if (n.isCodexWorkspace === false) return false
    if (n.alreadyCodex || n.fromCodex) {
      return n.dshUpdated === true
    }
    return true
  }
  return !n.alreadyCodex && (!n.imported || n.stale)
}

function collectSelectable(projects, isExport = false) {
  const ids = []
  for (const p of projects || []) {
    walkSessions(p.sessions, (n) => {
      if (isNodeSelectable(n, isExport)) ids.push(n.id)
    })
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
  const isChecked = state === 'checked'
  const isPartial = state === 'partial'
  const filled = isChecked || isPartial
  const bg = !filled ? 'transparent' : (disabled
    ? 'var(--dsw-alias-border-l2, rgba(127,127,127,0.24))'
    : 'var(--dsw-alias-state-success-primary, #22c55e)')
  const border = filled && !disabled
    ? '1px solid var(--dsw-alias-state-success-primary, #22c55e)'
    : '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.36))'
  const iconColor = disabled ? 'var(--dsw-alias-label-tertiary, #888)' : '#ffffff'

  return h('span', {
    style: {
      width: '15px',
      height: '15px',
      flexShrink: 0,
      borderRadius: '4px',
      border,
      background: bg,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'all 0.12s ease',
      boxShadow: filled && !disabled ? '0 1px 3px var(--dsw-alias-bg-mask-1, rgba(34,197,94,0.25))' : 'none',
    },
  },
    isChecked ? h('svg', {
      width: 10,
      height: 10,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: iconColor,
      strokeWidth: '2.4',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }, h('polyline', { points: '3.5 8.5 6.5 11.5 12.5 4.5' }))
    : isPartial ? h('svg', {
      width: 10,
      height: 10,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: iconColor,
      strokeWidth: '2.6',
      strokeLinecap: 'round',
    }, h('line', { x1: '3.5', y1: '8', x2: '12.5', y2: '8' }))
    : null
  )
}

function ImportPicker({ lang, runCommand, onClose, mode = 'import' }) {
  const t = labels(lang)
  const isExport = mode === 'export'
  const [hideSub, setHideSub] = useState(true)
  const [showCodex, setShowCodex] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState({})
  const [expanded, setExpanded] = useState({})
  const [busy, setBusy] = useState(false)
  const [confirmingExport, setConfirmingExport] = useState(false)
  const [done, setDone] = useState(false)
  const reloadTimer = useRef(null)

  const load = async (includeSubagents, includeCodex) => {
    setError(null)
    try {
      const url = isExport
        ? `/dsh-codex-sync/export-catalog?includeCodex=${includeCodex ? '1' : '0'}&includeSubagents=${includeSubagents ? '1' : '0'}`
        : `/dsh-codex-sync/catalog?includeSubagents=${includeSubagents ? '1' : '0'}`
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !Array.isArray(data.projects)) {
        throw new Error((data && data.error) || String(res.status))
      }
      setCatalog(data)
      const validSelectable = new Set(collectSelectable(data.projects, isExport))
      setSelected((prev) => {
        const next = {}
        for (const id of Object.keys(prev)) {
          if (prev[id] && validSelectable.has(id)) {
            next[id] = true
          }
        }
        return next
      })
    } catch (e) {
      setError(t.error)
    }
  }

  useEffect(() => { void load(!hideSub, showCodex) }, [hideSub, showCodex, isExport])

  const projects = filterCatalog(catalog?.projects, query)
  const selectable = collectSelectable(projects, isExport)
  const selectedCount = selectable.filter((id) => selected[id]).length
  const allState = triState(selectedCount, selectable.length)

  const toggleTree = (nodes, on) => {
    setSelected((prev) => {
      const next = Object.assign({}, prev)
      walkSessions(nodes, (n) => {
        if (isNodeSelectable(n, isExport)) next[n.id] = on
      })
      return next
    })
  }
  const toggleId = (id, on) => {
    setSelected((prev) => Object.assign({}, prev, { [id]: on }))
  }

  const executeExport = async () => {
    const ids = selectable.filter((id) => selected[id])
    if (ids.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/dsh-codex-sync/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, dryRun: false }),
        credentials: 'same-origin',
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || String(res.status))
      }
      setBusy(false)
      setConfirmingExport(false)
      setDone(true)
    } catch (e) {
      if (typeof runCommand === 'function') {
        const result = await runCommand('/export-codex --ids ' + ids.join(','))
        setBusy(false)
        setConfirmingExport(false)
        if (result && result.ok === false) {
          setError(result.text || t.error)
          return
        }
        setDone(true)
      } else {
        setBusy(false)
        setConfirmingExport(false)
        setError(e?.message || t.error)
      }
    }
  }

  const executeImport = async (ids) => {
    if (ids.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/dsh-codex-sync/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, includeSubagents: !hideSub }),
        credentials: 'same-origin',
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || String(res.status))
      }
      setBusy(false)
      setDone(true)
      reloadTimer.current = setTimeout(() => { window.location.reload() }, 2500)
    } catch (e) {
      if (typeof runCommand === 'function') {
        const result = await runCommand('/import-codex --ids ' + ids.join(',') + (hideSub ? '' : ' --include-subagents'))
        setBusy(false)
        if (result && result.ok === false) {
          setError(result.text || t.error)
          return
        }
        setDone(true)
        reloadTimer.current = setTimeout(() => { window.location.reload() }, 2500)
      } else {
        setBusy(false)
        setError(e?.message || t.error)
      }
    }
  }

  const onConfirmClick = () => {
    const ids = selectable.filter((id) => selected[id])
    if (ids.length === 0 || busy) return
    if (isExport) {
      setConfirmingExport(true)
      return
    }
    void executeImport(ids)
  }

  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
  }, [])

  const renderNodes = (nodes, depth) => nodes.map((n) => {
    const hasKids = (n.children || []).length > 0
    const open = expanded[n.id] === true
    const selfSelectable = isNodeSelectable(n, isExport)
    const kidSelectable = []
    walkSessions(n.children, (c) => {
      if (isNodeSelectable(c, isExport)) kidSelectable.push(c.id)
    })
    const totalSelectable = (selfSelectable ? 1 : 0) + kidSelectable.length
    const selfOn = selfSelectable && !!selected[n.id]
    const kidOn = kidSelectable.filter((id) => selected[id]).length
    const totalOn = (selfOn ? 1 : 0) + kidOn

    const locked = !selfSelectable
    let boxState
    if (totalSelectable === 0) {
      boxState = (!isExport && n.imported && !n.stale) ? 'checked' : 'empty'
    } else {
      boxState = triState(totalOn, totalSelectable)
    }
    const boxDisabled = totalSelectable === 0

    const isCodexOrigin = n.alreadyCodex || n.fromCodex
    const tags = []
    if (isExport) {
      if (isCodexOrigin) {
        if (n.dshUpdated) {
          tags.push(h('span', { key: 'status', style: styles.updatedTag, title: t.tipDshUpdated }, t.tagDshUpdated))
        } else if (n.sourceMissing) {
          tags.push(h('span', { key: 'status', style: styles.importedTag, title: t.tagCodexSourceMissing }, t.tagCodexSourceMissing))
        } else {
          tags.push(h('span', { key: 'status', style: styles.importedTag, title: t.tagCodexUnchanged }, t.tagCodexUnchanged))
        }
      }
      if (n.isSubagent) {
        tags.push(h('span', { key: 'sub', style: styles.importedTag, title: t.tipSubagent }, t.tagSubagent))
      }
    } else {
      if (n.alreadyCodex) {
        tags.push(h('span', { key: 'status', style: styles.importedTag }, 'Codex'))
      } else if (n.stale) {
        tags.push(h('span', { key: 'status', style: styles.updatedTag }, t.updated))
      } else if (n.imported) {
        tags.push(h('span', { key: 'status', style: styles.importedTag }, t.imported))
      }
      if (n.isSubagent) {
        tags.push(h('span', { key: 'sub', style: styles.importedTag, title: t.tagSubagent }, t.tagSubagent))
      }
    }

    const rowTooltip = (isExport && isCodexOrigin && n.dshUpdated)
      ? `${n.title} — ${t.tipDshUpdated}`
      : (isExport && n.isSubagent)
        ? `${n.title} — ${t.tipSubagent}`
        : n.title

    return h('div', { key: n.id, style: { width: '100%', maxWidth: '100%', boxSizing: 'border-box' } },
      h('div', {
        style: Object.assign({}, styles.treeRow, locked ? styles.muted : {}, { paddingLeft: 8 + depth * 16 }),
      },
        h('button', {
          type: 'button',
          style: { border: 'none', background: 'transparent', cursor: hasKids ? 'pointer' : 'default', color: 'var(--dsw-alias-label-tertiary)', width: 14, height: 14, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
          onClick: () => hasKids && setExpanded((p) => Object.assign({}, p, { [n.id]: !open })),
        }, hasKids ? (open ? Icons.chevronDown() : Icons.chevronRight()) : null),
        h('button', {
          type: 'button',
          disabled: boxDisabled,
          style: { border: 'none', background: 'transparent', padding: 0, cursor: boxDisabled ? 'default' : 'pointer', display: 'inline-flex', flexShrink: 0 },
          onClick: () => {
            if (boxDisabled) return
            const on = boxState !== 'checked'
            if (selfSelectable) toggleId(n.id, on)
            toggleTree(n.children, on)
          },
        }, h(TriBox, { state: boxState, disabled: boxDisabled })),
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', display: 'inline-flex', alignItems: 'center', flexShrink: 0 } }, Icons.chat()),
        h('span', {
          style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: hasKids ? 'pointer' : 'default' },
          title: rowTooltip,
          onClick: () => hasKids && setExpanded((p) => Object.assign({}, p, { [n.id]: !open })),
        }, n.title),
        tags.length > 0 ? h('div', { style: styles.tagsContainer }, tags) : null,
      ),
      open && hasKids ? renderNodes(n.children, depth + 1) : null,
    )
  })

  const body = error
    ? h('div', { style: { padding: '24px 16px', color: 'var(--dsw-alias-state-error-primary)', textAlign: 'center', fontSize: '13px' } }, error)
    : catalog === null
      ? h('div', { style: { padding: '32px 16px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', fontSize: '13px' } }, t.loading)
      : projects.length === 0
        ? h('div', { style: { padding: '32px 16px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', fontSize: '13px' } }, t.empty)
        : projects.map((p) => {
          const ids = collectSelectable([p], isExport)
          const projectSelectedCount = ids.filter((id) => selected[id]).length
          const st = ids.length === 0
            ? ((p.sessions || []).length ? (!isExport ? 'checked' : 'empty') : 'empty')
            : triState(projectSelectedCount, ids.length)
          const projectDisabled = ids.length === 0
          const open = expanded['p:' + (p.cwd || p.label)] === true
          return h('div', { key: p.cwd || p.label },
            h('div', { style: styles.treeRow },
              h('button', {
                type: 'button',
                style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', width: 14, height: 14, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
                onClick: () => setExpanded((prev) => Object.assign({}, prev, { ['p:' + (p.cwd || p.label)]: !open })),
              }, open ? Icons.chevronDown() : Icons.chevronRight()),
              h('button', {
                type: 'button',
                disabled: projectDisabled,
                style: { border: 'none', background: 'transparent', padding: 0, cursor: projectDisabled ? 'default' : 'pointer', display: 'inline-flex' },
                onClick: () => {
                  if (projectDisabled) return
                  toggleTree(p.sessions, st !== 'checked')
                },
              }, h(TriBox, { state: st, disabled: projectDisabled })),
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)', display: 'inline-flex', alignItems: 'center' } },
                open ? Icons.folderOpen() : Icons.folder()
              ),
              h('span', {
                style: { fontWeight: 600, flex: '1 1 auto', minWidth: 0, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: p.cwd || '',
                onClick: () => setExpanded((prev) => Object.assign({}, prev, { ['p:' + (p.cwd || p.label)]: !open })),
              }, p.label),
              isExport && p.isCodexWorkspace === false ? h('span', { style: styles.importedTag, title: t.tipNotInCodex }, t.tagNotInCodex) : null,
              h('span', { style: styles.projectCount }, (p.sessions || []).length),
            ),
            open ? renderNodes(p.sessions, 1) : null,
          )
        })

  if (done) {
    return h('div', { style: styles.overlay },
      h('div', { style: Object.assign({}, styles.dialog, { maxHeight: 'none', width: 'min(400px, 90vw)', textAlign: 'center', padding: '20px' }) },
        h('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: '10px' } }, Icons.checkCircle()),
        h('div', { style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '8px' } }, isExport ? t.exportedOk : t.importedOk),
        h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.5', marginBottom: '18px' } }, isExport ? t.exportHint : t.reloadHint),
        h('div', { style: { display: 'flex', justifyContent: 'center', gap: '10px' } },
          isExport
            ? h('button', { type: 'button', style: styles.primaryBtn, onClick: onClose }, t.done)
            : [
              h('button', { key: 'later', type: 'button', style: styles.ghostBtn, onClick: () => {
                if (reloadTimer.current) clearTimeout(reloadTimer.current)
                onClose()
              } }, t.reloadLater),
              h('button', {
                key: 'now',
                type: 'button',
                style: styles.primaryBtn,
                onClick: () => { window.location.reload() },
              }, t.reloadNow),
            ],
        ),
      ),
    )
  }

  if (confirmingExport) {
    return h('div', {
      style: styles.overlay,
      onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) setConfirmingExport(false) },
    },
      h('div', {
        style: Object.assign({}, styles.dialog, { maxHeight: 'none', width: 'min(440px, 90vw)', padding: '20px' }),
        onKeyDown: (e) => { if (e.key === 'Escape' && !busy) setConfirmingExport(false) },
      },
        h('div', { style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '10px' } }, t.confirmExportTitle),
        h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.6', marginBottom: '18px' } },
          typeof t.confirmExportBody === 'function' ? t.confirmExportBody(selectedCount) : t.confirmExportBody
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
          h('button', {
            type: 'button',
            style: styles.ghostBtn,
            disabled: busy,
            onClick: () => setConfirmingExport(false),
          }, t.cancel),
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.primaryBtn, busy ? { opacity: 0.5, cursor: 'not-allowed', boxShadow: 'none' } : {}),
            disabled: busy,
            onClick: () => { void executeExport() },
          }, busy ? t.loading : t.confirmExportBtn),
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
          style: Object.assign({}, styles.filterBtn, { border: 'none', padding: '0 6px', background: 'transparent' }),
          onClick: () => {
            const on = allState !== 'checked'
            const next = Object.assign({}, selected)
            selectable.forEach((id) => { next[id] = on })
            setSelected(next)
          },
        }, h(TriBox, { state: allState }), h('span', { style: { marginLeft: '4px' } }, t.selectAll)),
        h('div', { style: styles.searchWrap },
          h('span', { style: styles.searchIcon }, Icons.search()),
          h('input', {
            style: styles.search,
            placeholder: t.search,
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          query.length > 0
            ? h('button', {
              type: 'button',
              style: styles.searchClear,
              title: 'Clear',
              onClick: () => setQuery(''),
            }, Icons.clear())
            : null,
        ),
        isExport ? h('button', {
          type: 'button',
          style: Object.assign({}, styles.filterBtn, showCodex ? { color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-border-l3)' } : {}),
          onClick: () => setShowCodex(!showCodex),
        },
          h('span', {
            style: {
              display: 'inline-block',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: showCodex ? 'var(--dsw-alias-state-success-primary, #22c55e)' : 'var(--dsw-alias-border-l3, #888)',
            }
          }),
          t.fromCodex,
        ) : null,
        h('button', {
          type: 'button',
          style: Object.assign({}, styles.filterBtn, hideSub ? { color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-border-l3)' } : {}),
          onClick: () => setHideSub(!hideSub),
        },
          h('span', {
            style: {
              display: 'inline-block',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: hideSub ? 'var(--dsw-alias-state-success-primary, #22c55e)' : 'var(--dsw-alias-border-l3, #888)',
            }
          }),
          t.hideSub,
        ),
      ),
      h('div', { style: styles.dialogBody }, body),
      h('div', { style: styles.dialogFoot },
        h('button', { type: 'button', style: styles.ghostBtn, onClick: onClose }, t.cancel),
        h('button', {
          type: 'button',
          style: Object.assign({}, styles.primaryBtn, (busy || selectedCount === 0) ? { opacity: 0.5, cursor: 'not-allowed', boxShadow: 'none' } : {}),
          disabled: busy || selectedCount === 0,
          onClick: onConfirmClick,
        }, (isExport ? t.exportN : t.importN) + ' ' + selectedCount),
      ),
    ),
  )
}

function StatusModal({ lang, onClose }) {
  const t = labels(lang)
  const [loading, setLoading] = useState(true)
  const [statusText, setStatusText] = useState('')
  const [copied, setCopied] = useState(false)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/dsh-codex-sync/mcp-status', { credentials: 'same-origin' })
      const data = await res.json().catch(() => null)
      if (res.ok && data && data.text) {
        setStatusText(data.text + (data.autoImport !== undefined ? `\nautoImport: ${data.autoImport ? 'on' : 'off'}` : ''))
      } else {
        setStatusText(lang === 'zh' ? 'MCP 镜像未启用或服务离线' : 'MCP mirror not active or service offline')
      }
    } catch {
      setStatusText(lang === 'zh' ? '无法获取 MCP 状态' : 'Failed to fetch MCP status')
    } finally {
      setLoading(false)
    }
  }, [lang])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const copyStatus = () => {
    if (!statusText) return
    try {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(statusText).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    } catch {}
  }

  return h('div', {
    style: styles.overlay,
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
  },
    h('div', {
      style: Object.assign({}, styles.dialog, { maxWidth: '540px', width: '90vw' }),
      onKeyDown: (e) => { if (e.key === 'Escape') onClose() },
    },
      h('div', { style: styles.dialogHead },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '14px', color: 'var(--dsw-alias-label-primary)' } },
          Icons.status(),
          lang === 'zh' ? 'MCP 镜像状态' : 'MCP Mirror Status'
        ),
        h('span', { style: styles.spacer }),
        h('button', {
          type: 'button',
          style: styles.modalCloseBtn,
          title: t.close,
          'aria-label': t.close,
          onClick: onClose,
        }, Icons.clear())
      ),
      h('div', { style: Object.assign({}, styles.dialogBody, { padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }) },
        loading
          ? h('div', { style: { padding: '32px 16px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', fontSize: '13px' } }, t.loading)
          : h('pre', {
            style: {
              margin: 0,
              padding: '14px',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16))',
              color: 'var(--dsw-alias-label-primary)',
              fontFamily: 'var(--dsw-font-mono, monospace)',
              fontSize: '12px',
              lineHeight: '1.6',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '380px',
              overflowY: 'auto',
            }
          }, statusText)
      ),
      h('div', { style: styles.dialogFoot },
        h('button', {
          type: 'button',
          style: styles.ghostBtn,
          onClick: copyStatus,
          disabled: loading || !statusText,
        }, copied ? (lang === 'zh' ? '已复制 ✓' : 'Copied ✓') : (lang === 'zh' ? '复制文本' : 'Copy Text')),
        h('button', {
          type: 'button',
          style: styles.ghostBtn,
          onClick: fetchStatus,
          disabled: loading,
        }, lang === 'zh' ? '重新检测' : 'Re-check'),
        h('button', {
          type: 'button',
          style: styles.primaryBtn,
          onClick: onClose,
        }, t.done || t.close)
      )
    )
  )
}

function renderSwitch(isOn, t) {
  const bg = isOn === true
    ? 'var(--dsw-alias-state-success-primary, var(--dsw-static-green-500, #22c55e))'
    : isOn === false
      ? 'var(--dsw-alias-border-l3, rgba(127,127,127,0.28))'
      : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.16))'
  return h('span', {
    style: Object.assign({}, styles.switchTrack, { backgroundColor: bg }),
    title: isOn === true ? t?.on : isOn === false ? t?.off : t?.unknown
  },
    h('span', {
      style: Object.assign({}, styles.switchThumb, {
        left: isOn === true ? '14px' : '2px',
        opacity: isOn === undefined ? 0.6 : 1,
      })
    })
  )
}

function SyncSettingsModal({ lang, setLang, settings, toggleSetting, onOpenImport, onOpenExport, onShowStatus, onRefresh, onClose }) {
  const t = labels(lang)
  const [tooltipId, setTooltipId] = useState(null)
  const [refreshState, setRefreshState] = useState(null) // null | 'loading' | 'done'

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const handleRefreshClick = async () => {
    if (refreshState === 'loading') return
    setRefreshState('loading')
    try {
      if (typeof onRefresh === 'function') {
        await onRefresh()
      }
      setRefreshState('done')
      setTimeout(() => setRefreshState(null), 1800)
    } catch {
      setRefreshState(null)
    }
  }

  return h('div', {
    style: styles.overlay,
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
  },
    h('div', {
      style: styles.settingsDialog,
      onKeyDown: (e) => { if (e.key === 'Escape') onClose() },
    },
      // Header: Title + Close button (×)
      h('div', { style: styles.dialogHead },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '14px', color: 'var(--dsw-alias-label-primary)' } },
          Icons.codex(16),
          t.settingsModalTitle || (lang === 'zh' ? 'Codex 同步设置' : 'Codex Sync Settings')
        ),
        h('span', { style: styles.spacer }),
        h('button', {
          type: 'button',
          style: styles.modalCloseBtn,
          title: t.close,
          'aria-label': t.close,
          onClick: onClose,
        }, Icons.clear())
      ),

      // Body: 3 Sections
      h('div', { style: Object.assign({}, styles.dialogBody, { padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '16px' }) },
        // Section 1: Actions (从 Codex 导入, 导出到 Codex, 查看镜像状态, 刷新状态)
        h('div', { style: styles.modalSection },
          h('div', { style: styles.modalSectionTitle }, t.actions),
          h('div', { style: styles.actionGrid },
            h('button', {
              type: 'button',
              className: 'codex-sync-card',
              style: styles.actionCard,
              onClick: onOpenImport,
            },
              h('span', { style: styles.actionCardIcon }, Icons.import()),
              h('span', { style: styles.actionCardLabel }, t.importNow)
            ),
            h('button', {
              type: 'button',
              className: 'codex-sync-card',
              style: styles.actionCard,
              onClick: onOpenExport,
            },
              h('span', { style: styles.actionCardIcon }, Icons.export()),
              h('span', { style: styles.actionCardLabel }, t.exportNow)
            ),
            h('button', {
              type: 'button',
              className: 'codex-sync-card',
              style: styles.actionCard,
              onClick: onShowStatus,
            },
              h('span', { style: styles.actionCardIcon }, Icons.status()),
              h('span', { style: styles.actionCardLabel }, t.status)
            ),
            h('button', {
              type: 'button',
              className: 'codex-sync-card',
              style: Object.assign({}, styles.actionCard, refreshState === 'done' ? { borderColor: 'rgba(34,197,94,0.4)', color: 'var(--dsw-alias-state-success-primary, #22c55e)' } : {}),
              onClick: handleRefreshClick,
            },
              h('span', { style: styles.actionCardIcon }, refreshState === 'done' ? Icons.checkCircle(14) : Icons.refresh()),
              h('span', { style: styles.actionCardLabel }, refreshState === 'done' ? (lang === 'zh' ? '已刷新 ✓' : 'Refreshed ✓') : (refreshState === 'loading' ? t.loading : t.refresh))
            )
          )
        ),

        // Section 2: Features (功能开关)
        h('div', { style: styles.modalSection },
          h('div', { style: styles.modalSectionTitle }, t.switches),
          h('div', { style: styles.settingsGroup },
            ...SETTING_KEYS.map((key, index) => {
              const info = SETTING_INFO[key]?.[lang]
              const isOn = settings[key]
              return h('div', {
                key,
                className: 'codex-sync-row',
                style: Object.assign(
                  {},
                  styles.settingRow,
                  index < SETTING_KEYS.length - 1 ? styles.settingRowBorder : {}
                ),
                onClick: () => toggleSetting(key),
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                  h('span', { style: styles.settingName }, t.settingNames[key]),
                  info ? h('span', {
                    style: styles.infoIconWrapper,
                    onMouseEnter: (e) => { e.stopPropagation(); setTooltipId(key) },
                    onMouseLeave: (e) => { e.stopPropagation(); setTooltipId(null) },
                    onClick: (e) => { e.stopPropagation(); e.preventDefault() },
                  }, Icons.info()) : null
                ),
                h('span', { style: styles.spacer }),
                renderSwitch(isOn, t),
                tooltipId === key && info ? h('div', { style: styles.modalTooltip }, info) : null
              )
            })
          )
        ),

        // Section 3: Language switcher
        h('div', { style: styles.modalSection },
          h('div', { style: styles.modalSectionTitle }, t.language),
          h('div', { style: styles.settingsGroup },
            h('div', {
              className: 'codex-sync-row',
              style: styles.settingRow,
              onClick: setLang,
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)', display: 'inline-flex' } }, Icons.globe()),
                h('span', { style: styles.settingName }, t.language)
              ),
              h('span', { style: styles.spacer }),
              h('span', { style: styles.tagPill }, t.langBadge)
            )
          )
        )
      ),

      // Footer with Close / Done button
      h('div', { style: styles.dialogFoot },
        h('button', {
          type: 'button',
          style: styles.primaryBtn,
          onClick: onClose,
        }, t.done || t.close)
      )
    )
  )
}

function SyncMenu({ runCommand, wide }) {
  const [lang, setLang] = useState(readLang)
  const t = labels(lang)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState('import')
  const [statusOpen, setStatusOpen] = useState(false)
  const [busy, setBusy] = useState(null)
  const [anchor, setAnchor] = useState(null)
  const [settings, setSettings] = useState(() => (
    Object.fromEntries(SETTING_KEYS.map((k) => [k, readBadge(k)]))
  ))

  useEffect(() => {
    ensureStylesInjected()
  }, [])

  const syncSettingsFromHost = async () => {
    try {
      const res = await fetch('/dsh-codex-sync/settings', { credentials: 'same-origin' })
      const data = await res.json().catch(() => null)
      if (res.ok && data && data.settings) {
        setSettings(data.settings)
        for (const [k, v] of Object.entries(data.settings)) {
          writeBadge(k, v)
        }
        writeSeeded()
        return true
      }
    } catch {}
    return false
  }

  const run = async (kind, line) => {
    if (busy !== null) return
    setBusy(kind)
    try {
      if (typeof runCommand === 'function') {
        const outcome = await runCommand(line)
        if (kind === 'seed' || kind === 'refresh' || kind === 'toggle') {
          applyParsed(outcome.text)
        }
      }
    } catch {
      /* command errors */
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
    void (async () => {
      const ok = await syncSettingsFromHost()
      if (!ok && !readSeeded()) void run('seed', '/codex-settings')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Position detection for Fig 1 (expanded header) & Fig 2 (collapsed rail below search)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const detect = () => {
      // 1. Check expanded state (sectionHeader has visible width > 80px)
      const sectionHeader = document.querySelector('[class*="sectionHeader"]')
      if (sectionHeader) {
        const rect = sectionHeader.getBoundingClientRect()
        if (rect.width > 80 && rect.height > 0) {
          const searchSlot = sectionHeader.querySelector('[class*="searchSlot"]')
          const headerActions = sectionHeader.querySelector('[class*="headerActions"]')
          const sectionLabel = sectionHeader.querySelector('[class*="sectionLabel"]')
          setAnchor({
            mode: 'wide',
            container: sectionHeader,
            before: searchSlot || headerActions || (sectionLabel ? sectionLabel.nextSibling : null),
          })
          return
        }
      }

      // 2. Check collapsed rail state: upper sidebar buttons (left < 75px, top < 400px)
      const upperRailButtons = Array.from(document.querySelectorAll('button')).filter((b) => {
        const r = b.getBoundingClientRect()
        return r.left >= 0 && r.left < 75 && r.top >= 0 && r.top < 400 && r.width > 0 && r.height > 0
      })

      if (upperRailButtons.length > 0) {
        let targetBtn = upperRailButtons.find((b) => {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase()
          const title = (b.getAttribute('title') || '').toLowerCase()
          return aria.includes('search') || aria.includes('搜索') || title.includes('search') || title.includes('搜索')
        }) || upperRailButtons[upperRailButtons.length - 1]

        let container = targetBtn.parentElement
        let before = targetBtn.nextSibling
        if (container && container.tagName === 'DIV' && container.parentElement) {
          const pRect = container.parentElement.getBoundingClientRect()
          if (pRect.width < 100) {
            before = container.nextSibling
            container = container.parentElement
          }
        }

        if (container) {
          setAnchor({
            mode: 'rail',
            container,
            before,
          })
          return
        }
      }

      setAnchor(null)
    }

    detect()
    const interval = setInterval(detect, 100)
    const observer = new MutationObserver(detect)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', detect)
    return () => {
      clearInterval(interval)
      observer.disconnect()
      window.removeEventListener('resize', detect)
    }
  }, [wide])

  const toggleModal = () => {
    if (busy !== null) return
    const next = !settingsOpen
    setSettingsOpen(next)
    if (next && !readSeeded()) {
      void (async () => {
        const ok = await syncSettingsFromHost()
        if (!ok) void run('seed', '/codex-settings')
      })()
    }
  }

  const toggleSetting = async (key) => {
    const next = !(settings[key] === true)
    setSettings((prev) => ({ ...prev, [key]: next }))
    writeBadge(key, next)
    try {
      const res = await fetch('/dsh-codex-sync/setting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: next }),
        credentials: 'same-origin',
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok) return
      throw new Error(data?.error || 'setting update failed')
    } catch {
      void run('toggle', `/codex-setting ${key} ${next ? 'on' : 'off'}`)
    }
  }

  const showStatus = () => {
    setSettingsOpen(false)
    setStatusOpen(true)
  }

  const refreshAll = async () => {
    const ok = await syncSettingsFromHost()
    if (!ok) void run('refresh', '/codex-settings')
  }

  const switchLang = () => {
    const next = lang === 'zh' ? 'en' : 'zh'
    setLang(next)
    writeLang(next)
  }

  const triggerButton = h('button', {
    type: 'button',
    title: t.button,
    'aria-label': t.button,
    'aria-expanded': settingsOpen,
    className: anchor?.mode === 'wide' ? 'codex-sync-trigger-wide' : 'codex-sync-trigger-rail',
    style: anchor?.mode === 'wide' ? {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      borderRadius: '50%',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      padding: 0,
      margin: '0 2px',
      flexShrink: 0,
    } : {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '36px',
      height: '36px',
      borderRadius: '50%',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, var(--dsw-text-secondary, currentColor))',
      cursor: 'pointer',
      padding: 0,
      margin: '4px auto',
      flexShrink: 0,
    },
    onClick: toggleModal,
    disabled: busy !== null,
  },
    Icons.codex(anchor?.mode === 'wide' ? 16 : 18)
  )

  const isPortaled = !!(anchor && anchor.container && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal)
  const canPortalBody = typeof document !== 'undefined' && document.body && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal

  const modals = h(React.Fragment || 'div', null,
    settingsOpen
      ? h(SyncSettingsModal, {
          lang,
          setLang: switchLang,
          settings,
          toggleSetting,
          onOpenImport: () => { setSettingsOpen(false); setPickerMode('import'); setPickerOpen(true) },
          onOpenExport: () => { setSettingsOpen(false); setPickerMode('export'); setPickerOpen(true) },
          onShowStatus: showStatus,
          onRefresh: refreshAll,
          onClose: () => setSettingsOpen(false),
        })
      : null,
    pickerOpen
      ? h(ImportPicker, {
          lang,
          runCommand,
          mode: pickerMode,
          onClose: () => {
            setPickerOpen(false)
            setSettingsOpen(true)
          }
        })
      : null,
    statusOpen
      ? h(StatusModal, {
          lang,
          onClose: () => {
            setStatusOpen(false)
            setSettingsOpen(true)
          }
        })
      : null,
  )

  return h('span', { style: isPortaled ? { display: 'none' } : styles.wrapper },
    isPortaled
      ? ReactDOM.createPortal(triggerButton, anchor.container)
      : (typeof document === 'undefined' ? triggerButton : null),
    canPortalBody
      ? ReactDOM.createPortal(modals, document.body)
      : modals,
  )
}

/** This client plugin's entry name. */
exports.name = 'dsh-codex-sync'
/** Slot registry surface. */
exports.inject = ['slots']

/**
 * Mount the Sync settings panel into the sidebar footer action area.
 * `slots.inject` waits for ui-sidebar to declare `sidebar.footer.action`
 * and auto-unmounts if the declaration disappears.
 */
exports.apply = function apply(ctx) {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'codex-sync',
    },
    SyncMenu,
  ))
}

return module.exports; } });
