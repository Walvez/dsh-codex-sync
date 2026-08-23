---
name: codex-sync
description: Operate dsh-codex-sync from this session — preview and import Codex chats, toggle Skills/MCP/import settings, check MCP mirror health, install the reverse MCP bridge.
whenToUse: The user wants to sync Codex into DSH, import or dry-run Codex sessions, turn auto-import on, inspect MCP mirror status, change Sync settings, or run dsh-codex-sync doctor / codex-install.
---

# Codex sync (this plugin)

You can drive **dsh-codex-sync** with slash commands. Prefer a **dry-run** before writing sessions.

## Import Codex conversations

```text
/import-codex --dry-run
/import-codex
/import-codex --include-subagents
/import-codex --ids codex-abc,codex-def
/import-codex --limit 20 --project my-app --since 2026-08-01
/import-all
/attach-workspaces
```

The composer **Import from Codex** button opens a picker: projects → chats, sub-agents nested under the parent thread, already-imported rows greyed out. Prefer that UI when the user is in the web app.

- `--dry-run` prints `[would-import]` lines and **writes nothing**.
- Default import skips Codex **sub-agent** threads (`parent_thread_id`). Add `--include-subagents` only if the user wants those too.
- Already-imported ids are skipped (idempotent). Huge rollouts above `maxSessionBytes` are skipped.

Composer **Sync ▾** → **Import from Codex** opens the picker. After a successful import the page reloads in ~2.5s so new chats appear.

## Export DSH chats to Codex

Writes **new** Codex rollouts (new uuid, text only — not a resume of the original thread; every export creates a new copy and never overwrites original):

```text
/export-codex --dry-run
/export-codex --ids sess-1,sess-2
```

Composer **Sync ▾** → **Export to Codex** opens the picker over DSH sessions:
- **Filters**: "From Codex" (`showCodex`, default off) and "Hide sub-agents" (`hideSub`, default on) filter toggles.
- **Codex-origin sessions**: Only DSH-updated chats (`dshUpdated=true`, tagged "Updated in DSH" / "DSH 已续聊") are selectable. Unchanged or source-missing chats remain locked.
- **Sub-agents**: Hidden by default and nested under parent sessions for organization. Selecting a child sub-agent exports it as a separate independent thread (not merged with parent).
- **Export copies**: Exporting creates brand-new Codex rollouts and thread entries; original Codex conversations are never overwritten.

## Settings (persisted in `~/.dsh/codex-sync.json`)

```text
/codex-settings
/codex-setting <key> on
/codex-setting <key> off
/auto-import on
/auto-import off
```

Keys: `enableImport`, `autoImport`, `enableInstructions`, `enableConfig`, `enableSkills`, `mcpMirror`.

- `autoImport on` — import incrementally at the next startup session.
- `enableSkills` — live-mount `~/.codex/skills` (edit a SKILL.md, next catalog scan picks it up).
- `mcpMirror` — auto-mirror `[mcp_servers.*]` from `~/.codex/config.toml` (takes effect after DSH restart).

## MCP

```text
/mcp-status
```

Shows each mirrored server and why (mounted / denied / silent / failed).

Reverse bridge (Codex can search/install DSH plugins):

```bash
npx dsh-codex-sync codex-install
dsh-codex-sync doctor
```

## How to help the user

1. If they say they want to sync/import Codex chats: run `/import-codex --dry-run`, summarize counts, then `/import-codex` after they confirm.
2. If they want it automatic: `/auto-import on`.
3. If MCP tools from Codex are missing: `/mcp-status`, then explain deny lists / restart after `mcpMirror`.
4. Do not invent extra flags. Do not import sub-agents unless asked.
