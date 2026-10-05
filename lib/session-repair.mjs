/**
 * Session-log repair for the "token meter: assistant/message at seq N has no
 * matching step/start event" family of cold-replay failures.
 *
 * Why this lives in dsh-codex-sync: imported sessions were the dominant source
 * of unpaired logs (the converter used to emit only turn/start…turn/end), and
 * any tool that writes into the session store should also be able to heal it.
 * The repair itself is source-agnostic — it fixes native, imported, and
 * mixed logs alike.
 *
 * Three damage classes handled:
 *   1. missing step/start…step/end pairing around assistant/message,
 *      tool/call, tool/result (meter fails loud on full replay);
 *   2. stale assistant/message → chunk citations (sourceEventSeqs pointing at
 *      events that are not assistant/chunk, or out of bounds);
 *   3. seq gaps/rewinds from a "rewritten head + stale-cursor tail" seam —
 *      an external rewrite followed by the live writer still appending with
 *      its old in-memory cursor. The tail is self-consistent, so its citations
 *      are remapped and the whole log renumbered to `seq = line index`.
 *
 * Every candidate log is validated by the REAL @deepseek-ai/dsh-token-meter
 * before anything is written; a file is only rewritten when the repaired form
 * measures clean AND the on-disk form does not.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, constants as zstdConstants } from 'node:zlib'
import { createRequire } from 'node:module'

import { migrateToCurrent } from './session-migrate.mjs'

const require = createRequire(import.meta.url)

/**
 * Resolve dsh's own packages. Inside the live web profile the plugin sits in
 * ~/.dsh/profiles/web/node_modules next to @deepseek-ai/*, so plain require
 * works; a repo/dev checkout needs DSH_CHECKOUT (the dsh install dir) or
 * DSH_HOME to find them.
 */
function dshPackage(name) {
  const attempts = []
  const fromSpec = (spec) => {
    try { return require(spec) } catch { return undefined }
  }
  attempts.push(`@deepseek-ai/${name}`)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // The macOS desktop app bundles the packages under its app.asar.unpacked
  // node_modules — resolvable from a plain-node CLI without DSH_CHECKOUT.
  const appBase = '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules'
  for (const base of [process.env.DSH_CHECKOUT, appBase, join(home, 'profiles', 'web', 'node_modules')]) {
    if (!base) continue
    const r = createRequire(join(base, '@deepseek-ai', name, 'noop.js'))
    try {
      const mod = r(`@deepseek-ai/${name}`)
      if (mod !== undefined) return mod
    } catch { /* try next base */ }
    void r
  }
  void attempts
  throw new Error(
    `cannot resolve @deepseek-ai/${name}; run inside the web profile, `
    + 'or set DSH_CHECKOUT to the deepseek-ai/dsh install directory',
  )
}

/** Decompress one multi-frame session log into header + decoded events. */
function loadEvents(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28 }).toString('utf8')
  const lines = raw.split('\n')
  if (!lines[0].startsWith('{"type":"session"')) throw new Error('not a dsh session log')
  // dsh-session 在不同版本暴露的物理行解码 API 名称不定（`decodeStorageRecord`
  // 在 DSH 0.9.1 已不再导出）。这里先试 decodeStorageRecord，不可用时直接按
  // 逻辑行 JSON.parse——本插件自行写入的 v0/v3 artifact 就是逻辑行形状
  // （{type, seq, time, data, surfaceOp}），直接解析即可，也保证
  // repairEvents / migrateToCurrent 拿到数据。
  const dshSession = dshPackage('dsh-session')
  const decodeStorageRecord = typeof dshSession?.decodeStorageRecord === 'function' ? dshSession.decodeStorageRecord : null
  const evs = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue /* torn tail row */ }
    try {
      if (decodeStorageRecord) evs.push(...decodeStorageRecord(row))
      else evs.push(row)
    } catch { /* skip a single unreadable row */ }
  }
  // 逻辑 header（去掉 storage 的 `type: "session"` 包装）供 v0→v3 迁移使用。
  const headerLine = `${lines[0]}\n`
  const rawHeader = JSON.parse(lines[0])
  const { type: _type, ...logicalHeader } = rawHeader
  return { headerLine, header: logicalHeader, evs }
}

/** Fold events through dsh's real TokenMeter; throws on any replay damage. */
function measure(evs) {
  const { Session } = dshPackage('dsh-session')
  const meterMod = dshPackage('dsh-token-meter')
  const TokenMeter = meterMod.default ?? meterMod
  // DSH 0.9.1 的 `Session.create` 只接受当前（v3）header；用 dsh-session 导出的
  // SESSION_FORMAT_VERSION 而不是写死 version: 0，否则创建 meter 校验会话即抛
  // "session header version must be 3, got 0"。
  const dshSession = dshPackage('dsh-session')
  const version = typeof dshSession?.SESSION_FORMAT_VERSION === 'number' ? dshSession.SESSION_FORMAT_VERSION : 0
  const session = Session.create('repair-check', JSON.parse(JSON.stringify(evs)), {
    id: 'repair-check', version, isSeeded: false, delegationDepth: 0, createdAt: Date.now(), cwd: '/tmp',
  })
  const meter = Object.create(TokenMeter.prototype)
  meter.states = new WeakMap() // bypass cordis Service wiring; fold logic only
  return TokenMeter.prototype.measure.call(meter, session)
}

/** Latest unclosed step region in `fixed` (scanning back to last boundary). */
function openStepOf(fixed) {
  for (let k = fixed.length - 1; k >= 0; k--) {
    const t = fixed[k].type
    if (t === 'step/start') return fixed[k]
    if (t === 'step/end') break
  }
  return null
}

/** Whether the event list would load cleanly: contiguous seq + meter pass. */
export function isClean(evs) {
  for (let i = 0; i < evs.length; i++) if (evs[i].seq !== i) return false
  try { measure(evs); return true } catch { return false }
}

/**
 * Repair one decoded event list in memory: merge stale-cursor seams, insert
 * missing step markers, drop invalid chunk citations, renumber seqs.
 * Returns a fresh list; the input is not mutated.
 */
export function repairEvents(input) {
  let evs = input

  // ── seam merge: first seq rewind marks a rewritten-head + stale-tail log ──
  let seamIdx = -1
  let prevSeq = null
  for (let i = 0; i < evs.length; i++) {
    if (prevSeq !== null && typeof evs[i].seq === 'number' && evs[i].seq <= prevSeq) { seamIdx = i; break }
    if (typeof evs[i].seq === 'number') prevSeq = evs[i].seq
  }
  // 记录尾部事件的旧 seq → 对象身份，等 step 插入、全局重编号后再重映射
  // （step 插入会改变行号，提前映射会指错位置）。
  let tailOldSeqToEvent = null
  if (seamIdx >= 0) {
    const head = evs.slice(0, seamIdx)
    const tail = evs.slice(seamIdx)
    tailOldSeqToEvent = new Map(tail.map((e) => [e.seq, e]))
    evs = [...head, ...tail]
  }

  // ── step pairing: open a step before unmarked message/tool events, close at turn bounds ──
  // STEP_TYPES 覆盖所有「surface」类型（含 user/message）。DSH 的 format v0→v1→v2→v3
  // 迁移在首个 step/start 处才取得 system head，任何 surface 事件出现在它之前都会抛
  // "format v2 surface before first step cannot acquire a system head ..."。旧版导入器
  // 生成的 user/message（无 data.turn/step）正属于此类，导致 DSH 0.9.1 无法把已导入的
  // v0 会话迁移到 v3。这里统一为无 open step 的 surface 事件前置一对 step/start。
  const STEP_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'assistant/chunk'])
  const fixed = []
  let currentTurn = 0
  for (const e of evs) {
    if (e.type === 'turn/start' && e.data && typeof e.data.turn === 'number') currentTurn = e.data.turn
    if (STEP_TYPES.has(e.type)) {
      // user/message 不携带 data.turn/step，回退到当前 turn 与默认 step 1。
      const turn = (e.data && typeof e.data.turn === 'number') ? e.data.turn : currentTurn
      const step = (e.data && typeof e.data.step === 'number') ? e.data.step : 1
      const open = openStepOf(fixed)
      if (!open || open.data.turn !== turn || open.data.step !== step) {
        // meter only enforces pairing order: close the old step first, even across turns
        if (open) fixed.push({ type: 'step/end', time: e.time, data: { turn: open.data.turn, step: open.data.step } })
        fixed.push({ type: 'step/start', time: e.time, data: { turn, step } })
      }
    }
    if (e.type === 'turn/start' || e.type === 'turn/end') {
      const open = openStepOf(fixed)
      if (open) fixed.push({ type: 'step/end', time: e.time, data: { turn: open.data.turn, step: open.data.step } })
    }
    fixed.push(e)
  }

  fixed.forEach((e, i) => { e.seq = i })

  // ── seam citation remap: now that positions are final, translate each tail
  // message's stale seq citations into the final index of the same event. ──
  if (tailOldSeqToEvent !== null) {
    const eventToFinal = new Map(fixed.map((e, i) => [e, i]))
    for (const e of fixed) {
      if (!Array.isArray(e.sourceEventSeqs)) continue
      const mapped = []
      let changed = false
      for (const s of e.sourceEventSeqs) {
        const target = tailOldSeqToEvent.get(s)
        if (target !== undefined && eventToFinal.has(target)) {
          mapped.push(eventToFinal.get(target))
          changed = true
        } else {
          mapped.push(s) // head citation: keep as-is; hygiene pass below filters
          changed = true
        }
      }
      if (changed) e.sourceEventSeqs = mapped
    }
    // 重映射后统一过一遍卫生检查（目标必须是 assistant/chunk）
    for (const e of fixed) {
      if (e.type !== 'assistant/message' || !Array.isArray(e.sourceEventSeqs)) continue
      const valid = e.sourceEventSeqs.filter((s) => fixed[s]?.type === 'assistant/chunk')
      if (valid.length !== e.sourceEventSeqs.length) {
        if (valid.length === 0) delete e.sourceEventSeqs
        else e.sourceEventSeqs = valid
      }
    }
  }

  // ── citation hygiene (non-seam path; the seam path runs it after remap) ──
  if (tailOldSeqToEvent === null) {
    for (const e of fixed) {
      if (e.type !== 'assistant/message' || !Array.isArray(e.sourceEventSeqs)) continue
      const valid = e.sourceEventSeqs.filter((idx) => fixed[idx]?.type === 'assistant/chunk')
      if (valid.length !== e.sourceEventSeqs.length) {
        if (valid.length === 0) delete e.sourceEventSeqs
        else e.sourceEventSeqs = valid
      }
    }
  }

  return fixed.map((e) => JSON.parse(JSON.stringify(e)))
}

/** Encode header + events as the standard two-frame artifact body. */
function encodeLog(headerLine, evs) {
  const frameOpts = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }
  const body = evs.map((e) => JSON.stringify(e)).join('\n') + '\n'
  return Buffer.concat([
    zstdCompressSync(Buffer.from(headerLine), frameOpts),
    zstdCompressSync(Buffer.from(body), frameOpts),
  ])
}

/** Scan a session store root for one log per session dir; exported for tests. */
export function listSessionFiles(root) {
  const out = []
  if (!existsSync(root)) return out
  for (const ws of readdirSync(root)) {
    const wp = join(root, ws)
    let st; try { st = statSync(wp) } catch { continue }
    if (!st.isDirectory()) continue
    for (const d of readdirSync(wp)) {
      const dp = join(wp, d)
      let dst; try { dst = statSync(dp) } catch { continue }
      if (!dst.isDirectory()) continue
      // DSH 0.10.x names current-format logs `session.v4.jsonl.zstd`; older
      // builds wrote `session.jsonl.zstd`. When both exist the highest
      // current-format log wins (the old file was superseded by a previous
      // repair and only remains as the pre-repair state beside its .bak).
      const versioned = readdirSync(dp).filter((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n)).sort()
      if (versioned.length > 0) { out.push(join(dp, versioned.at(-1))); continue }
      const f = join(dp, 'session.jsonl.zstd')
      if (existsSync(f)) out.push(f)
    }
  }
  return out
}

/** Resolve the released session-format catalog used by DSH's own persistence
 * (exposes currentVersion + encodeCurrentHeader/encodeCurrentEvent). */
function sessionFormatCatalog() {
  const mod = dshPackage('dsh-session-format-catalog')
  return mod?.sessionFormatCatalog ?? mod
}

/**
 * Rewrite one stored artifact to the CURRENT (v3) format in place.
 *
 * DSH 0.9.0+ `session-persistence` writes only v3 and migrates pre-v3 artifacts
 * on read via the v0→v1→v2→v3 chain. That chain acquires its "system head" at
 * the FIRST step/start, so any surface event (user/message / assistant/message /
 * tool/result) appearing before the first step/start makes the whole migration
 * throw "format v2 surface before first step cannot acquire a system head ...",
 * leaving the session unreadable (symptom: `encodeCurrent requires Session
 * format v3` / "session ... already exists" on re-import). Old imported v0 logs
 * emitted turn/start → user/message with no leading step region, exactly this
 * case. This repair runs repairEvents (which now opens a step before orphan
 * surfaces), then migrates v0→v3 and validates that the resulting v3 artifact
 * encodes cleanly end-to-end before writing.
 *
 * @param {string} file - path to a stored `session.jsonl.zstd`.
 * @param {object} [options] - { write?: boolean } controls whether the repaired
 *   v3 artifact is written to disk (default false → dry-run, validates only).
 * @returns {{ ok: boolean, reason?: string, from?: number, to?: number }} outcome.
 */
export function migrateArtifactToCurrent(file, options = {}) {
  const writeOut = options.write === true
  let header, evs
  try { ({ header, evs } = loadEvents(file)) } catch (e) { return { ok: false, reason: `load: ${e?.message}` } }
  const cat = sessionFormatCatalog()
  // Already matches current format: nothing to migrate.
  if (header.version === cat.currentVersion) return { ok: false, reason: 'already-current', from: header.version, to: cat.currentVersion }

  const repaired = repairEvents(evs)
  let migrated
  try {
    migrated = migrateToCurrent(header, repaired)
  } catch (e) { return { ok: false, reason: `migrate: ${e?.message}`, from: header.version } }

  // Validate the migrated v3 artifact encodes end-to-end before touching disk.
  try {
    cat.encodeCurrentHeader({ ...migrated.header, delegationDepth: migrated.header.delegationDepth ?? 0 }, 0)
    for (const e of migrated.events) cat.encodeCurrentEvent(e)
  } catch (e) { return { ok: false, reason: `encode: ${e?.message}`, from: header.version } }

  if (!writeOut) return { ok: true, from: header.version, to: cat.currentVersion, dry: true }

  // Rebuild the artifact exactly like the JSONL backend: one header frame, one events frame.
  const headerLineV3 = JSON.stringify(cat.encodeCurrentHeader({ ...migrated.header, delegationDepth: migrated.header.delegationDepth ?? 0 }, 0)) + '\n'
  const bodyV3 = migrated.events.map((e) => JSON.stringify(cat.encodeCurrentEvent(e))).join('\n') + '\n'
  const frameOpts = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from(headerLineV3), frameOpts),
    zstdCompressSync(Buffer.from(bodyV3), frameOpts),
  ])
  copyFileSync(file, `${file}.bak`)   // always keep a backup of the original artifact
  // DSH 0.10.x names current-format logs `session.v<current>.jsonl.zstd`;
  // writing the migrated artifact back under the OLD name would leave it
  // invisible to the new persistence (the "already exists" on re-import).
  const targetFile = join(dirname(file), `session.v${cat.currentVersion}.jsonl.zstd`)
  writeFileSync(targetFile, bytes)
  if (targetFile !== file) rmSync(file)   // the old-named log is superseded
  return { ok: true, from: header.version, to: cat.currentVersion }
}

/**
 * Scan (and optionally repair) every stored session log.
 * @param {object} options - { fix?: boolean, root?: string }.
 * @returns {{ total: number, ok: number, bad: string[], fixed: string[] }} summary.
 */
export function repairSessionStore(options = {}) {
  // 默认 session store 根：DSH Desktop 的会话存于 $DSH_HOME/sessions
  // （如 ~/Library/Application Support/dsh-desktop/harness/sessions），而非
  // ~/.dsh/sessions。旧默认会扫空目录，导致 /repair-sessions 永远扫不到。
  const root = options.root ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(homedir(), '.dsh', 'sessions'))
  const files = listSessionFiles(root)
  const bad = []; const fixed = []; const stale = []; let ok = 0; let skipped = 0
  for (const f of files) {
    let evs, header
    try { ({ evs, header } = loadEvents(f)) } catch { skipped += 1; continue } // non-dsh file: ignore
    // Pre-current-version artifact (v0 from early imports, v3 from the 0.9.x
    // era): rewrite to the current format so the installed DSH can list and
    // open it. On DSH 0.10.x a stored v3 log is INVISIBLE to persistence
    // list() — the importer then tries create() on re-import and aborts the
    // batch with "session … already exists", so healing here is required.
    const cat = sessionFormatCatalog()
    if (header.version !== cat.currentVersion) {
      const res = migrateArtifactToCurrent(f, { write: options.fix === true })
      if (res.ok) {
        if (options.fix === true) fixed.push(f)
        else stale.push(f)
      } else bad.push(f)
      continue
    }
    // 已是最新（v3）格式：不再用 token meter 重写。导入/迁移出来的会话往往缺乏
    // DSH 的 token-usage 记录，TokenMeter 对其冷重放会误报（"Cannot read
    // properties of undefined (reading 'get')" / settle 字段缺失），这是已知局限
    // 而非格式损坏；用 meter 重写会破坏本来能正常打开的 v3 会话。故 v3 一律视为
    // 正常，仅当明确要求 meter 级修复（options.meterRepair）才处理。
    if (options.meterRepair === true) {
      if (isClean(evs)) { ok += 1; continue }
      bad.push(f)
      if (!options.fix) continue
      const { headerLine } = loadEvents(f)
      const repaired = repairEvents(evs)
      measure(repaired) // never write an unverified repair
      copyFileSync(f, `${f}.bak`)
      writeFileSync(f, encodeLog(headerLine, repaired))
      fixed.push(f)
      continue
    }
    ok += 1
    continue
  }
  return { total: files.length, ok, bad, fixed, stale, skipped }
}

/** CLI entry: `dsh-codex-sync repair-sessions [--fix] [--root <dir>]`. */
export function runRepairCli(args) {
  const fix = args.fix === true
  const root = typeof args.root === 'string' ? args.root : undefined
  const summary = repairSessionStore({ fix, root })
  console.log(`scan: ${summary.total} logs, ${summary.ok} clean, ${summary.stale.length} stale, ${summary.bad.length} damaged, ${summary.skipped} skipped`)
  for (const f of summary.stale) console.log(`  STALE ${f}`)
  for (const f of summary.bad) console.log(`  BAD ${f}`)
  for (const f of summary.fixed) console.log(`  FIXED → ${f} (superseded log removed, .bak kept)`)
  if (!fix && (summary.stale.length > 0 || summary.bad.length > 0)) console.log('\ndry run — rerun with --fix to repair')
}
