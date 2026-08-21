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
