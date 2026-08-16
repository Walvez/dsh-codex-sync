/**
 * 把导入的会话挂到对应的工作区（workspace），而不是留在「未分组」桶。
 *
 * dsh 的 workspace 归属是 cwd 精确匹配：每个会话按其持久化 header 的
 * cwd 找 `workspaceRegistry` 中 path 相同的 workspace，不存在则创建。
 * workspace 标题带绝对路径（`basename (/abs/path)`），同名项目也能区分。
 *
 * 服务不存在（headless 等未加载 workspace 插件的组合）时静默跳过。
 */

/** 路径显示：home 用 `~` 前缀；超过 3 级只保留最后 3 级（保证同名可区分又简洁）。 */
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

/** workspace 显示标题：basename + 缩短路径（`名称 (~/最后几级)`）。 */
export function workspaceTitle(cwd) {
  const base = cwd.split('/').filter(Boolean).pop() ?? cwd
  return `${base} (${displayPath(cwd)})`
}

/**
 * 按 cwd 分组把会话 attach 到 workspace。
 * @param ctx - 全局上下文（探测 workspaceRegistry）。
 * @param sessions - [{id, cwd}]，仅 cwd 非空的会话会被归位。
 * @returns 摘要行数组。
 */
export async function attachSessionsToWorkspaces(ctx, sessions) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return []
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
    try {
      const existing = await registry.resolveByPath(cwd)
      const workspace = existing ?? await registry.create(cwd, workspaceTitle(cwd))
      // 统一命名：默认命名的 workspace（title 就是 basename，无路径）补上
      // 绝对路径，同名项目也好区分；用户自定义过的标题不动。
      const base = cwd.split('/').filter(Boolean).pop() ?? cwd
      // 默认命名（title == basename）或旧版生成标题（`basename (绝对路径)`）
      // 都统一成新格式；用户自定义标题不动。
      const generated = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`)
      if (workspace.title === base || generated.test(workspace.title)) {
        await workspace.setTitle(workspaceTitle(cwd))
      }
      for (const id of ids) {
        try {
          await workspace.attachSession(id)
        } catch (error) {
          lines.push(`  [skipped] ${id} attach to ${cwd}: ${error.message}`)
        }
      }
      const action = existing === undefined ? 'created' : 'reused'
      lines.push(`  [${action}] ${workspaceTitle(cwd)}: ${ids.length} sessions`)
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
 * 统一所有默认命名 workspace 的标题为 `basename (绝对路径)`。
 * 只改 title 恰为 basename 的（GUI 默认命名）；用户自定义标题不动。
 * @param ctx - 全局上下文（workspaceRegistry）。
 * @returns 改动的 workspace 数量。
 */
export async function unifyWorkspaceTitles(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return 0
  let changed = 0
  for (const workspace of registry.list()) {
    const base = workspace.path.split('/').filter(Boolean).pop() ?? workspace.path
    if (workspace.title === base) {
      await workspace.setTitle(workspaceTitle(workspace.path))
      changed += 1
    } else {
      // 旧版生成标题（`basename (绝对路径)`）也统一成新格式（`basename (~/…)`）。
      const generated = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`)
      if (generated.test(workspace.title)) {
        await workspace.setTitle(workspaceTitle(workspace.path))
        changed += 1
      }
    }
  }
  return changed
}

/**
 * 列出 persistence 中所有导入会话（id 前缀 pi-/oc-/codex-/claude-）。
 * @returns [{id, cwd}]，按持久化 header 读取。
 */
export async function listImportedSessions(persistence) {
  const headers = await persistence.list()
  const imported = []
  for (const header of headers) {
    if (/^(pi|oc|codex|claude)-/u.test(header.id)) {
      imported.push({ id: header.id, cwd: header.cwd })
    }
  }
  return imported
}
