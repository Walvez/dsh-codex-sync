import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
export async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!await check()) { if (Date.now() > deadline) throw new Error('fixture condition timed out'); await delay(15) }
}
export async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-sync-contract-')))
  const disposers = []
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    // Verify canonical ownership immediately before removing a computed path.
    assert.equal(await realpath(root), root)
    assert.equal(dirname(root), await realpath(tmpdir()))
    assert.ok(basename(root).startsWith('codex-sync-contract-'))
    await rm(root, { recursive: true, force: true })
  })
  return { root, own: dispose => disposers.push(dispose) }
}
export function environment(t, patch) {
  const before = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]))
  Object.assign(process.env, patch)
  t.after(() => { for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  } })
}
