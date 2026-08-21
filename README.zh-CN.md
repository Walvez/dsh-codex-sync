<div align="center">

# ⚡ dsh-codex-sync

**OpenAI Codex ⇄ DeepSeek Harness (DSH) 一站式双向同步插件**

<p align="center">
  <a href="README.md"><b>English</b></a> •
  <a href="README.zh-CN.md"><b>简体中文</b></a>
</p>

[![npm version](https://img.shields.io/npm/v/dsh-codex-sync?color=cb3837&style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-codex-sync)
[![npm downloads](https://img.shields.io/npm/dt/dsh-codex-sync?color=2088FF&style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-codex-sync)
[![CI](https://github.com/Walvez/dsh-codex-sync/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Walvez/dsh-codex-sync/actions)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20.0-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/Walvez/dsh-codex-sync/)

自动将 Codex 的技能、指令提示词、模型配置、会话历史与 MCP 服务器同步进 DSH；一键为 Codex 安装反向 MCP 桥，提供 15+ 个 DSH 插件管理专属工具。

<p align="center">
  <img src="docs/sync-menu.zh.png" alt="Composer 同步设置菜单：立即导入、MCP 状态、功能开关" width="720"/>
</p>

</div>

---

## 🚀 核心特性

- **✨ 技能实时挂载**：`~/.codex/skills/*/SKILL.md` 直接注册为 DSH Skills——改文件，下次目录扫描即生效。不用拷贝、不会漂移。插件自带 **`codex-sync` skill**，可用 agent 预演导入、改同步开关、查看 MCP 状态。
- **⚡ 提示词与配置动态注入**：动态读取 `~/.codex/instructions.md`（或 `AGENTS.md`）与 `config.toml`——改动在下一轮组装提示词时立即生效，无需重启。
- **💬 智能历史会话导入**：将 Codex 会话导入 DSH，保留真实工具调用输出，自动绑定工作区，默认过滤子代理。先 `/import-codex --dry-run` 预演（不写盘）。
- **🔌 双向 MCP 生态互联**：
  - **Codex → DSH**：自动监听并镜像 `config.toml` 中的 `[mcp_servers.*]`。
  - **DSH → Codex**：自动配置 `[mcp_servers.dsh-plugins]`，让 Codex 具备搜索、检查、安装 DSH 插件能力。
- **🎛️ Composer 工具栏设置面板**：输入框旁内置 **同步设置 ▾** 菜单，支持一键导入、查看镜像状态及所有功能开关实时切换，支持鼠标悬浮浮窗（ⓘ）说明。

---

## 📦 快速开始

### 1. DSH 端配置

推荐通过 DSH 插件市场一键安装：
```bash
dsh plugin --profile web add dsh-codex-sync
```

或在 `cordis.patch.yml` 中添加 Insert 行挂载：
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

### 2. Codex 端配置（反向 MCP 桥）

```bash
# 自动配置 [mcp_servers.dsh-plugins] 进 ~/.codex/config.toml
npx dsh-codex-sync codex-install

# 运行同步健康体检
dsh-codex-sync doctor
```

---

## 🎛️ Composer 界面设置

点击输入框左侧的 **同步设置 ▾** 按钮即可打开控制面板。所有开关状态均读取宿主真实配置，点击可直接切换并持久化保存。

| 分组 | 项目 | 对应命令 / 配置键 | 行为说明 |
|---|---|---|---|
| **操作** | 立即导入 | `/import-all` | 立即触发增量历史会话导入 |
| | 查看镜像状态 | `/mcp-status` | 查看每个 MCP 服务器的镜像状态与诊断原因 |
| | 刷新状态 | `/codex-settings` | 重新从宿主读取所有开关的真实值 |
| **功能开关** | 导入命令 | `enableImport` | 启用 `/import-codex` 等导入命令 |
| | 自动导入 | `autoImport` | 启动首个会话时自动增量导入 |
| | 指令注入 | `enableInstructions` | 注入 `instructions.md` / `AGENTS.md` 进提示词 |
| | 配置摘要 | `enableConfig` | 注入 `config.toml` 模型摘要进提示词 |
| | 技能注册 | `enableSkills` | 将 `~/.codex/skills` 注册为 DSH 技能 |
| | MCP 镜像 | `mcpMirror` | 自动镜像 `[mcp_servers.*]` 到 DSH |
| **语言** | English ⇄ 中文 | `Language` | 切换界面中英文（localStorage 持久化） |

> 💡 *鼠标悬浮在任意项目右侧的 **ⓘ** 图标上即可查看对应说明浮窗。*

---

## ⚡ Slash 指令参考

| 指令 | 参数 | 说明 |
|---|---|---|
| `/import-codex` | `[--dry-run]` `[--limit N]` `[--project 子串]` `[--since 时间]` `[--include-subagents]` | 导入 Codex 会话（`--dry-run` 只打印 `[would-import]`，不写盘） |
| `/import-all` | *(同上)* | `/import-codex` 的别名 |
| `/attach-workspaces` | *无* | 补挂所有导入会话到对应的 CWD 工作区 |
| `/mcp-status` | *无* | 查看所有 MCP 镜像服务器的实时状态与原因 |
| `/auto-import` | `[on\|off]` | 切换启动时自动导入（无参数时查询状态） |
| `/codex-settings` | *无* | 打印所有功能开关的机器可读清单 |
| `/codex-setting` | `<key> [on\|off]` | 通过命令行切换指定的同步功能 |

---

## ⚙️ 配置项说明

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `codexHome` | `~/.codex` | Codex 配置根目录 |
| `enableSkills` | `true` | 注册 Codex 技能为 DSH 原生技能 |
| `enableInstructions` | `true` | 注入 `instructions.md` / `AGENTS.md` 进系统提示词 |
| `enableConfig` | `true` | 注入 `config.toml` 模型摘要进系统提示词 |
| `enableImport` | `true` | 注册 `/import-codex` 系列命令 |
| `maxSkills` | `100` | 最大扫描与注册的技能数量 |
| `maxSessionBytes` | `268435456` *(256MB)* | 规避 Node V8 字符串上限的超大 rollout 保护阈值 |
| `importSubagents` | `false` | 为 `true` 时连同子代理线程（`parent_thread_id`）一起导入 |
| `mcpMirror` | `true` | 自动镜像 `config.toml` 中的 `[mcp_servers.*]` |
| `mcpMirrorDeny` | `[]` | 镜像黑名单列表（`dsh-plugins` 恒排除） |
| `mcpMirrorOnly` | *未设置* | 镜像白名单：若设置则仅镜像指定名称的服务器 |
| `mcpMirrorSilent` | `[]` | 静音列表：以 `2>/dev/null` 启动对应 stdio 服务屏蔽冗余日志 |
| `autoImport` | `false` | 启动首个会话时自动增量导入 |

---

## 🧪 测试验证

```bash
npm test
```

封闭测试覆盖宿主生命周期、客户端 SSR、rollout 解析、导入 dry-run / 子代理过滤、持久化开关。CI 另有一步用临时 profile 启动 DSH，确认插件能挂上。

欢迎提交补丁，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 📋 同步范围

完整对照表见 **[docs/compat.md](docs/compat.md)**：技能、指令、MCP、会话与子代理处理。

导入前可预演：

```bash
/import-codex --dry-run
```

---

## 🔒 安全

请通过 [SECURITY.md](SECURITY.md) **私下**报告漏洞，不要开公开 Issue。

---

## 📜 开源协议

[MIT License](LICENSE) © 2026 Walvez.
