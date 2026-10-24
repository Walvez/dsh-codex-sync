// Hermetic legacy MCP fixture: synthetic protocol values, no filesystem/network APIs.
import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin })
for await (const line of input) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'codex-sync-contract-fixture', version: '1.0.0' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Return a synthetic protocol marker.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'synthetic-pong' }] }
  else if (request.method === 'ping') result = {}
  else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Not implemented by synthetic fixture' } })}\n`); continue }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
}
