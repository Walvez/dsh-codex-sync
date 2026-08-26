#!/usr/bin/env node
// Test runner: locates the dsh checkout for @deepseek-ai/* resolution, then
// delegates to `node --test`. Order matters: host.smoke first (fast fail).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const suites = [
  'test/host.smoke.mjs',
  'test/client.render.mjs',
  'test/codex-reader.test.mjs',
  'test/import-service.test.mjs',
  'test/plugin-skill.test.mjs',
  'test/export-codex.test.mjs',
  'test/item-sync.test.mjs',
  'test/session-repair.test.mjs',
]

function findDshCheckout() {
  if (process.env.DSH_CHECKOUT && existsSync(process.env.DSH_CHECKOUT)) return process.env.DSH_CHECKOUT
  const candidates = [
    join(homedir(), '.local/share/dsh-npm/lib/node_modules/@deepseek-ai/dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
  ]
  return candidates.find((c) => existsSync(c))
}

const dsh = findDshCheckout()
const env = { ...process.env }
if (!dsh) {
  console.error('[run-tests] DSH_CHECKOUT not set and no global @deepseek-ai/dsh found; session-repair tests will be skipped')
} else {
  env.DSH_CHECKOUT = dsh
}

try {
  execFileSync('node', ['--test', ...suites], { stdio: 'inherit', env })
} catch (e) {
  process.exitCode = e.status ?? 1
}
