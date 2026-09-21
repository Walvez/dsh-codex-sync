/**
 * Session-format migration helper for imported (v0) sessions.
 *
 * DSH 0.9.0's `session-persistence` backend now *writes* only the current
 * (v3) format: `encodeCurrentHeader` throws
 *   "encodeCurrent requires Session format v3"
 * for a v0 header, so the importer can no longer hand `persistence.create`
 * a v0 header + v0 events. This module runs the imported artifact through the
 * same `@deepseek-ai/dsh-session-format` v0→v1→v2→v3 chain the harness uses on
 * read, producing a v3 header and v3 events (with the promoted system/message
 * head and the embedded assistant/message stream that v3 restore requires).
 *
 * The migration packages are resolved from the DSH app install (or DSH_CHECKOUT
 * / the profile node_modules), matching the resolver used by session-repair.
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Resolve the three adjacent migration packages from a resolvable base.
 * The running DSH app bundles them under its `Contents/Resources/app/node_modules`;
 * derive that from the executable path when possible, else fall back to the
 * well-known install path / DSH_CHECKOUT / the profile node_modules.
 */
function loadChain() {
  const candidates = []
  // 1. Derive from the running electron binary (…/DSH Desktop.app/Contents/MacOS/…)
  const execDir = process.execPath ? join(dirname(process.execPath), '..') : ''
  if (execDir) {
    candidates.push(join(execDir, 'Resources', 'app', 'node_modules'))
  }
  // 2. Standard macOS install + env/profile fallbacks.
  candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app/node_modules')
  candidates.push(process.env.DSH_CHECKOUT || '')
  candidates.push(join(homedir(), '.dsh', 'profiles', 'node_modules'))
  const bases = candidates.filter(Boolean)
  for (const base of bases) {
    const anchor = `${base}/@deepseek-ai/dsh/lib/index.js`
    let r
    try { r = createRequire(anchor) } catch { continue }
    try {
      const v01 = r('@deepseek-ai/dsh-session-format-v0-to-v1')
      const v12 = r('@deepseek-ai/dsh-session-format-v1-to-v2')
      const v23 = r('@deepseek-ai/dsh-session-format-v2-to-v3')
      if (v01 && v12 && v23) return { v01, v12, v23 }
    } catch { /* try next base */ }
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-session-format-* migration packages')
}

/**
 * Migrate a released v0 session header + event list to the current (v3) format.
 * The source input is not mutated; a fresh header/event list is returned.
 * @param {object} header - v0 header ({version:0, id, createdAt, cwd, …}).
 * @param {Array} events - canonical v0 event rows (each with `seq`).
 * @returns {{ header: object, events: Array }} the v3 header and v3 events.
 */
export function migrateToCurrent(header, events) {
  const { v01, v12, v23 } = loadChain()
  const stages = [
    { mig: v01.sessionFormatV0ToV1, from: 0 },
    { mig: v12.sessionFormatV1ToV2, from: 1 },
    { mig: v23.sessionFormatV2ToV3, from: 2 },
  ]
  // Derive a migrated v3 header by chaining `migrateHeader`.
  // The v0 logical header requires `delegationDepth`, which the importer's
  // minimal header does not carry; normalize it (default 0) so the v0->v1
  // `migrateHeader` does not throw "lacks required member delegationDepth".
  const normalized = {
    ...header,
    version: 0,
    isSeeded: false,
    delegationDepth: header.delegationDepth ?? 0,
  }
  let h = { ...normalized }
  for (const { mig } of stages) h = mig.migrateHeader(h)
  // Migrate the events stage by stage; each stage expects the SOURCE header of
  // its own `fromVersion`.
  let cur = events.map((e, i) => ({ ...e, seq: i }))
  for (const { mig, from } of stages) {
    const sourceHeader = { ...normalized, version: from }
    const stage = mig.createStage({ sourceHeader, sourceInheritedEventCount: 0 })
    const out = []
    for (const ev of cur) stage.transformEvent(ev, { emitEvent: (e) => out.push(e) })
    cur = out
  }
  return { header: h, events: cur }
}
