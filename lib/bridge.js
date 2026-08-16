/**
 * Codex → dsh system-prompt bridge (instructions + config summary).
 *
 * Adapted from dsh-plugin-codex-bridge (c) YYTbit, MIT — with the boot-fix
 * notes discovered in the field:
 *   1. declare `inject: ['systemPrompt']` — touching ctx.systemPrompt without
 *      declaring it makes cordis reject the plugin tree at boot;
 *   2. provide the section text SYNCHRONOUSLY — this harness calls section
 *      text providers synchronously and never awaits them.
 *
 * Skills are no longer listed here as prompt text: dsh-codex-sync registers
 * them as first-class dsh skills through the ctx.skills provider instead
 * (see skill-provider.js).
 *
 * @module dsh-codex-sync/bridge
 */
import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'

/** dsh interpolates {{var}} in prompt text and throws on unknown variables. */
export function sanitize(text) {
  return String(text).replace(/\{\{/gu, '{ {')
}

/** Normalize an arbitrary skill folder name into valid kebab-case. */
export function sanitizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

/** Parse YAML-ish frontmatter from markdown. */
export function parseFrontmatter(content) {
  const match = String(content).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  return { meta, body: match[2].trim() }
}

/** Read global instructions: instructions.md first, AGENTS.md as fallback. */
export function loadInstructions(codexHome) {
  for (const file of ['instructions.md', 'AGENTS.md']) {
    try {
      const content = readFileSync(join(codexHome, file), 'utf8')
      if (content.trim().length > 0) return { file, content }
    } catch {
      // try next candidate
    }
  }
  return null
}

/** Parse top-level model/model_provider keys from config.toml. */
export function loadConfigSummary(codexHome) {
  let content
  try {
    content = readFileSync(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    return null
  }
  const result = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue
    const kv = trimmed.match(/^(\w+)\s*=\s*"?([^"]*)"?\s*$/)
    if (kv && (kv[1] === 'model' || kv[1] === 'model_provider')) result[kv[1]] = kv[2]
  }
  return Object.keys(result).length > 0 ? result : null
}

/** systemPrompt section text for codex instructions ('' = skip section). */
export function bridgeInstructionsSection(codexHome) {
  const found = loadInstructions(codexHome)
  if (!found) return ''
  return sanitize(`# Codex Instructions (${found.file})\n\n${found.content}`)
}

/** systemPrompt section text for the codex config summary ('' = skip section). */
export function bridgeConfigSection(codexHome) {
  const cfg = loadConfigSummary(codexHome)
  if (!cfg) return ''
  const parts = ['# Codex Configuration']
  if (cfg.model) parts.push(`Model: ${cfg.model}`)
  if (cfg.model_provider) parts.push(`Provider: ${cfg.model_provider}`)
  return sanitize(parts.join('\n'))
}

/** Count codex skills (used by the CLI doctor). */
export function countCodexSkills(codexHome) {
  try {
    return readdirSync(join(codexHome, 'skills')).filter((e) => !e.startsWith('.')).length
  } catch {
    return 0
  }
}
