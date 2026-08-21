/**
 * First-class DSH skill provider backed by ~/.codex/skills.
 *
 * Registers via ctx.skills.registerProvider() so Codex skills appear in the
 * normal DSH skill catalog (the `skill` tool can load full SKILL.md bodies,
 * and scripts/ under each skill dir resolve through a directory resource
 * base). The provider deliberately ranks BELOW dsh's own filesystem provider
 * (800 > BUNDLED_SKILL_RANK 600), so a same-named dsh skill always wins.
 */
import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { parseFrontmatter, sanitizeName } from './bridge.js'

/** Provider rank: higher number = lower precedence on name collisions. */
const CODEX_SKILL_RANK = 800

/**
 * @param {string} codexHome - Codex config dir.
 * @param {object} config - plugin config (maxSkills).
 * @param {object} control - SkillProviderControl (signal/invalidate).
 * @param {() => boolean} [enabled] - live gate; the provider reports no skills
 *   while it returns false (Sync settings toggle, hot on next catalog scan).
 * @returns {import('@deepseek-ai/dsh-skill').SkillProvider}
 */
export function registerCodexSkillProvider(codexHome, config, control, enabled = () => true) {
  const maxSkills = config.maxSkills ?? 100

  /** Scan ~/.codex/skills: SKILL.md folders or flat .md files. */
  function scan() {
    let entries
    try {
      entries = readdirSync(join(codexHome, 'skills'))
    } catch {
      return []
    }
    const found = []
    for (const entry of entries) {
      if (found.length >= maxSkills) break
      if (entry.startsWith('.')) continue
      const skillFile = join(codexHome, 'skills', entry, 'SKILL.md')
      let file = skillFile
      try {
        readFileSync(file, 'utf8')
      } catch {
        if (!entry.endsWith('.md')) continue
        file = join(codexHome, 'skills', entry)
        try {
          readFileSync(file, 'utf8')
        } catch {
          continue
        }
      }
      found.push({ entry, file })
    }
    return found
  }

  return {
    name: 'codex',
    async list() {
      if (enabled() === false) return []
      const candidates = []
      for (const { entry, file } of scan()) {
        if (control.signal.aborted) return candidates
        let content
        try {
          content = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        const { meta, body } = parseFrontmatter(content)
        if (body.trim().length === 0) continue
        const rawName = meta.name ?? entry.replace(/\.md$/u, '')
        const name = sanitizeName(rawName)
        candidates.push({
          name,
          description: typeof meta.description === 'string' ? meta.description : '',
          whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: 'codex',
          rank: CODEX_SKILL_RANK,
          locator: { file, dir: join(codexHome, 'skills', entry) },
          path: file,
          metadata: meta,
        })
      }
      return candidates
    },
    async get(candidate) {
      if (control.signal.aborted) return undefined
      let content
      try {
        content = readFileSync(candidate.locator.file, 'utf8')
      } catch {
        return undefined
      }
      const { body } = parseFrontmatter(content)
      const { locator, ...summary } = candidate
      return {
        ...summary,
        content: body,
        resourceBase: { kind: 'directory', path: candidate.locator.dir },
      }
    },
  }
}
