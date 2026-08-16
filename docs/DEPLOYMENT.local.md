# dsh-codex-sync — LOCAL deployment memory (do NOT commit — private)

Personal ops notes for this machine. This file is gitignored; the public
repo must never contain these paths.

Last updated: 2026-08-16 (v0.3.0 released)

## Local deployment state (this Mac)

- Profile: `~/.dsh/profiles/web`
- Installed from: `github:Walvez/dsh-codex-sync` (pnpm dep in web profile
  package.json) — currently **0.3.0**
- Mounted via `cordis.patch.yml` insert row:
  ```yaml
  - id: codex-sync
    name: dsh-codex-sync
    config:
      maxSkills: 30
      mcpMirrorDeny:
        - node_repl
  ```
- Replaced rows (removed): `codex-bridge` (local plugin), `mcp-cloudflare`
  (explicit MCP), `import-pi-opencode` (dsh-import-agents). The cloudflare
  MCP now comes from the **auto-mirror** (serverName `cloudflare-api`, tools
  `mcp__cloudflare-api__*` — note the rename from `mcp__cloudflare__*`).
- Web app also uses: `@deepseek-ai/dsh-web-search-exa` (searchProvider exa),
  `dshmarket` bundle (plugin market).

## Backups (rollback if needed)

- `~/.dsh/profiles/web/cordis.patch.yml.bak-codex-sync-20260816-140327`
- `~/.dsh/profiles/web/package.json.bak-codex-sync-20260816-140327`
- Restore = copy back over the live file + `pnpm install` in the profile,
  then restart.

## Machine-specific gotchas

- **Cloudflare MCP token**: needs scope `Account → Account Settings → Read`
  (= `account:read`). Token in BOTH `~/.dsh/.env` and `~/.codex/.env`
  (same value). Editing token permissions does NOT change the secret;
  restart dsh web after changes.
- **node_repl is denied in the mirror** (ChatGPT.app private protocol);
  `dsh-plugins` is always hard-denied (recursion).
- **exa mirror works** (keychain auth, same user) — `mcp__exa__*` tools.
- **workspace.json is owned by the running server process**: workspace
  attach must happen inside the GUI (`/attach-workspaces`), never via
  external scripts (clobbers concurrent writes).
- **679 MB lesson**: one >512 MiB JSONL session crashes `readFileSync`
  (string-limit) and aborts the whole import — hence the 256 MiB
  `maxSessionBytes` guard.
- Imported sessions: 183 codex files (179+ attached to 16 workspaces),
  idempotent incremental via `/import-codex` or the Sync button.

## Distribution status

- GitHub: https://github.com/Walvez/dsh-codex-sync (public, `dsh-plugin`
  topic, MIT + NOTICE crediting YYTbit / Chang-Tong / bobleer)
- npm: `dsh-codex-sync` — 0.1.0, 0.2.0, 0.3.0 published (web-auth 2FA: publish must
  run in an interactive terminal, or `script -q /dev/null npm publish` from
  a non-interactive shell)
- Market registry: **PR #909 MERGED** → live at
  https://awesome-dsh-plugin.com/p/Walvez/dsh-codex-sync/ (category tools,
  `npm: dsh-codex-sync` → latest auto-resolves)
- Market UI: dshmarket in this profile → Settings → 插件市场 → search "codex"

## Roadmap / open items

- [ ] `autoImport: true` (startup incremental import — already designed,
      not implemented; user was asked, never answered)
- [ ] `/mcp-status` command (view mirror state in-app)
- [ ] Screenshots for the market detail page (assets/ in repo → PR to
      awesome-dsh-plugin `data/screenshots.json`, GitHub-hosted URLs only)
- [ ] Multi-source import (opencode / pi / claude-code readers — reuse
      dsh-import-agents readers, MIT)
- [ ] npm publish automation (version bump + PTY publish in one script)

## Useful commands

```bash
node bin/dsh-codex-sync.js doctor              # health check
dsh --profile web --dump-config | grep codex-sync   # composed tree
cd ~/.dsh/profiles/web && pnpm update dsh-codex-sync   # pull latest HEAD
```
