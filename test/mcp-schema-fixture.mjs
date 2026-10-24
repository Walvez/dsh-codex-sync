/** Synthetic native schema; fixtures must exercise the same safety guard as production. */
import z from '@deepseek-ai/schemastery'

export function mcpSchema(extra = {}) {
  const common = {
    serverName: z.string(), toolCallTimeoutMs: z.number(), failOnStartupError: z.boolean(),
    reconnect: z.object({ enabled: z.boolean(), initialDelayMs: z.number(), maxDelayMs: z.number(), maxAttempts: z.number() }),
    ...extra,
  }
  return z.union([
    z.object({ ...common, transport: z.const('stdio'), command: z.string(), args: z.array(String).default([]), env: z.dict(String).default({}), cwd: z.string() }),
    z.object({ ...common, transport: z.const('streamable-http'), url: z.string(), headers: z.dict(String).default({}) }),
  ])
}
export const Config = mcpSchema()
