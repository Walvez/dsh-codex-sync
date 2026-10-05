# Changelog

## 1.6.2 — 2026-10-05

- Import sessions in the installed DSH current format and support handle-based persistence, incremental assistant replies, new turns, and idempotent re-imports (PR #3).
- Preserve standard function-call arguments; add regression coverage for string, object, empty, legacy and custom-tool inputs.
- Admit the verified official DSH MCP client 0.2.0-rc.2 peer and document npm/CLI versus Desktop versions and text-only reverse-export scope.
- Support checksummed Zstandard compression on Node 20 via the zstd CLI, isolate MCP test fixtures, and clean up timers on failures.
- Retain backups and validate repaired legacy artifacts before writing. Repair validation used temporary copies only.
- CI: Node 20/22 each pass 61 tests; install the exact packed source into official DSH 0.2.0-rc.2 without compatibility exemptions.

Based on main merge commit 2274ee86923b56f84db29d266625abd09761093e. No new application logic beyond that verified commit.
