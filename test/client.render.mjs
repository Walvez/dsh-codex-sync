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
    throw new Error(`unexpected require: ${id}`)
  })
  assert.equal(typeof plugin.apply, 'function', 'factory must return the plugin')

  // apply the client plugin against a fake slots ctx and capture the component
  let capturedComponent
  let capturedInject
  const slots = {
    inject(name, cb) { assert.equal(name, 'conversation.input.left'); cb() },
    register(def, component) { capturedInject = def.inject; capturedComponent = component },
  }
  plugin.apply({
    slots,
    remote: { commands: {} },
  })
  assert.ok(capturedComponent, 'register must be called with a component')
  assert.equal(typeof capturedInject, 'function', 'slot inject must be a function')

  // SSR render the closed state: must produce the button without touching
  // document/window layout APIs (effects don't run in SSR)
  const React = require(join(reactDir, 'index.js'))
  const { renderToStaticMarkup } = require(join(reactDomDir, 'server.js'))
  const actions = capturedInject('session-1')
  assert.equal(typeof actions.runCommand, 'function')
  const html = renderToStaticMarkup(React.createElement(capturedComponent, { runCommand: actions.runCommand }))
  assert.match(html, /Sync|同步设置/, 'button label must render')
  assert.match(html, /▾/, 'closed chevron must render')
  // closed menu must not render its items (the badge lives inside it;
  // settings sync happens in a client effect, which SSR does not run)
  assert.doesNotMatch(html, /立即导入/, 'menu must stay closed in the idle render')
})
