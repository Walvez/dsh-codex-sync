import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { temporary } from './live-helpers.mjs'
const ROOT = fileURLToPath(new URL('../', import.meta.url))
function archiveFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
  const files = new Map()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '')
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length)
    if (header[156] === 0 || header[156] === 48) files.set(name.replace(/^package\//u, ''), tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}
test('actual npm tarball contains runtime resources, not local data or credential literals', async t => {
  const f = await temporary(t)
  const npmCli = process.env.npm_execpath
  const npm = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = [...(npmCli ? [npmCli] : []), 'pack', '--ignore-scripts', '--json', '--pack-destination', f.root]
  const packed = JSON.parse(execFileSync(npm, args, { cwd: ROOT, encoding: 'utf8', ...(!npmCli && process.platform === 'win32' ? { shell: true } : {}) }))[0]
  assert.ok(packed.filename && !packed.filename.includes('/') && !packed.filename.includes('\\'))
  const files = archiveFiles(await readFile(join(f.root, packed.filename)))
  for (const name of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/mcp.js', 'lib/mcp-config.js', 'lib/mcp-lifecycle.js', 'lib/runtime-compat.js', 'lib/skill-provider.js', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'LICENSE', 'NOTICE']) assert.ok(files.has(name), `missing required resource: ${name}`)
  assert.match(files.get('icon.svg').toString(), /<svg\b[^>]*xmlns=/u)
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(files.get(`locale/${locale}.json`)).meta
    assert.ok(meta.title && meta.description)
  }
  for (const [name, bytes] of files) {
    assert.doesNotMatch(name, /(?:^|\/)(?:node_modules|test|\.git)(?:\/|$)|runtime-status|\.local\.md$|(?:^|\/)(?:auth\.json|config\.toml|\.npmrc|\.env(?:\..*)?)$|\.tgz$/u)
    if (!/\.(?:js|mjs|json|md|ya?ml|svg)$/u.test(name)) continue
    const text = bytes.toString('utf8')
    assert.ok(!text.includes(homedir()), `home directory leaked in ${name}`)
    assert.doesNotMatch(text, /\/Users\/[^\s/'"<>]+|[A-Za-z]:\\Users\\[^\s\\'"<>]+/u, `private user path in ${name}`)
    assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, `credential-shaped literal in ${name}`)
    assert.doesNotMatch(text, /session-[0-9a-f]{8}-[0-9a-f-]{27,}/u, `runtime session identity in ${name}`)
  }
  assert.equal(JSON.parse(files.get('package.json')).name, 'dsh-codex-sync')
})
