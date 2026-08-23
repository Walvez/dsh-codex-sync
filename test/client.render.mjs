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
    inject(name, cb) { assert.equal(name, 'sidebar.footer.action'); cb() },
    register(def, component) { capturedDef = def; capturedComponent = component },
  }
  plugin.apply({
    slots,
  })
  assert.ok(capturedComponent, 'register must be called with a component')
  assert.equal(capturedDef.name, 'sidebar.footer.action')
  assert.equal(capturedDef.id, 'codex-sync')

  // SSR render the closed state: must produce the button without touching
  // document/window layout APIs (effects don't run in SSR)
  const React = require(join(reactDir, 'index.js'))
  const { renderToStaticMarkup } = require(join(reactDomDir, 'server.js'))
  const html = renderToStaticMarkup(React.createElement(capturedComponent, { wide: true }))
  assert.match(html, /Sync|同步设置/, 'button title must render')
  assert.match(html, /M8\.086\.457/, 'Codex SVG path must render')
  // closed menu must not render its items (the badge lives inside it;
  // settings sync happens in a client effect, which SSR does not run)
  assert.doesNotMatch(html, /从 Codex 导入/, 'modal must stay closed in the idle render')
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
