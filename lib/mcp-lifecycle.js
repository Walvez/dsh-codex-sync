/** Cordis lifecycle adapter shared by explicit and mirrored MCP clients. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpConfigError } from './mcp-config.js'
import { prepareNativeMcp, RuntimeCompatibilityError } from './runtime-compat.js'

export async function loadMcpClient(ctx) {
  // Desktop bundles live inside ASAR; linked plugins must resolve shipped
  // modules through the Host Loader, not an application-specific absolute path.
  const fixture = process.env.DSH_CX_SYNC_MCP_CLIENT_DIR
  if (!fixture) {
    const loader = ctx.get?.('loader')
    if (loader && typeof loader.import !== 'function') throw new RuntimeCompatibilityError('host-loader-api-unsupported')
    if (loader) {
      try {
        return await loader.import('@deepseek-ai/dsh-mcp-client')
      } catch { /* npm/non-Loader installations can still use the optional peer */ }
    }
  }
  try {
    const require = createRequire(fixture ? join(fixture, 'package.json') : import.meta.url)
    return await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-mcp-client')).href)
  } catch { return undefined }
}

/**
 * Bound the entire startup pipeline, including dependency/executable lookup.
 * Keep the Fiber immediately; cancellation must close a negotiating transport.
 * The optional loader argument is a same-process test seam, never profile data.
 */
export async function launchMcp(ctx, config, { signal, timeoutMs = 20000, load = loadMcpClient, allowWaiting = false } = {}) {
  const controller = new AbortController()
  let child
  let closing
  let disposedChild
  let rejectCancelled
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject })
  const abortError = () => new DOMException('MCP startup cancelled', 'AbortError')
  const check = () => { if (controller.signal.aborted) throw abortError() }
  const disposeChild = () => {
    if (!child) return Promise.resolve()
    if (child === disposedChild) return closing ?? Promise.resolve()
    const target = child
    disposedChild = target
    closing = (async () => {
      if (typeof target === 'function') await target()
      else if (typeof target.dispose === 'function') await target.dispose()
      // Repeated Cordis effect disposers can return undefined while teardown is
      // already running; Fiber.await still joins that in-flight lifecycle.
      if (typeof target.await === 'function') await target.await().catch(() => {})
    })()
    return closing
  }
  const cancel = (error = abortError()) => {
    controller.abort()
    void disposeChild().catch(() => {})
    rejectCancelled(error)
  }
  const onAbort = () => cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(() => cancel(new McpConfigError('startup-timeout')), timeoutMs)
  timer.unref?.()
  const setup = (async () => {
    check()
    const module = await load(ctx)
    check()
    if (!module) throw new McpConfigError('mcp-client-unavailable')
    const native = prepareNativeMcp(module, config)
    let prepared = native.config
    const subprocess = ctx.get?.('subprocess')
    if (config.transport === 'stdio' && subprocess !== undefined) {
      if (typeof subprocess?.resolveExecutable !== 'function') throw new RuntimeCompatibilityError('subprocess-api-unsupported')
      prepared = { ...prepared, command: await subprocess.resolveExecutable(config.command, config.env, controller.signal) }
    }
    check()
    child = ctx.plugin(native.plugin, prepared)
    if (typeof child !== 'function' && typeof child?.dispose !== 'function' && typeof child?.then !== 'function') throw new RuntimeCompatibilityError('mcp-lifecycle-unsupported')
    if (typeof child?.await === 'function') await child.await()
    else if (typeof child?.then === 'function') child = await child
    if (controller.signal.aborted) { await disposeChild(); throw abortError() }
    // Explicit clients may stand waiting for tools to arrive later. Retain that
    // dependency-owned Fiber; only the mirror requires immediate readiness.
    if (child?.state !== undefined && child.state !== 2 && !(allowWaiting && child.state === 0)) throw new McpConfigError('mcp-client-inactive')
  })()
  try {
    await Promise.race([setup, cancelled])
    check()
    return { dispose: async () => { controller.abort(); await disposeChild() } }
  } catch (error) {
    controller.abort()
    await disposeChild().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
