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
