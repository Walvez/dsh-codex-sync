# Codex → DSH compatibility

What this plugin syncs from OpenAI Codex into DeepSeek Harness.

| Codex source | Destination in DSH | Default | Notes |
|---|---|---|---|
| `~/.codex/skills/*/SKILL.md` | First-class `ctx.skills` provider (`codex`) | **on** (`enableSkills`) | kebab-case names; rank below bundled DSH skills. Toggle in Sync ▾. |
| `~/.codex/instructions.md` or `AGENTS.md` | System-prompt section | **on** (`enableInstructions`) | Re-read on every prompt assembly. |
| `~/.codex/config.toml` model fields | System-prompt summary | **on** (`enableConfig`) | Same live re-read. |
| `[mcp_servers.*]` in `config.toml` | Mirrored MCP clients | **on** (`mcpMirror`) | Live file watch. Deny/silent lists apply. Restart DSH after toggling. |
| Reverse MCP (`codex-install`) | `[mcp_servers.dsh-plugins]` in Codex | one-shot CLI | Gives Codex `dsh_plugin_*` tools. |
| `~/.codex/sessions/**/rollout-*.jsonl` | Resumable DSH sessions (`codex-<id>`) | import commands | Idempotent. Real tool traces. Image fragments cleaned. Size guard on huge rollouts. |
| Sub-agent rollouts | Optional | filtered by default | Keeps the session list focused. `/import-codex --include-subagents` or `importSubagents: true` includes them. |
| Reasoning summaries | Assistant messages | on | Plaintext / `summary` blocks fold into the imported turn. |

## Import preview

```text
/import-codex --dry-run
```

Prints `[would-import]` lines and the same counters as a real run. **No sessions are written.** Then:

```text
/import-codex
/import-codex --include-subagents
/import-codex --limit 20 --project my-app --since 2026-08-01
```

## DSH → Codex Export

DSH sessions can be exported back to Codex as rollout JSONL files and indexed in `state_5.sqlite`:

- **Source filter toggle**: "From Codex" (`showCodex`, default off) allows showing chats that originated from Codex alongside native DSH sessions.
- **Selectable rules**: Only DSH-updated Codex-origin chats (`dshUpdated=true`, tagged "Updated in DSH" / "DSH 已续聊") are selectable. Unchanged or source-missing Codex chats remain grayed out and locked. Native DSH sessions are selectable.
- **Independent copy**: Every export creates a brand-new Codex rollout (new uuid) and thread entry. It never overwrites the original Codex thread.
- **Sub-agents**: Hidden by default (`hideSub`, default on) and nested under their parent sessions for organization. Selecting a child sub-agent exports it as a separate standalone Codex thread (no merge with parent).
