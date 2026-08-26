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
import { copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, constants as zstdConstants } from 'node:zlib'
import { createRequire } from 'node:module'

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
  for (const base of [process.env.DSH_CHECKOUT, join(home, 'profiles', 'web', 'node_modules')]) {
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
  const { decodeStorageRecord } = dshPackage('dsh-session')
  const evs = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try { evs.push(...decodeStorageRecord(JSON.parse(line))) } catch { /* skip torn tail row */ }
  }
  return { headerLine: `${lines[0]}\n`, evs }
}

/** Fold events through dsh's real TokenMeter; throws on any replay damage. */
function measure(evs) {
  const { Session } = dshPackage('dsh-session')
  const meterMod = dshPackage('dsh-token-meter')
  const TokenMeter = meterMod.default ?? meterMod
  const session = Session.create('repair-check', JSON.parse(JSON.stringify(evs)), {
    id: 'repair-check', version: 0, createdAt: Date.now(), cwd: '/tmp',
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
  const STEP_TYPES = new Set(['assistant/message', 'tool/call', 'tool/result', 'assistant/chunk'])
  const fixed = []
  for (const e of evs) {
    if (STEP_TYPES.has(e.type) && e.data && typeof e.data.turn === 'number' && typeof e.data.step === 'number') {
      const open = openStepOf(fixed)
      if (!open || open.data.turn !== e.data.turn || open.data.step !== e.data.step) {
        // meter only enforces pairing order: close the old step first, even across turns
        if (open) fixed.push({ type: 'step/end', time: e.time, data: { turn: open.data.turn, step: open.data.step } })
        fixed.push({ type: 'step/start', time: e.time, data: { turn: e.data.turn, step: e.data.step } })
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

function listSessionFiles(root) {
  const out = []
  if (!existsSync(root)) return out
  for (const ws of readdirSync(root)) {
    const wp = join(root, ws)
    let st; try { st = statSync(wp) } catch { continue }
    if (!st.isDirectory()) continue
    for (const d of readdirSync(wp)) {
      const f = join(wp, d, 'session.jsonl.zstd')
      if (existsSync(f)) out.push(f)
    }
  }
  return out
}

/**
 * Scan (and optionally repair) every stored session log.
 * @param {object} options - { fix?: boolean, root?: string }.
 * @returns {{ total: number, ok: number, bad: string[], fixed: string[] }} summary.
 */
export function repairSessionStore(options = {}) {
  const root = options.root ?? join(homedir(), '.dsh', 'sessions')
  const files = listSessionFiles(root)
  const bad = []; const fixed = []; let ok = 0
  for (const f of files) {
    let evs
    try { ({ evs } = loadEvents(f)) } catch { continue } // non-dsh file: ignore
    if (isClean(evs)) { ok += 1; continue }
    bad.push(f)
    if (!options.fix) continue
    const { headerLine } = loadEvents(f)
    const repaired = repairEvents(evs)
    measure(repaired) // never write an unverified repair
    copyFileSync(f, `${f}.bak`)
    writeFileSync(f, encodeLog(headerLine, repaired))
    fixed.push(f)
  }
  return { total: files.length, ok, bad, fixed }
}

/** CLI entry: `dsh-codex-sync repair-sessions [--fix] [--root <dir>]`. */
export function runRepairCli(args) {
  const fix = args.fix === true
  const root = typeof args.root === 'string' ? args.root : undefined
  const summary = repairSessionStore({ fix, root })
  console.log(`scan: ${summary.total} logs, ${summary.ok} clean, ${summary.bad.length} damaged`)
  for (const f of summary.bad) console.log(`  BAD ${f}`)
  for (const f of summary.fixed) console.log(`  FIXED → ${f} (.bak kept)`)
  if (!fix && summary.bad.length > 0) console.log('\ndry run — rerun with --fix to repair')
}
