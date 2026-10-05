/**
 * Session-format migration helper for imported (v0) sessions.
 *
 * DSH's session-persistence backend *writes* only the CURRENT format:
 * `encodeCurrentHeader` throws
 *   "encodeCurrent requires Session format v4"
 * (DSH 0.10.x; v3 on 0.9.x) for anything older, so the importer can no longer
 * hand `persistence.create` a v0 header + v0 events. This module runs the
 * imported artifact through the real `@deepseek-ai/dsh-session-format`
 * v0→v1→…→current chain the harness uses on read, producing a header and
 * events in the installed current format (with the promoted system/message
 * head and the embedded assistant/message stream that current-format restore
 * requires).
 *
 * The chain is discovered DYNAMICALLY: the stages
 * `@deepseek-ai/dsh-session-format-vN-to-v{N+1}` are resolved consecutively
 * from one resolution base until the next stage is missing, and the longest
 * consecutive chain wins. The importer therefore follows the installed DSH
 * build (v3 on 0.9.x, v4 on 0.10.x, v5 on later builds, …) without a plugin
 * change for every format bump. All stages always come from the SAME base so
 * versions cannot be mixed.
 *
 * Resolution bases, in order: the running DSH app bundle, the standard macOS
 * install (asar and asar.unpacked layouts), DSH_CHECKOUT, the profile
 * node_modules, and — last, for dev and tests — the plugin's own
 * node_modules (the real migration packages are devDependencies).
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pull the `sessionFormatVNToV{N+1}` migration object out of a stage package.
 * Stages whose body migration needs explicit child evidence (V3→V4 onward)
 * ship a `createSessionFormatVNToV{N+1}(children)` factory; an empty array is
 * the documented declaration for a parent without children — imported Codex
 * sessions are imported as roots and never reference DSH children. Stages
 * must expose the `migrateHeader` + `createStage` pair used below.
 */
function stageApi(mod, from) {
  const plain = mod?.[`sessionFormatV${from}ToV${from + 1}`]
  if (plain === undefined) return undefined
  const factory = mod?.[`createSessionFormatV${from}ToV${from + 1}`]
  const api = typeof factory === 'function' ? factory([]) : plain
  return api && typeof api.migrateHeader === 'function' && typeof api.createStage === 'function' ? api : undefined
}

/**
 * Resolve the longest CONSECUTIVE migration chain (v0→v1, v1→v2, …) reachable
 * from one require anchor. Stops at the first missing/unusable stage.
 * @returns {Array<{ mig: object, from: number }>}
 */
function chainFrom(r) {
  const stages = []
  for (let from = 0; ; from += 1) {
    let mod
    try { mod = r(`@deepseek-ai/dsh-session-format-v${from}-to-v${from + 1}`) } catch { break }
    const api = stageApi(mod, from)
    if (api === undefined) break
    stages.push({ mig: api, from })
  }
  return stages
}

/**
 * Resolve the full migration chain. Ties keep the EARLIER base, so the
 * running DSH app always wins over dev fallbacks and versions never mix
 * (every accepted chain comes from a single base).
 * @returns {Array<{ mig: object, from: number }>} at least one stage.
 */
function loadChain() {
  const candidates = []
  // 1. Derive from the running electron binary (…/DSH Desktop.app/Contents/MacOS/…)
  const execDir = process.execPath ? join(dirname(process.execPath), '..') : ''
  if (execDir) {
    candidates.push(join(execDir, 'Resources', 'app', 'node_modules'))
  }
  // 2. Standard macOS install, asar + unpacked layouts, and env/profile fallbacks.
  candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app/node_modules')
  candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules')
  candidates.push(process.env.DSH_CHECKOUT || '')
  candidates.push(join(homedir(), '.dsh', 'profiles', 'node_modules'))
  let best = []
  for (const base of candidates.filter(Boolean)) {
    let r
    try { r = createRequire(join(base, '@deepseek-ai', 'dsh', 'lib', 'index.js')) } catch { continue }
    const stages = chainFrom(r)
    if (stages.length > best.length) best = stages
  }
  // 3. The plugin's own node_modules: devDependencies ship the real packages,
  //    so tests exercise the true migration path without a DSH install.
  const local = chainFrom(createRequire(import.meta.url))
  if (local.length > best.length) best = local
  if (best.length === 0) {
    throw new Error('cannot resolve @deepseek-ai/dsh-session-format-* migration packages')
  }
  return best
}

/**
 * Migrate a released v0 session header + event list to the installed CURRENT
 * format. The source input is not mutated; a fresh header/event list is
 * returned.
 * @param {object} header - v0 header ({version:0, id, createdAt, cwd, …}).
 * @param {Array} events - canonical v0 event rows (each with `seq`).
 * @returns {{ header: object, events: Array }} the current-format header and events.
 */
export function migrateToCurrent(header, events) {
  const stages = loadChain()
  // Derive the migrated header by chaining `migrateHeader`.
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
