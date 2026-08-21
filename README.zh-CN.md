<!--
  语言切换。默认英文 README；完整中文翻译见本文件。
-->
<div align="center">

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

# dsh-codex-sync

**一站式双向同步插件：OpenAI Codex ⇄ DeepSeek Harness (dsh)**

[![npm version](https://img.shields.io/npm/v/dsh-codex-sync.svg?style=flat-square)](https://www.npmjs.com/package/dsh-codex-sync)
[![CI](https://github.com/Walvez/dsh-codex-sync/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Walvez/dsh-codex-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933.svg?style=flat-square)](package.json)

把 Codex 的技能、指令、配置、会话历史、MCP 服务器全部同步进 DSH；再一键给
Codex 装上反向 MCP 桥——一个插件，双向闭环。

```
┌─────────────────────┐        方向 A: dsh 能力 → Codex          ┌─────────────────────┐
│  DeepSeek Harness   │  ┌──────────────────────────────────────┐  │   OpenAI Codex      │
│                     │  │  [mcp_servers.dsh-plugins]           │  │                     │
│  技能: ~/.codex/skills ──▶ 一等公民 dsh 技能                    │  │  dsh_plugin_* 工具   │
│  指令: instructions.md ──▶ 系统提示词(每次组提示词实时读)          │  │  (搜索/检查/安装插件) │
│  会话: 历史导入 ◀────────────[mcp_servers]─────────────────────  │  │                     │
│  MCP: 自动镜像 codex ──▶ dsh 挂载同一批服务器                    │  │                     │
│                     │  ◀── codex-install 写入配置 ────────────  │  │                     │
└─────────────────────┘        方向 B: codex 配置 → dsh          └─────────────────────┘
```

---

## ✨ 四大功能

### 1. 技能桥接（自动）

`~/.codex/skills/*/SKILL.md` 注册为**一等公民的 DSH 技能**（`ctx.skills`
provider）：

- 完整 SKILL.md 正文可被 `skill` 工具加载，技能目录作为 resourceBase（脚本/附件可解析）。
- 名称自动规范为 kebab-case；权重低于 dsh 自带技能，同名永不遮蔽内置。
- 新技能放入目录 → 下次技能目录扫描即出现。

### 2. 指令与配置注入（自动·实时）

- `~/.codex/instructions.md`（无则 `AGENTS.md`）→ 注入系统提示词。
- `~/.codex/config.toml` 的 model/model_provider → 摘要注入。
- **每次组提示词实时读文件**：改完下一条对话即生效，无需重启。

### 3. 历史会话导入（幂等，半自动/全自动）

```
/import-codex [--limit N] [--project 子串] [--since ISO|ms]
/import-all                       # 同 /import-codex（当前仅 codex 源）
/attach-workspaces                # 全量补挂工作区
/mcp-status                       # 镜像状态（每服务器一行+原因）
/auto-import [on|off]             # 自动导入开关（持久化，无参=查询）
/codex-settings                   # 全部同步设置，机器可读
/codex-setting <key> on|off       # 切换单个同步设置
```

- 会话写入 `ctx.sessionPersistence`，GUI 立即可见、可继续对话。
- **幂等**：已导入的 id 自动跳过，重复执行只补新增。
- **自动挂 workspace**：按 cwd 建/挂工作区，一次导入全量归位，不漏。
- **超大文件保护**：单文件 > `maxSessionBytes`（默认 256MiB）跳过并提示，避免
  Node 字符串上限崩溃中断整个导入（实战中 679MB 的 Surge 会话踩过）。
- **子代理线程默认过滤**：codex 每个子代理是独立 rollout（`parent_thread_id`
  标记，人设如 Socrates/Popper），约占全部 rollout 的**一半**。导入默认跳过，
  会话列表保持干净；`/import-codex --include-subagents` 或配置
  `importSubagents: true` 可连子代理一起导入。
- **控制块剥离**：注入的系统块（`<recommended_plugins>`、`<environment_context>`、
  AGENTS.md 包装等）导入时自动剔除，标题和正文只留真实内容。
- **新 schema 工具轨迹**：独立的 `custom_tool_call` / `custom_tool_call_output`
  响应项还原为真实的 `tool/call` + `tool/result` 事件（输出限 4000 字符 + 截断
  说明）；`reasoning` 摘要并入助手消息；裸 `<image …>` 片段剥离；旧 schema
  （message 内 `tool_use`）依然兼容。
- **同步设置 UI**：composer 的"同步设置 ▾"菜单可直接操作导入、状态与全部
  功能开关，无需改 profile 配置。

### 4. 双向 MCP

**方向 B → dsh（自动镜像，核心亮点）**：以 `~/.codex/config.toml`
`[mcp_servers.*]` 为唯一事实源，DSH 自动挂载可移植的服务器，**并监听文件
实时同步增删改**：

- `stdio` 条目 → `transport: stdio`（command/args/env/cwd，`${VAR}` 自动插值）。
- `url` 条目 → `transport: streamable-http`（`bearer_token_env_var` → `Authorization` 头）。
- `enabled = false` 跳过；`dsh-plugins`（反向桥）**硬排除**防递归；显式
  `mcpServers` 配置优先。
- 失败优雅降级（`failOnStartupError: false`），坏服务器不会拖垮插件。

**方向 A → Codex（一键安装）**：

```bash
dsh-codex-sync codex-install   # 克隆+构建反向 MCP 服务器，写入
                               # ~/.codex/config.toml 的 [mcp_servers.dsh-plugins]
# 重启 Codex → dsh_plugin_search / dsh_plugin_install 等 15 个工具
```

---

## 🎛 同步设置（GUI）

composer 工具行有 **同步设置 ▾** 菜单。**默认英文界面**，随时用菜单底部
的 *Language 语言* 行切换中文（按浏览器持久化）。徽章在组件挂载时自动读取
真实值——播种失败会在下次打开时重试，绝不会留下永久 `？`——之后镜像进
localStorage，打开菜单零卡片。所有动作（导入/状态/切换）的反馈以正常对话
卡片呈现。每行名字右侧有 **ⓘ** 图标——鼠标悬浮即浮窗显示该开关/操作的说明（开关徽章固定右侧不动）。

| 区块 | 项目 | 后端命令 |
|---|---|---|
| 操作 | 立即导入 · 查看镜像状态 | `/import-all` · `/mcp-status` |
| 功能开关 | 导入命令 | `enableImport` |
| 功能开关 | 自动导入 | `autoImport` |
| 功能开关 | 指令注入 | `enableInstructions` |
| 功能开关 | 配置摘要 | `enableConfig` |
| 功能开关 | 技能注册 | `enableSkills` |
| 功能开关 | MCP 镜像 | `mcpMirror` |
| 功能开关 | 刷新状态 | `/codex-settings` |
| Language | English ⇄ 中文（默认英文） | localStorage（`codex-sync.lang`） |

开关持久化到 `~/.dsh/codex-sync.json`，**覆盖 profile 配置默认值**——把
`enableInstructions` 关掉即可停止提示词注入，无需动 `cordis.patch.yml`。
生效时机：

| 键 | 生效时机 |
|---|---|
| `enableImport` | 立即（handler 自门控） |
| `autoImport` | 下次启动会话 |
| `enableInstructions`、`enableConfig` | 下次会话/组提示词（section 常驻、text 门控） |
| `enableSkills` | 下次技能目录扫描（provider 常驻、列表门控） |
| `mcpMirror` | 重启 dsh（镜像在插件 apply 时挂载） |

---

## 📦 安装

### DSH 侧

两种挂载方式**二选一，不能混用**（混用 = loader 启动即报
`duplicate loader entry id: codex-sync`）：

```bash
# 方式一 —— 市场/bundle（一行装齐）
dsh plugin --profile web add dsh-codex-sync   # 写入 dsh.profile.bundles

# 方式二 —— insert 行 + 依赖（本机生产实测）
#   1. dependencies: "dsh-codex-sync": "github:Walvez/dsh-codex-sync"（或 npm install dsh-codex-sync）
#   2. cordis.patch.yml insert 列表加一行（见下/示例文件）
#   3. 重启 dsh web
```

生产实测 insert 行（含镜像排除项）：

```yaml
- insert:
    - id: codex-sync
      name: dsh-codex-sync
      config:
        maxSkills: 30
        mcpMirrorDeny:
          - node_repl
        mcpMirrorSilent:
          - exa
```

完整注释版见 [`examples/web-profile.cordis.patch.yml`](examples/web-profile.cordis.patch.yml)。

### Codex 侧

```bash
npx dsh-codex-sync codex-install        # 或本地: node bin/dsh-codex-sync.js codex-install
dsh-codex-sync doctor                   # 体检: 技能/会话(含子代理统计)/cloudflare 握手/反向桥
```

---

## ⚙️ 配置参考

| 配置项 | 默认 | 说明 |
|---|---|---|
| `codexHome` | `~/.codex` | Codex 配置目录 |
| `enableSkills` | `true` | 注册一等公民技能 |
| `enableInstructions` | `true` | 注入 instructions.md / AGENTS.md |
| `enableConfig` | `true` | 注入 config.toml 摘要 |
| `enableImport` | `true` | 注册 /import-codex 等命令 |
| `maxSkills` | `100` | 最多注册的技能数 |
| `maxSessionBytes` | `268435456` (256MiB) | 导入大小保护 |
| `importSubagents` | `false` | 是否连 codex 子代理线程一起导入（默认过滤，`parent_thread_id` 标记） |
| `mcpServers` | `{}` | 显式 MCP 服务器（dsh-mcp-client 配置） |
| `mcpMirror` | `true` | 自动镜像 codex 的 mcp_servers |
| `mcpMirrorDeny` | `[]` | 额外不镜像的服务器名（`dsh-plugins` 恒排除） |
| `mcpMirrorOnly` | 未设置 | 设置后只镜像这些名字 |
| `mcpMirrorSilent` | `[]` | 静音名单：这些 stdio 服务器以 `sh -c '… 2>/dev/null'` 启动，屏蔽子进程 stderr 噪音（如 exa 的 mcp-remote 流量日志）；协议走 stdin/stdout，安全 |
| `autoImport` | `false` | 启动自动增量导入（第一个 startup 会话时） |

上表所有布尔项都可以直接在 **同步设置 ▾** 菜单里切换，无需改表——
`~/.dsh/codex-sync.json` 里的持久化值优先。

---

## 🔧 本地测试

```bash
npm test
```

- `test/host.smoke.mjs` — 宿主冒烟：命令注册、CommandInvocation 参数解析、
  自动导入&设置持久化、镜像状态（含静音/排除/禁用原因）。
- `test/client.render.mjs` — client bundle 加载 + 真实 React SSR 渲染冒烟。
- `test/codex-reader.test.mjs` — rollout 解析：控制块剥离、标题取第一条真实
  用户消息、新 schema 工具轨迹、图片片段剥离、子代理 header 判别（9 个单测）。
- `test/import-service.test.mjs` — 封闭导入测试：子代理默认过滤与显式开启、
  报告格式。
- **CI（GitHub Actions，node 20 + 22，push/PR）**：整套测试**无需 dsh 安装**
  也能跑——host/client 测试用仓库本地 devDeps。

发布流程（硬性规则）：本地 `npm test` 全绿 → tarball 装入 web profile → 用户
实测验收 → 推送 GitHub → 再发布 npm。详见 [`docs/RELEASE.md`](docs/RELEASE.md)。

---

## ❗ 实战避坑（血泪史）

1. **patch 语法**：`cordis.patch.yml` 顶层 `- id:` 是"覆盖既有行"，新插件必须放
   `- insert:` 列表里。
2. **inject 声明**：`ctx.systemPrompt` 必须写进 `inject: ['systemPrompt']`，否则
   cordis 启动即崩。
3. **同步文本提供者**：systemPrompt section 的 text 提供者必须是同步函数。
4. **超大会话文件**：>512MB 单文件会让 `readFileSync` 抛字符串上限错误，导入
   前先 size 检查。
5. **Cloudflare MCP token**：`insufficient_scope` = token 缺
   `Account → Account Settings → Read`（= `account:read`）；编辑 token 权限
   不换密钥，改完重启即生效。
6. **workspace.json 并发写**：由运行中的服务器进程持有，补挂操作必须在 GUI
   内跑（`/attach-workspaces`），外部脚本会覆盖丢数据。
7. **duplicate loader entry id**（2026-08 实踩）：插件市场更新会把 dsh-codex-sync
   写进 `dsh.profile.bundles`，而 profile 的 `cordis.patch.yml` 里已有 insert
   行 → 两个 `id: codex-sync`，loader 启动即崩。修复：bundles 与 insert 行
   只留一处（本机保留 insert 行，市场 bundle 留 dshmarket）。

---

## 📜 致谢与许可

MIT License。本项目整合并改造了以下 MIT 开源作品，均保留版权声明（见
[NOTICE](NOTICE)）：

- [dsh-plugin-codex-bridge](https://github.com/YYTbit/dsh-plugin-codex-bridge) (c) YYTbit — 桥接思路与修复笔记
- [dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents) (c) Chang-Tong / dongzhangust — 会话解析/转换/工作区挂载
- [deepseek-harness-plugin-mcp](https://github.com/bobleer/deepseek-harness-plugin-mcp) (c) bobleer — Codex 侧反向 MCP 服务器

---

## 🗺 路线图

- [x] `autoImport` 启动自动增量导入（v0.4.0，菜单开关持久化）
- [x] `/mcp-status` 分服务器镜像状态（v0.4.0）
- [x] npm 发布（v0.1.0 – v0.7.1，dsh 市场在售）
- [x] 子代理线程过滤（v0.7.1）· doctor 真实版本号
- [x] 同步设置：全部功能开关进 GUI（v0.7.2；ⓘ 说明 + 语言切换 v0.7.3）
- [ ] opencode / pi / claude-code 会话源（复用 dsh-import-agents 的 reader）
- [ ] 发布自动化（版本 bump + PTY 发布一条命令）