/**
 * Shared test helper: locate the @deepseek-ai/dsh installation (its
 * node_modules holds react / react-dom / cordis). Resolves through the
 * `dsh` CLI shim's real path so the tests work regardless of npm prefix.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

function whichDsh() {
  try {
    const out = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

/** Absolute path of the @deepseek-ai/dsh package root, or undefined. */
export function dshRoot() {
  try {
    const shim = whichDsh()
    if (!shim) return undefined
    const real = realpathSync(shim)
    // shim → <prefix>/bin/dsh → package …/@deepseek-ai/dsh/bin/dsh.js (or lib)
    let dir = dirname(real)
    let pkgDir = dir
    for (let depth = 0; depth < 6 && !existsSync(join(pkgDir, 'package.json')); depth++) {
      pkgDir = dirname(pkgDir)
    }
    // the shim usually sits in the package itself; otherwise search the parent prefix
    if (!existsSync(join(pkgDir, 'package.json'))) {
      const prefix = join(dirname(dir), '..')
      const candidate = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
      if (existsSync(join(candidate, 'package.json'))) return candidate
      return undefined
    }
    const pkgName = JSON.parse(readFileSyncSafe(join(pkgDir, 'package.json'))).name
    return pkgName === '@deepseek-ai/dsh' ? pkgDir : undefined
  } catch {
    return undefined
  }
}

function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '{}'
  }
}

/** node_modules subpath inside the dsh package (react, react-dom, cordis…). */
export function dshDep(name) {
  const root = dshRoot()
  if (root) {
    const candidate = join(root, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  // CI fallback: no `dsh` CLI installed, but the project's own devDependencies
  // (cordis / react / react-dom) live in the repo node_modules.
  const local = join(import.meta.dirname, '..', 'node_modules', name)
  return existsSync(join(local, 'package.json')) ? local : undefined
}
