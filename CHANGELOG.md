# Changelog

## Unreleased

- Admit the DSH MCP client 0.2.1-rc.2 without compatibility exemptions; resolve shipped clients through the Host Loader with an npm fallback.
- Make Codex Skills cache invalidation registration-owned and watched, including late-created roots and master/per-item changes; parse real YAML invocation policies and fix flat-file resource bases.
- Use complete TOML parsing and portable field validation; keep unsupported tool policies fail-closed and diagnostics free of source excerpts/credential values.
- Retain actual Cordis Fibers, cancel the full startup pipeline, join namespace retirement before replacement, and admit revocations independently of unrelated starts/teardowns. Preserve explicit native reconnect and late dependency activation.
- Add hermetic lifecycle/cache/native-protocol suites and actual-tarball privacy gates; exclude local deployment notes/runtime artifacts and export localized metadata plus an original MIT icon.


## 1.6.2 — 2026-10-05

- Import sessions in the installed DSH current format and support handle-based persistence, incremental assistant replies, new turns, and idempotent re-imports (PR #3).
- Preserve standard function-call arguments; add regression coverage for string, object, empty, legacy and custom-tool inputs.
- Admit the verified official DSH MCP client 0.2.0-rc.2 peer and document npm/CLI versus Desktop versions and text-only reverse-export scope.
- Support checksummed Zstandard compression on Node 20 via the zstd CLI, isolate MCP test fixtures, and clean up timers on failures.
- Retain backups and validate repaired legacy artifacts before writing. Repair validation used temporary copies only.
- CI: Node 20/22 each pass 61 tests; install the exact packed source into official DSH 0.2.0-rc.2 without compatibility exemptions.

Based on main merge commit 2274ee86923b56f84db29d266625abd09761093e. No new application logic beyond that verified commit.
