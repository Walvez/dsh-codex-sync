// Simulate a transient first-probe/first-session failure using one synthetic
// counter owned by the test's verified temporary directory. No network access.
import { readFile, writeFile } from 'node:fs/promises'
const file = process.argv[2]
if (!file) throw new Error('synthetic counter path required')
const previous = await readFile(file, 'utf8').then(Number, () => 0)
await writeFile(file, String(previous + 1))
if (previous < 2) process.exit(1)
await import('./stdio-mcp-fixture.mjs')
