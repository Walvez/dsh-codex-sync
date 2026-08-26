/**
 * Client-bundle render test: loads lib/client.js through a mocked
 * `window.__ModuleLoader__`, applies the plugin against a fake slots ctx,
 * and server-renders the SyncMenu component with the real React from the
 * dsh installation. Skips (not fails) when React is unavailable.
 *
 * Run: `node --test test/client.render.mjs`
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dshDep } from './_env.mjs'

const PROJECT = join(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

test('client bundle: loads, applies, renders SyncMenu without throwing', async (t) => {
  const reactDir = dshDep('react')
  const reactDomDir = dshDep('react-dom')
  if (!reactDir || !reactDomDir) {
    t.skip('react/react-dom not found in the dsh installation')
    return
  }

  const source = readFileSync(join(PROJECT, 'lib', 'client.js'), 'utf8')
  let loaded
  const windowMock = {
    __ModuleLoader__: {
      load: ({ factory }) => { loaded = factory },
    },
  }
  const moduleFn = new Function('window', 'require', source)
  moduleFn(windowMock, () => { throw new Error('bundle must not require at top level') })
  assert.ok(loaded, 'bundle must call __ModuleLoader__.load')

  // the factory signature is factory(require) → module.exports
  const plugin = loaded((id) => {
    if (id === 'react') return require(join(reactDir, 'index.js'))
    if (id === 'react-dom') return require(join(reactDomDir, 'index.js'))
    throw new Error(`unexpected require: ${id}`)
  })
  assert.equal(typeof plugin.apply, 'function', 'factory must return the plugin')

  // apply the client plugin against a fake slots ctx and capture the component
  let capturedComponent
  let capturedDef
  const slots = {
    inject(name, cb) { assert.equal(name, 'shell.overlay'); cb() },
    register(def, component) { capturedDef = def; capturedComponent = component },
  }
  plugin.apply({
    slots,
  })
  assert.ok(capturedComponent, 'register must be called with a component')
  assert.equal(capturedDef.name, 'shell.overlay')
  assert.equal(capturedDef.id, 'codex-sync')

  // SSR render the closed state: must produce the button without touching
  // document/window layout APIs (effects don't run in SSR)
  const React = require(join(reactDir, 'index.js'))
  const { renderToStaticMarkup } = require(join(reactDomDir, 'server.js'))
  // shell.overlay passes no props at mount
  const html = renderToStaticMarkup(React.createElement(capturedComponent))
  assert.match(html, /Sync|同步设置/, 'button title must render')
  assert.match(html, /M8\.086\.457/, 'Codex SVG path must render')
  assert.match(html, /data-codex-sync-trigger/, 'trigger attribute must be present')
  assert.match(html, /data-mode="rail"/, 'data-mode attribute must default to rail when unpositioned')
  assert.match(html, /display:\s*none/, 'initial position must be hidden in SSR to prevent fixed 0,0 frame flash')
  // closed menu must not render its items (the badge lives inside it;
  // settings sync happens in a client effect, which SSR does not run)
  assert.doesNotMatch(html, /从 Codex 导入/, 'modal must stay closed in the idle render')
})

test('client bundle: settings modal renders open without throwing (regression)', () => {
  const source = readFileSync(join(PROJECT, 'lib', 'client.js'), 'utf8')
  // Inject a test export just before the factory's final return so the closure
  // hands us the internal SyncSettingsModal component.
  const hook = 'module.exports.__cxTest = { SyncSettingsModal }; '
  const patched = source.replace(
    'return module.exports; } });',
    hook + 'return module.exports; } });'
  )
  assert.notEqual(patched, source, 'tail hook must be injectable')

  let loaded
  const windowMock = { __ModuleLoader__: { load: ({ factory }) => { loaded = factory } } }
  const req = (id) => {
    const reactDir2 = dshDep('react')
    const reactDomDir2 = dshDep('react-dom')
    if (!reactDir2 || !reactDomDir2) throw new Error('react not installed')
    if (id === 'react') return require(join(reactDir2, 'index.js'))
    if (id === 'react-dom') return require(join(reactDomDir2, 'index.js'))
    throw new Error(`unexpected require: ${id}`)
  }
  new Function('window', 'require', patched)(windowMock, req)
  // Invoke the captured factory to obtain the exports (with __cxTest attached).
  const pluginExports = loaded(req)
  assert.ok(pluginExports && pluginExports.__cxTest, 'factory must expose __cxTest hook')
  const React = require(join(dshDep('react'), 'index.js'))
  const { renderToStaticMarkup } = require(join(dshDep('react-dom'), 'server.js'))

  const noop = () => {}
  const item = { on: true, override: null }
  const group = { default: true, items: { pdf: item } }
  const html = renderToStaticMarkup(React.createElement(pluginExports.__cxTest.SyncSettingsModal, {
    lang: 'zh',
    setLang: noop,
    settings: { enableImport: true, autoImport: false, enableInstructions: false, enableConfig: true, enableSkills: true, mcpMirror: true },
    toggleSetting: noop,
    itemsData: {
      skills: group, mcps: group, skill: group, mcp: group,
      hardDenyMcp: ['dsh-plugins'],
      mirrorStatus: null,
    },
    itemsLoading: false,
    onToggleItem: noop,
    onSetAll: noop,
    onOpenImport: noop,
    onOpenExport: noop,
    onShowStatus: noop,
    onOpenManage: noop,
    onOpenPath: noop,
    onRefresh: noop,
    onClose: noop,
  }))
  assert.match(html, /从 Codex 导入/, 'open modal must render action cards')
  assert.match(html, /技能管理/, 'manager buttons must render')
  assert.match(html, /功能开关/, 'switch section must render')
})

test('client bundle: overlay registration, data attributes, maid-atelier styling, and stable DOM detection', () => {
  const source = readFileSync(join(PROJECT, 'lib', 'client.js'), 'utf8')

  // Official additive shell.overlay slot registration
  assert.match(source, /ctx\.slots\.inject\(['"]shell\.overlay['"]/)
  assert.match(source, /name:\s*['"]shell\.overlay['"]/)
  assert.match(source, /id:\s*['"]codex-sync['"]/)
  assert.doesNotMatch(source, /sidebar\.footer\.action/)

  // Trigger attributes
  assert.match(source, /data-codex-sync-trigger/)
  assert.match(source, /data-mode/)

  // Stable DOM evidence and getBoundingClientRect
  assert.match(source, /data-sidebar-collapsed/)
  assert.match(source, /searchButton/)
  assert.match(source, /sectionHeader/)
  assert.match(source, /getBoundingClientRect/)

  // Expanded mode appends one normal 28px flex child to the live sectionHeader.
  assert.match(source, /ReactDOM\.createPortal\(triggerButton,\s*placement\.sectionHeader/)
  assert.match(source, /position:\s*'relative'/)
  assert.match(source, /width:\s*'28px'/)
  assert.match(source, /height:\s*'28px'/)
  assert.doesNotMatch(source, /searchSlot/, 'native search must not be a wide positioning target')

  // Collapsed mode is fixed at the final centered position in the 56px rail.
  assert.match(source, /const\s+RAIL_WIDTH\s*=\s*56/)
  assert.match(source, /position:\s*'fixed'/)
  assert.match(source, /left:\s*railLeft\s*\+\s*\(RAIL_WIDTH\s*-\s*size\)\s*\/\s*2/)
  assert.match(source, /top:\s*searchRect\.bottom\s*\+/)
  assert.doesNotMatch(source, /searchRect\.left/, 'collapsed left must never follow transitional search x coordinates')

  // Rail entry has a dedicated opacity-only keyframe; layout and transforms never animate.
  assert.doesNotMatch(source, /transition:\s*all/)
  assert.match(source, /transition:\s*background-color[^\n]*color[^\n]*border-color[^\n]*box-shadow/)
  assert.match(source, /animation:\s*codex-sync-rail-fade-in\s+160ms/)
  const railKeyframes = source.slice(
    source.indexOf('@keyframes codex-sync-rail-fade-in'),
    source.indexOf('.codex-sync-trigger-rail:hover')
  )
  assert.match(railKeyframes, /from\s*\{\s*opacity:\s*0/)
  assert.match(railKeyframes, /to\s*\{\s*opacity:\s*1/)
  assert.doesNotMatch(railKeyframes, /\b(?:transform|left|top|width|height)\s*:/)

  // Wide and rail modes use distinct React keys so rail entry remounts and restarts the fade.
  assert.match(source, /key:\s*isWide\s*\?\s*'codex-sync-wide-trigger'\s*:\s*'codex-sync-rail-trigger'/)

  // Scoped collapsed rail detection without global [class*=root][class*=rail]
  assert.doesNotMatch(source, /\[class\*="root"\]\[class\*="rail"\]/)
  assert.match(source, /findRailSearchButton/)

  // Placement is locked once per collapse; no polling or transition-driven resize/scroll tracking.
  assert.match(source, /lockedRailPlacement/)
  assert.match(source, /startedCollapse/)
  assert.doesNotMatch(source, /setInterval\(/)
  assert.doesNotMatch(source, /ResizeObserver/)
  assert.doesNotMatch(source, /addEventListener\(['"]scroll['"]/)

  // Maid-atelier gold and hover styling matching native workspace icon buttons
  assert.match(source, /body\[data-dsh-maid-atelier\]/)
  assert.match(source, /#dfbf7c/)
  assert.match(source, /#fff1ce/)
  assert.match(source, /38px/)
  assert.match(source, /rgba\(225,\s*191,\s*124,\s*0?\.68\)/)
  assert.match(source, /rgba\(87,\s*117,\s*190,\s*0?\.28\)/)
})

test('client bundle: contains modal structure, tag layout, and picker settings', () => {
  const source = readFileSync(join(PROJECT, 'lib', 'client.js'), 'utf8')

  // Modal titles & structure
  assert.match(source, /settingsModalTitle:\s*'Codex 同步设置'/)
  assert.match(source, /settingsModalTitle:\s*'Codex Sync Settings'/)
  assert.match(source, /function SyncSettingsModal\(/)
  assert.match(source, /settingsDialog/)
  assert.match(source, /modalCloseBtn/)
  assert.match(source, /modalSection/)
  assert.match(source, /actionGrid/)
  assert.match(source, /actionCard/)
  assert.match(source, /settingsGroup/)
  assert.match(source, /modalTooltip/)

  // Picker dialog width min(640px, 95vw)
  assert.match(source, /width:\s*'min\(640px,\s*95vw\)'/)

  // Tag wrapping container & no-wrap styles
  assert.match(source, /tagsContainer/)
  assert.match(source, /display:\s*'inline-flex'/)
  assert.match(source, /paddingLeft:\s*'10px'/)
  assert.match(source, /whiteSpace:\s*'nowrap'/)

  // Project count with marginLeft: auto and flexShrink: 0
  assert.match(source, /projectCount:\s*\{[^}]*marginLeft:\s*'auto'/)
  assert.match(source, /projectCount:\s*\{[^}]*flexShrink:\s*0/)
})

test('client bundle: contains export labels, URL parameters, and selectable logic', () => {
  const source = readFileSync(join(PROJECT, 'lib', 'client.js'), 'utf8')

  // Menu action labels (bilingual)
  assert.match(source, /importNow:\s*'从 Codex 导入'/)
  assert.match(source, /importNow:\s*'Import from Codex'/)

  // Localized tags & tooltips
  assert.match(source, /DSH 已续聊/)
  assert.match(source, /Updated in DSH/)
  assert.match(source, /Codex · 未更新/)
  assert.match(source, /Codex · unchanged/)
  assert.match(source, /Codex · 源缺失/)
  assert.match(source, /Codex · source missing/)
  assert.match(source, /来自 Codex/)
  assert.match(source, /From Codex/)
  assert.match(source, /子代理/)
  assert.match(source, /Sub-agent/)

  // Export confirmation modal state & text with "无法" and final sentence
  assert.match(source, /confirmingExport/)
  assert.match(source, /confirmExportTitle/)
  assert.match(source, /confirmExportBody/)
  assert.match(source, /confirmExportBtn/)
  assert.match(source, /由于插件无法覆盖或追加原 Codex 对话/)
  assert.match(source, /无法与父会话合并/)
  assert.match(source, /导出的对话重启 Codex 可见。/)
  assert.match(source, /Confirm export/)
  assert.match(source, /cannot merge into parent sessions/)
  assert.match(source, /Exported conversations will be visible after restarting Codex/)

  // Post-export success hint is concise without "绝不会/never overwrites"
  assert.match(source, /exportHint:\s*'导出完成。对话重启 Codex 可见。'/)
  assert.match(source, /exportHint:\s*'Export complete\. Conversations will be visible after restarting Codex\.'/)
  assert.doesNotMatch(source, /绝不会/)
  assert.doesNotMatch(source, /never overwrites/)

  // Empty default selection (does not auto-select all selectable IDs on catalog load)
  assert.doesNotMatch(source, /collectSelectable\([^)]+\)\.forEach\(\(id\) => \{ next\[id\] = true \}\)/)
  assert.match(source, /validSelectable\.has\(id\)/)

  // Export catalog URL with includeCodex & includeSubagents
  assert.match(source, /\/dsh-codex-sync\/export-catalog\?includeCodex=/)
  assert.match(source, /includeSubagents=/)

  // Selectable rule
  assert.match(source, /dshUpdated === true/)
})
