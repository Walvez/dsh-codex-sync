# AGENTS.md — dsh-codex-sync

## 定位

一站式双向同步插件：把 OpenAI Codex 的技能/指令/会话/MCP 配置同步进 DeepSeek Harness (dsh)，并给 Codex 安装反向 MCP 桥。npm 包 `dsh-codex-sync`，GitHub `Walvez/dsh-codex-sync`。

## 怎么跑

```bash
npm test              # 必检门禁（host 冒烟 + client SSR + reader 单测）
node bin/dsh-codex-sync.js doctor   # 运行时体检
```

发布流程（用户硬性规则）：**本地 npm test 全绿 → 装 tarball 到 web profile 让用户实测验收 → 用户确认后才推 GitHub → 再发 npm**（详见 docs/RELEASE.md）。

## 技术栈

- dsh bundle 插件：`dsh.bundle.patch` + `dsh.client`（`{inject, platform:"web"}`），exports["./client"]
- client bundle 手写 CJS：`window.__ModuleLoader__.load({id, factory})`，React 用 require + createElement（无 JSX/构建）
- Cordis 插件模型（inject/effect/on），node:test 单测，纯 JS 无 TS

## 目录与约定

- `lib/index.js` — host 插件入口（inject: systemPrompt/commands；skills/sessionPersistence/workspaceRegistry 用 ctx.get 可选读）
- `lib/` — bridge 指令注入 / skill-provider / import-service / codex-reader / convert / dsh-writer / attach-workspaces / mcp 镜像 / state 持久化 / client.js
- `cordis.patch.yml` — bundle patch（insert 行，config 默认空）
- `examples/web-profile.cordis.patch.yml` — **生产实测挂载方式**：dependencies + insert 行，**不要**同时列进 `dsh.profile.bundles`（duplicate loader entry id 崩溃，2026-08 实踩）
- 系统块过滤在 `codex-reader.mjs`（SYSTEM_BLOCK + AGENTS_MD_BLOCK），改块清单要同步 test/codex-reader.test.mjs
- 已导入会话在 `~/.dsh/sessions/<workspace>/codex-<uuid>/`，zstd 压缩，删除后可重导（导入幂等）

## 当前状态

v0.6.1 已发布（npm latest + GitHub main 同步）。已实现：技能桥接、指令/配置注入、会话导入（幂等/自动挂工作区/控制块剥离）、双向 MCP（自动镜像 + codex-install 反向桥）、composer 同步设置菜单、autoImport 持久化。

下一步：opencode/pi/claude-code 会话源；市场详情页截图；发布自动化。已知取舍：client 徽章读 localStorage（settings 通道对第三方命名空间封闭，勿再走 settingsScope）。
