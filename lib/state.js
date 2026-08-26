/**
 * Tiny persisted state for dsh-codex-sync.
 *
 * Lives at `<dsh home>/codex-sync.json` (DSH_HOME, default ~/.dsh) so the
 * auto-import toggle survives restarts. The dropdown menu in the composer
 * row is the UI for this file; the file itself is JSON and debuggable.
 *
 * @module dsh-codex-sync/state
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Resolve the state file path. */
export function statePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'codex-sync.json')
}

/** Read the state file; {} when absent or unparsable. */
export function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'))
  } catch {
    return {}
  }
}

/** Merge a patch into the state file and persist it; returns the new state. */
export function writeState(patch) {
  const path = statePath()
  const next = { ...readState(), ...patch }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    /* persistence failure must not break the caller */
  }
  return next
}

/** Effective auto-import: persisted toggle wins over the config default. */
export function effectiveAutoImport(configDefault) {
  return effectiveSetting('autoImport', configDefault)
}

/**
 * Per-item sync preferences for skills and MCP servers.
 *
 * Stored in the state file as:
 *   "skillSync": { "default": true,  "items": { "<name>": true|false } }
 *   "mcpSync":   { "default": true,  "items": { "<name>": true|false } }
 *
 * - `default` decides the fate of NEWLY SEEN names (the "新项目默认同步"
 *   toggle in the UI).
 * - `items` is a per-name override; it survives removals, so re-adding a
 *   skill/server restores the user's choice.
 * - The master switches (`enableSkills`, `mcpMirror`) stay independent and
 *   still gate everything.
 */

/** Read one sync group ({ default: boolean, items: object }); sane defaults. */
export function readSyncGroup(kind) {
  const raw = readState()[kind === 'skill' ? 'skillSync' : 'mcpSync']
  return {
    default: typeof raw?.default === 'boolean' ? raw.default : true,
    items: raw?.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? { ...raw.items } : {},
  }
}

/** Effective on/off for one item: explicit override wins, else group default. */
export function effectiveItemSync(kind, name) {
  const group = readSyncGroup(kind)
  const stored = group.items[name]
  return typeof stored === 'boolean' ? stored : group.default
}

/**
 * Set one item's override. Passing `value === null` clears the override so
 * the item falls back to the group default again.
 * @returns {boolean} effective value after the change.
 */
export function writeItemSync(kind, name, value) {
  const key = kind === 'skill' ? 'skillSync' : 'mcpSync'
  const group = readSyncGroup(kind)
  if (value === null) delete group.items[name]
  else group.items[name] = value === true
  writeState({ [key]: group })
  return value === null ? group.default : value === true
}

/** Set the group's new-item default ("新项目默认同步"). */
export function writeSyncDefault(kind, value) {
  const key = kind === 'skill' ? 'skillSync' : 'mcpSync'
  const group = readSyncGroup(kind)
  group.default = value === true
  writeState({ [key]: group })
  return group.default
}

/** Apply one boolean to every known item (select all / none). Returns count. */
export function writeAllItemSync(kind, names, value) {
  const key = kind === 'skill' ? 'skillSync' : 'mcpSync'
  const group = readSyncGroup(kind)
  for (const name of names) group.items[name] = value === true
  writeState({ [key]: group })
  return names.length
}

/**
 * Effective value of any persisted on/off setting: the state file
 * (~/.dsh/codex-sync.json) overrides the config default, so toggling a
 * feature from the Sync settings UI fully controls it without editing the
 * profile config. Unknown/invalid stored values fall back to the default.
 * @param {string} key - setting key (e.g. 'enableInstructions', 'autoImport').
 * @param {boolean} configDefault - effective value when the user never toggled.
 * @returns {boolean}
 */
export function effectiveSetting(key, configDefault) {
  if (typeof configDefault !== 'boolean') configDefault === true
  const stored = readState()[key]
  return typeof stored === 'boolean' ? stored : configDefault === true
}
