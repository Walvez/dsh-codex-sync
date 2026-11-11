/**
 * 把导入的会话挂到对应的工作区（workspace），而不是留在「未分组」桶。
 *
 * dsh 的 workspace 归属是 cwd 精确匹配：每个会话按其持久化 header 的
 * cwd 找 `workspaceRegistry` 中 path 相同的 workspace，不存在则创建。
 *
 * workspace 标题优先用 Codex 的项目名（`projects.name`，一个项目可以包含多个
 * 仓库根目录），拿不到项目名时退回目录名 —— **不再把绝对路径写进标题**：
 * 路径既长又会随机器变化，同名项目靠目录名区分即可。
 *
 * 服务不存在（headless 等未加载 workspace 插件的组合）时静默跳过。
 */

import { normalizePersistence } from './persistence-facade.mjs'

/** 路径显示：home 用 `~` 前缀；超过 3 级只保留最后 3 级（仅用于日志与提示）。 */
export function displayPath(cwd) {
  const home = process.env.HOME ?? ''
  if (cwd === home) return '~'
  if (cwd.startsWith(`${home}/`)) {
    const rel = cwd.slice(home.length + 1)
    const parts = rel.split('/')
    return parts.length > 3 ? `~/${parts.slice(-3).join('/')}` : `~/${rel}`
  }
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 3 ? parts.slice(-3).join('/') : cwd
}

/** 目录名（不区分分隔符，兼容 `\\?\D:\a\b` 这类 Windows 路径）。 */
function baseName(cwd) {
  const parts = String(cwd).replace(/\\/gu, '/').split('/').filter(Boolean)
  return parts.pop() ?? cwd
}

/**
 * workspace 标题：Codex 项目名优先，否则目录名。绝不拼路径。
 * @param {string} cwd
 * @param {(cwd: string) => (string | undefined)} [projectNameOf]
 */
export function workspaceTitle(cwd, projectNameOf) {
  const project = typeof projectNameOf === 'function' ? projectNameOf(cwd) : undefined
  if (typeof project === 'string' && project.trim().length > 0) return project.trim()
  return baseName(cwd)
}

/** 旧版本自动生成过的标题（`basename` 或 `basename (路径)`），可安全改写。 */
function isGeneratedTitle(title, cwd) {
  const base = baseName(cwd)
  if (title === base) return true
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\(`).test(title)
}

/**
 * 按 cwd 分组把会话 attach 到 workspace。
 * @param ctx - 全局上下文（探测 workspaceRegistry）。
 * @param sessions - [{id, cwd}]，仅 cwd 非空的会话会被归位。
 * @param options.projectNameOf - cwd → Codex 项目名（用于工作区标题）。
 * @returns 摘要行数组。
 */
export async function attachSessionsToWorkspaces(ctx, sessions, options = {}) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return []
  const projectNameOf = options.projectNameOf
  const lines = []
  const byCwd = new Map()
  for (const session of sessions) {
    if (typeof session.cwd !== 'string' || session.cwd.length === 0) continue
    let list = byCwd.get(session.cwd)
    if (list === undefined) {
      list = []
      byCwd.set(session.cwd, list)
    }
    list.push(session.id)
  }
  for (const [cwd, ids] of byCwd) {
    if (cwd === '/') {
      lines.push(`  [skipped] /: root directory skipped`)
      continue
    }
    const title = workspaceTitle(cwd, projectNameOf)
    try {
      const existing = await registry.resolveByPath(cwd)
      const workspace = existing ?? await registry.create(cwd, title)
      // 只改自动生成过的标题（目录名或旧版的「目录名 (路径)」），用户自定义的不动。
      if (existing !== undefined && isGeneratedTitle(workspace.title, cwd) && workspace.title !== title) {
        await workspace.setTitle(title)
      }
      for (const id of ids) {
        try {
          await workspace.attachSession(id)
        } catch (error) {
          lines.push(`  [skipped] ${id} attach to ${cwd}: ${error.message}`)
        }
      }
      const action = existing === undefined ? 'created' : 'reused'
      lines.push(`  [${action}] ${title}: ${ids.length} sessions`)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // 源机器的路径在本机不存在：会话照常导入，只是无法挂 workspace。
        lines.push(`  [skipped] ${cwd}: directory missing, sessions stay ungrouped`)
      } else {
        lines.push(`  [failed] ${cwd}: ${error.message}`)
      }
    }
  }
  return lines
}

/**
 * 把自动生成的工作区标题统一成「Codex 项目名 / 目录名」，去掉旧版标题里的路径。
 * @param ctx - 全局上下文（workspaceRegistry）。
 * @param options.projectNameOf - cwd → Codex 项目名。
 * @returns 改动的 workspace 数量。
 */
export async function unifyWorkspaceTitles(ctx, options = {}) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return 0
  const projectNameOf = options.projectNameOf
  let changed = 0
  for (const workspace of registry.list()) {
    if (!isGeneratedTitle(workspace.title, workspace.path)) continue
    const title = workspaceTitle(workspace.path, projectNameOf)
    if (workspace.title === title) continue
    await workspace.setTitle(title)
    changed += 1
  }
  return changed
}

/**
 * 列出 persistence 中所有导入会话（id 前缀 pi-/oc-/codex-/claude-）。
 * @returns [{id, cwd}]，按持久化 header 读取。
 */
export async function listImportedSessions(persistence) {
  persistence = normalizePersistence(persistence)
  const headers = await persistence.list()
  const imported = []
  for (const header of headers) {
    if (/^(pi|oc|codex|claude)-/u.test(header.id)) {
      imported.push({ id: header.id, cwd: header.cwd })
    }
  }
  return imported
}
