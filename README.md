<div align="center">

# ⚡ dsh-codex-sync

**The ultimate 2-way bridge between OpenAI Codex and DSH: bidirectional chat sync, live Skills mount & auto MCP mirroring.**<br/>
*2-way project chat sync · Live Skills mount · Auto MCP mirroring · Native modern UI*

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
    <td align="center" width="50%">
      <b>🎛️ Native Sync Settings Modal</b><br/>
      <img src="docs/sync-settings-modal.png" alt="Codex Sync Settings modal: actions, switches, language" width="100%"/>
    </td>
    <td align="center" width="50%">
      <b>📍 Sidebar Workspace Trigger</b><br/>
      <img src="docs/sidebar-entry.png" alt="Workspace header Codex quick entry button" width="100%"/>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <b>📥 Import from Codex by Project</b><br/>
      <img src="docs/import-picker.png" alt="Import picker: projects, chats, and status tags" width="100%"/>
    </td>
    <td align="center" width="50%">
      <b>📤 Export DSH Chats to Codex</b><br/>
      <img src="docs/export-picker.png" alt="Export picker: smart workspace matching, source filter" width="100%"/>
    </td>
  </tr>
</table>

</div>

---

## 🤔 Why dsh-codex-sync?

When using OpenAI Codex, developers build up significant workflow assets:
1. **Rich project chat histories** with complete code contexts, architecture decisions, and debugging steps;
2. **Custom Skills libraries** under `~/.codex/skills` with tailored instructions and scripts;
3. **Configured MCP toolchains** for databases, web searches, and browser automation.

When adopting or exploring **DeepSeek Harness (DSH)**, developers typically face major friction:
- **Lost conversation history**: Incompatible session formats prevent resuming past Codex tasks in DSH;
- **Configuration duplication and drift**: Skills and MCP servers must be manually recreated and maintained in two separate tools;
- **One-way dead ends**: Most migration scripts are one-time destructive copies that offer no clean way to safely bring DSH continuations back to Codex.

**`dsh-codex-sync` eliminates this friction completely.** It is not a throwaway migrator, but a production-grade, continuous two-way bridge between Codex and DSH.

---

## ✨ Key Highlights

### 1. 💬 Two-Way Safe Project Chat Portability (Codex ⇄ DSH)
- **Import from Codex**:
  - Browse conversations grouped by workspace folder in an intuitive project tree;
  - Preserves user prompts, assistant outputs, reasoning traces, and tool-call trajectories;
  - Automatically attaches imported sessions to matching workspaces for **seamless continuation**;
  - Incremental re-import: Codex conversations continued after the initial import are marked as `updated` and append only new turns without creating duplicate sessions.
- **Export to Codex**:
  - Export DSH native conversations or continuations back into Codex;
  - Automatically matches Codex's workspace catalog, gracefully locking unknown directories to prevent orphan threads;
  - Creates clean, standalone Codex rollouts (`history_mode: legacy`) and SQLite index entries **without modifying or overwriting original Codex histories**;
  - View and continue chats in Codex immediately after restarting the Codex app.
- **Sub-Agent Thread Filtering**:
  - Hides internal sub-agent threads by default to keep the conversation list focused;
  - Easily expand and nest sub-agents under parent threads for selective, independent export.

### 2. ⚡ Live First-Class Skills Mounting
- Mounts `~/.codex/skills/*/SKILL.md` directly into DSH's native skill catalog;
- Full support for nested directory resources and multi-file skill bundles;
- **Zero-restart updates**: Edit a skill file on disk, and DSH recognizes the change on the next turn.

### 3. 🔌 Automated Bidirectional MCP Mirroring
- **Codex → DSH**: Watches `~/.codex/config.toml` live, dynamically mirroring `[mcp_servers.*]` to DSH with conflict avoidance and stderr silencing;
- **DSH → Codex (Reverse Bridge)**: Single-command setup (`npx dsh-codex-sync codex-install`) equips your Codex agent with tools to search, inspect, and install DSH plugins.

### 4. 🎨 Native Modern UI Experience
- **Adaptive Sidebar Trigger**: Sits right beside the workspace header when expanded, and aligns below the search button when collapsed;
- **Centered Modal Panel**: High-contrast, backdrop-blurred settings card with intuitive action cards, real-time switch feedback, and zero UI cutoff;
- **Polished Design Integration**: Uses native DSH design tokens (`--dsw-alias-*`), pure CSS transitions with zero hover artifacts, and responsive text truncation.

---

## 📦 Quick Start

### 1. Install in DSH

Install via DSH Plugin Market (recommended):
```bash
dsh plugin --profile web add dsh-codex-sync
```

Or configure inside your profile's `cordis.patch.yml`:
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

### 2. Configure Codex Reverse MCP Bridge (Optional)

```bash
# Register [mcp_servers.dsh-plugins] in ~/.codex/config.toml
npx dsh-codex-sync codex-install

# Run diagnostic health check
dsh-codex-sync doctor
```

---

## 🎛️ Sync Settings & Toggles

Click the **Codex Icon** in the sidebar to open the centered control modal:

| Section | Item | Command / Config Key | Description |
|---|---|---|---|
| **Actions** | Import from Codex | `/import-all` | Open project picker to import chats into DSH |
| | Export to Codex | `/export-codex` | Export DSH chats into new Codex conversation copies |
| | Mirror status | `/mcp-status` | Modal overview of MCP servers, health, and statuses |
| | Refresh states | `/codex-settings` | Re-sync all switch states from the host |
| **Features** | Import commands | `enableImport` | Enable `/import-codex` slash command family |
| | Auto import | `autoImport` | Automatically import new Codex chats on startup |
| | Instructions | `enableInstructions` | Inject `instructions.md` / `AGENTS.md` into prompt |
| | Config summary | `enableConfig` | Inject `config.toml` model settings summary into prompt |
| | Skills | `enableSkills` | Register `~/.codex/skills` as live DSH skills |
| | MCP mirror | `mcpMirror` | Auto-mirror `[mcp_servers.*]` (applies immediately) |
| **Language** | Language Switcher | `Language` | Toggle between 简体中文 / English |

---

## 🤖 Built-in Agent Skill (`codex-sync`)

This package bundles a first-class `codex-sync` skill. Your DSH AI Agent can operate synchronization tasks on your behalf:

- *"Dry-run importing my Codex conversations"* → runs `/import-codex --dry-run`
- *"Check current MCP mirror status"* → runs `/mcp-status`
- *"Turn on auto-import"* → runs `/auto-import on`

---

## 📄 License

[MIT License](LICENSE) © 2026 Walvez
