#!/usr/bin/env node
/**
 * Minimal asar extractor (no dependencies): pulls one subtree of an Electron
 * `.asar` archive onto disk so the plugin's session-format migration chain can
 * be exercised against the RUNNING DSH build from plain node (tests cannot run
 * inside the Electron runtime).
 *
 * Usage: node scripts/extract-asar-subtree.mjs <archive.asar> <subtree> <outDir>
 *   e.g. node scripts/extract-asar-subtree.mjs \
 *          "D:/programs/DeepSeek Harness/resources/app.asar" \
 *          "dsh/node_modules/@deepseek-ai" /tmp/asarext
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [archive, subtree, outDir] = process.argv.slice(2)
if (!archive || !subtree || !outDir) {
  console.error('usage: extract-asar-subtree.mjs <archive.asar> <subtree> <outDir>')
  process.exit(2)
}

const buf = readFileSync(archive)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
const contentBase = 16 + headerSize

let written = 0
function walk(node, path) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, path ? `${path}/${name}` : name)
    return
  }
  if (typeof node.link === 'string') return
  // asar stores `offset` as a STRING in the header JSON, `size` as a number.
  if (node.offset === undefined || node.size === undefined) return
  const target = join(outDir, path.slice(subtree.length).replace(/^\/+/u, ''))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, buf.slice(contentBase + Number(node.offset), contentBase + Number(node.offset) + Number(node.size)))
  written += 1
}

let node = header
for (const part of subtree.split('/')) {
  node = node?.files?.[part]
  if (!node) {
    console.error(`subtree not found in asar: ${subtree}`)
    process.exit(1)
  }
}
mkdirSync(outDir, { recursive: true })
walk(node, subtree)
console.log(`extracted ${written} file(s) from ${subtree} → ${outDir}`)
