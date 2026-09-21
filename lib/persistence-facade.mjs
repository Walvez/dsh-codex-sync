/**
 * Persistence-interface adapter for DSH session-persistence.
 *
 * DSH 0.9.0 refactored `ctx.sessionPersistence` to a **handle-based** API:
 *   - `create(header, { inheritedEventCount })` returns a WRITE handle,
 *   - `open(id, 'read'|'write')` returns a handle,
 *   - `list()` returns `[{ header, revision, sizeBytes }]` (id lives under `.header`),
 *   - there is NO `append(id, …)` and NO `inspect(id)` on the service object.
 *
 * Older DSH exposed convenience methods directly on the service object
 * (`append(id, events)`, `inspect(id)`), which is what this plugin's call
 * sites were written against. `normalizePersistence` detects which shape it
 * received and returns either the original (old shape) or a facade that maps
 * the plugin's familiar calls onto the handle-based API, so the rest of the
 * plugin code can stay unchanged.
 */

/**
 * Detect whether `persistence` already exposes the plugin's familiar
 * `inspect(id)` read semantics (older DSH). The real DSH 0.9.0 object exposes
 * `open(id,'read')` instead, so we only build the handle-based facade when
 * `inspect` is absent.
 * @param {object} persistence - the service object from `ctx.get('sessionPersistence')`.
 * @returns {boolean} true when the service already provides `inspect(id)`.
 */
function hasLegacyRead(persistence) {
  return persistence !== null && typeof persistence === 'object' && typeof persistence.inspect === 'function'
}

/**
 * Flatten one DSH `list()` snapshot into the flat metadata shape this plugin
 * expects (`{ id, cwd, origin, delegationDepth, ...header }`).
 * @param {object} snapshot - `{ header, revision, sizeBytes }` (or legacy flat meta).
 * @returns {object} a flat meta object carrying the header fields at top level.
 */
function flattenSnapshot(snapshot) {
  const header = snapshot && typeof snapshot.header === 'object' ? snapshot.header : snapshot
  return { ...(header ?? {}), header }
}

/**
 * Build the handle-based facade for the plugin's familiar calls.
 * @param {object} persistence - the real DSH 0.9.0 service object.
 */
function buildFacade(persistence) {
  return {
    // list() -> flat metas [{ id, cwd, origin, delegationDepth, ...header }]
    async list() {
      const snapshots = (await persistence.list()) || []
      return snapshots.map(flattenSnapshot)
    },

    // inspect(id) -> { meta, events } (0.9.0 uses open(id,'read') + handle.read())
    async inspect(id) {
      let handle
      try {
        handle = await persistence.open(id, 'read')
      } catch {
        return { meta: { id }, events: [] }
      }
      try {
        const read = await handle.read(0)
        const events = read && Array.isArray(read.events) ? read.events : []
        return { meta: { ...(handle.header ?? {}), id }, events }
      } catch {
        return { meta: { id }, events: [] }
      } finally {
        try { await handle.close() } catch { /* best-effort */ }
      }
    },

    // append(id, events) -> open 'write', append, close (for existing sessions).
    async append(id, events) {
      if (!Array.isArray(events) || events.length === 0) return
      const handle = await persistence.open(id, 'write')
      try {
        await handle.append(events)
      } finally {
        try { await handle.close() } catch { /* best-effort */ }
      }
    },

    // create(header, events) -> create handle, append, close (for new sessions).
    // The plugin's old call sites did create(header) then append(id, events); with
    // the handle-based API the freshly-created session is not yet durable, so we
    // combine create+append through the same handle.
    async createAndAppend(header, events) {
      const handle = await persistence.create(header, { inheritedEventCount: 0 })
      try {
        if (Array.isArray(events) && events.length > 0) await handle.append(events)
      } finally {
        try { await handle.flush() } catch { /* best-effort */ }
        try { await handle.close() } catch { /* best-effort */ }
      }
    },
  }
}

/**
 * Wrap a legacy-shape persistence object (which already exposes
 * `append(id,…)` / `inspect(id)` / `create(header)`) so it also exposes the
 * combined `createAndAppend` the plugin now uses; every other method delegates
 * straight to the original.
 */
function wrapLegacy(persistence) {
  if (typeof persistence.createAndAppend === 'function') return persistence
  return new Proxy(persistence, {
    get(target, prop, receiver) {
      if (prop === 'createAndAppend') {
        return async (header, events) => {
          await target.create(header)
          if (Array.isArray(events) && events.length > 0) await target.append(header.id, events)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Return the plugin's familiar persistence API for a DSH service object.
 * @param {object|null|undefined} persistence - the service from `ctx.get('sessionPersistence')`.
 * @returns {object} a proxy giving the plugin the calls it expects.
 */
export function normalizePersistence(persistence) {
  if (persistence === null || persistence === undefined) return persistence
  if (hasLegacyRead(persistence)) return wrapLegacy(persistence)
  return buildFacade(persistence)
}
