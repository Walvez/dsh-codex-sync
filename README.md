<div align="center">

# ⚡ dsh-codex-sync

**One-tap Codex move-in to DSH: auto-import project chats, two-way Skills & MCP sync.**

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

<br/>

<table>
  <tr>
    <td align="center" width="55%">
      <b>🎛️ In-Composer Sync Panel</b><br/>
      <img src="docs/sync-menu.png" alt="Composer Sync menu: import, MCP status, and live feature toggles" width="100%"/>
    </td>
    <td align="center" width="45%">
      <b>💬 Smart Import Picker</b><br/>
      <img src="docs/import-picker.png" alt="Import picker: Codex projects and chats, updated vs already imported" width="100%"/>
    </td>
  </tr>
</table>

</div>

---

## 🚀 Key Capabilities

- **✨ Live Skills Bridge**: Registers `~/.codex/skills/*/SKILL.md` directly into DSH's native skill catalog. Edit a file, and the next scan picks it up instantly—no copy, no drift.
- **🤖 Bundled `codex-sync` Agent Skill**: Ships an out-of-the-box skill so your DSH agent can dry-run imports, toggle sync features, and inspect MCP status autonomously.
- **💬 Smart Session History Importer**: Click **Import now** to open an interactive dialog grouped by project with instant search, sub-agent nesting, and re-import support for continued threads.
- **🔌 Full MCP Auto-Mirroring**:
  - **Codex → DSH**: Dynamically mirrors `[mcp_servers.*]` from `config.toml` with live file watching.
  - **DSH → Codex**: Wires `[mcp_servers.dsh-plugins]` so Codex can discover, inspect, and install DSH plugins via reverse MCP.
- **🌓 Native Dark & Light Theme**: Seamlessly adapts to DSH design tokens (`--dsw-alias-*`) with crisp vector icons, smooth toggles, and hover tooltips (ⓘ).

---

## 📦 Quick Start

### 1. DSH Setup

Install via DSH Plugin Market (recommended):
```bash
dsh plugin --profile web add dsh-codex-sync
```

Or mount via `cordis.patch.yml`:
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

### 2. Codex Setup (Reverse MCP Bridge)

```bash
# Configure [mcp_servers.dsh-plugins] into ~/.codex/config.toml
npx dsh-codex-sync codex-install

# Check synchronization health
dsh-codex-sync doctor
```

---

## 🎛️ In-Composer GUI Settings

Click **Sync ▾** in the composer tool row to access the control panel. Switches reflect live state and persist across sessions.

| Group | Item | Action / Key | Description |
|---|---|---|---|
| **Actions** | Import now | `/import-all` | Open project picker & import chats |
| | Mirror status | `/mcp-status` | Display per-server mirror health & reasons |
| | Refresh states | `/codex-settings` | Re-read all switch states from host |
| **Features** | Import commands | `enableImport` | Enable `/import-codex` command family |
| | Auto import | `autoImport` | Import new sessions automatically on startup |
| | Instructions | `enableInstructions` | Inject `instructions.md` / `AGENTS.md` into prompt |
| | Config summary | `enableConfig` | Inject `config.toml` model summary into prompt |
| | Skills | `enableSkills` | Register `~/.codex/skills` as live DSH skills |
| | MCP mirror | `mcpMirror` | Auto-mirror `[mcp_servers.*]` to DSH |
| **Language** | English ⇄ 中文 | `Language` | Switch GUI language (persisted in localStorage) |

> 💡 *Hover over the **ⓘ** icon next to any item to view its detailed explainer.*

---

## ⚡ Slash Commands

| Command | Arguments | Description |
|---|---|---|
| `/import-codex` | `[--dry-run]` `[--ids a,b]` `[--limit N]` `[--project str]` `[--since date]` `[--include-subagents]` | Import Codex sessions (dry-run prints `[would-import]`, writes nothing) |
| `/import-all` | *(Same as above)* | Alias of `/import-codex` |
| `/attach-workspaces` | *None* | Re-attach all imported sessions to matching CWD workspaces |
| `/mcp-status` | *None* | Display real-time status and reasons for all MCP servers |
| `/auto-import` | `[on\|off]` | Toggle auto-import on startup (query without args) |
| `/codex-settings` | *None* | Print all feature switches and effective states |
| `/codex-setting` | `<key> [on\|off]` | Toggle specific sync features via command line |

---

## ⚙️ Configuration Reference

| Option | Default | Description |
|---|---|---|
| `codexHome` | `~/.codex` | Codex configuration directory |
| `enableSkills` | `true` | Register Codex skills as first-class DSH skills |
| `enableInstructions` | `true` | Inject `instructions.md` / `AGENTS.md` into prompt |
| `enableConfig` | `true` | Inject `config.toml` model summary into prompt |
| `enableImport` | `true` | Register `/import-codex` command family |
| `maxSkills` | `100` | Max number of skills to scan and register |
| `maxSessionBytes` | `268435456` *(256MB)* | Skip rollouts larger than this limit to prevent V8 string crashes |
| `importSubagents` | `false` | When `true`, imports sub-agent rollout threads (`parent_thread_id`) |
| `mcpMirror` | `true` | Auto-mirror `[mcp_servers.*]` from `config.toml` |
| `mcpMirrorDeny` | `[]` | Blacklist of server names never to mirror (`dsh-plugins` excluded) |
| `mcpMirrorOnly` | *None* | Whitelist: if set, mirrors **only** these specified server names |
| `mcpMirrorSilent` | `[]` | Stdio servers started with `2>/dev/null` to silence chatty stderr logs |
| `autoImport` | `false` | Run incremental import automatically on startup session |

---

## 📋 Compatibility Matrix

See **[docs/compat.md](docs/compat.md)** for details on skills, instructions, MCP, sessions, and delta updates.

---

## 🧪 Testing

```bash
npm test
```

Hermetic test suite covers host lifecycle, client SSR, rollout parsing, delta updates, sub-agent filtering, and state persistence without requiring global DSH installation.

---

## 📜 License

[MIT License](LICENSE) © 2026 Walvez.
