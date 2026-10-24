#!/usr/bin/env node
// npm run test:current -- test/current-runtime-rc3
// npm run test:native -- test/native-runtime-rc3
// DSH_CONTRACT_FIXTURE selects one known directory; without a selector, run all.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const contracts = {
  skills: { suite: 'skills-current.test.mjs', fixtures: ['current-runtime', 'current-runtime-rc3'] },
  native: { suite: 'mcp-native.test.mjs', fixtures: ['native-runtime', 'native-runtime-rc3', 'native-runtime-020-rc2'] },
}

function contract(kind) {
  const definition = Object.hasOwn(contracts, kind) ? contracts[kind] : undefined
  if (!definition) throw new Error('Choose a contract suite: skills or native')
  return definition
}

function fixtureDirectory(kind, selector) {
  const { fixtures } = contract(kind)
  const name = selector === undefined ? fixtures[0] : fixtures.find(name =>
    selector === name || resolve(root, selector) === join(root, 'test', name))
  if (!name) throw new Error(`Unknown ${kind} fixture: ${selector}. Choose ${fixtures.map(name => `test/${name}`).join(', ')}`)
  const directory = join(root, 'test', name)
  // npm ci replaces node_modules, so verify the canonical, allowlisted target.
  if (realpathSync(directory) !== directory) throw new Error(`Contract fixture must not be a symlink: test/${name}`)
  return directory
}

// Test files use the same allowlist as the runner, not arbitrary module roots.
export function runtimeRequire(kind, selector = process.env.DSH_CONTRACT_FIXTURE) {
  return createRequire(join(fixtureDirectory(kind, selector), 'package.json'))
}

function npmCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]
  for (const directory of directories) {
    const candidates = [join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    // POSIX npm is normally a symlink to npm-cli.js. Windows npm.cmd is not
    // executable without a shell, so use its adjacent npm-cli.js above instead.
    if (process.platform !== 'win32' && existsSync(join(directory, 'npm'))) candidates.push(realpathSync(join(directory, 'npm')))
    for (const candidate of candidates) {
      if (/\.[cm]?js$/i.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  }
  throw new Error('Cannot locate the npm CLI; run this contract through npm run test:current or npm run test:native')
}

function run(kind, selectors) {
  const { suite, fixtures } = contract(kind)
  if (kind === 'native' && Number(process.versions.node.split('.')[0]) < 24) throw new Error('Native MCP contracts require Node.js 24 or newer')
  const selected = selectors.length ? selectors : process.env.DSH_CONTRACT_FIXTURE ? [process.env.DSH_CONTRACT_FIXTURE] : fixtures
  // Validate every selector before installing any fixture.
  const directories = [...new Set(selected.map(selector => fixtureDirectory(kind, selector)))]
  const cli = npmCli()
  for (const directory of directories) {
    console.log(`[contract:${kind}] ${directory.slice(root.length + 1)}`)
    execFileSync(process.execPath, [cli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: directory, stdio: 'inherit' })
    execFileSync(process.execPath, ['--test', join(root, 'test', suite)], {
      cwd: root, stdio: 'inherit', env: { ...process.env, DSH_CONTRACT_FIXTURE: directory },
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [kind, ...selectors] = process.argv.slice(2)
    run(kind, selectors)
  } catch (error) {
    console.error(`[run-contract-tests] ${error.message}`)
    process.exitCode = error.status ?? 1
  }
}
