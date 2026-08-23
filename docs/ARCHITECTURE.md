# dsh-codex-sync — Architecture

How this plugin works internally: the dsh bundle mechanics, module map,
runtime contracts, and the hard-won loader rules this project discovered.

## 1. What "a dsh plugin" actually is

A dsh plugin ships as an **npm package** that a profile mounts in one of two
ways. dsh-codex-sync supports both; the production profile uses the **plain
row** flavor (the bundle patch still ships for market installs):

| Mechanism | How | Used by |
|---|---|---|
| **Bundle** | package.json declares `dsh.bundle.patch` → the loader applies that YAML as a **patch layer** (the row below) | dshmarket; dsh-codex-sync via `dsh plugin add` |
| **Plain row** | profile `cordis.patch.yml` inserts `name: <package>` and the loader resolves the package's `main` as a Cordis plugin | dsh-codex-sync (production profile), web-search-exa |

> **Never both.** 2026-08 incident: the plugin market updated
> `dsh.profile.bundles` to include dsh-codex-sync while the profile's
> `cordis.patch.yml` already carried an `insert` row for the same id — the
> loader died at startup with `duplicate loader entry id: codex-sync`. The
> two mount paths are alternatives, not layers.

```jsonc
// package.json — what makes it a bundle
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // patch layer that inserts the row
  "client": {                                     // only if the package ships a client half
    "inject": ["@deepseek-ai/dsh-client-runtime", ...],
    "platform": "web"
  }
}
```

Loader rules discovered the hard way:

- **`cordis.patch.yml` must be in the npm tarball** (`files` field) — without
  it the bundle installs but contributes nothing and the loader errors
  (`declares no dsh.bundle` is a different error: patch path missing).
- **Patch semantics**: a top-level `- id:` entry OVERRIDES an existing row;
  new rows must live inside a `- insert:` list.
- **Client half**: the loader reads `exports["./client"]` (string or
  `{ default }`), not a convention like `lib/client.js`. `dsh.client` with
  `platform: "web"` must be declared or the package is not a client bundle.
  The bundle is served at `/plugins/<id>/client.js` and must be wrapped in
  `window.__ModuleLoader__.load({ id, factory: (require) => … })` — a
  hand-authored CJS bundle, no build step, React via `require('react')` +
  `React.createElement` (no JSX).
- **`@deepseek-ai/*` packages are peerDependencies** (registry policy), not
  dependencies.

## 2. Module map

```
bin/dsh-codex-sync.js    CLI: codex-install / codex-uninstall / doctor
cordis.patch.yml         bundle patch layer: inserts the plugin row
lib/index.js             HOST plugin entry (name 'codex-sync')
lib/bridge.js            codex skills/instructions/config → dsh system prompt
lib/skill-provider.js    ~/.codex/skills → first-class ctx.skills provider
lib/import-service.js    codex session import (idempotent, size-guarded)
lib/codex-reader.mjs     codex JSONL session parsing        (MIT, adapted)
lib/convert.mjs          codex events → dsh events           (MIT, adapted)
lib/dsh-writer.mjs       persistence append                  (MIT, adapted)
lib/attach-workspaces.mjs  session → workspace attach        (MIT, adapted)
lib/mcp.js               explicit MCP mounting + codex config auto-mirror
lib/state.js             persisted toggle state (~/.dsh/codex-sync.json)
lib/client.js            CLIENT bundle: composer Sync settings dropdown (MIT, adapted)
examples/web-profile.cordis.patch.yml   production-verified mount example
```

## 3. Host plugin pillars (lib/index.js)

`inject: ['systemPrompt', 'commands']`, reads optional services via
`ctx.get('skills')` / `ctx.get('sessionPersistence')` / `ctx.get('workspaceRegistry')`.

1. **Skills** — `ctx.skills.registerProvider(control => provider)`:
   provider `{ name: 'codex', rank: 800, source: 'custom', … }`. Rank is
   lower-wins; 800 loses to the bundled 600, so a codex skill never shadows
   a built-in one. `get(candidate)` returns `{ …candidate, resourceBase:
   { kind: 'directory', path } }` so the skill tool can resolve scripts.
2. **System prompt** — `ctx.systemPrompt.section({ name, order, text })`:
   `codex-sync:instructions` + `codex-sync:config`. Text providers must be
   **synchronous** (the section API calls them during prompt assembly) —
   read files synchronously with `readFileSync`.
 3. **Commands** — `ctx.commands.register({ name, description, handler })`:
    `/import-codex`, `/import-all`, `/attach-workspaces`, `/mcp-status`,
    `/auto-import`. `parseInput` handles `--key value` and `--key=value`.
    `/mcp-status` reads the mirror handle's `getStatus()` (per-server reason:
    mounted/denied/disabled/silent/failed…) and appends the authoritative
    `autoImport: on|off` line. `/auto-import` persists to `lib/state.js`
    (`~/.dsh/codex-sync.json`); `effectiveAutoImport` lets the persisted
    toggle override the `autoImport` config default. The platform settings
    seam refuses third-party namespaces to the web client (dsh-host-apiproxy
    allowlist), so the client badge mirrors the last toggle in localStorage
    and the toggle itself runs the `/auto-import` command (result card).
 4. **autoImport** — when effective, hooks `agent/session-start`
    (`source === 'startup'`, runs once): services are guaranteed ready and
    the import does not delay boot.
 5. **MCP** — see §5.

## 4. Session import

- `listCodexSessions` guards with `statSync` size: files over
  `maxSessionBytes` (default 256 MiB) are **skipped** with a counter/hint —
  a >512 MiB JSONL makes `readFileSync` throw a string-limit error and abort
  the whole import (real 679 MB incident).
- Idempotency: existing session ids (`codex-<header.id>`) are deduped against
  `persistence.list()`; re-running only imports new ones.
- After import, `attachAllImported` re-attaches **all** imported sessions to
  workspaces by cwd (must run inside the server process — `workspace.json` is
  owned by the running server; external writes clobber it).
- **Control-block stripping** (0.6.1): codex desktop injects system blocks
  into the rollout — `<recommended_plugins>` (plugin catalog), the
  `# AGENTS.md instructions` + `<INSTRUCTIONS>` wrapper, `<environment_context>`
  and friends. `codex-reader.mjs` drops blocks whose text starts with a known
  control opener (`SYSTEM_BLOCK` + `AGENTS_MD_BLOCK`); a user message that
  strips to zero blocks opens **no turn** in `buildDshEvents` and never seeds
  `deriveImportTitle` — the title comes from the first real user message.

## 5. MCP

Two sources (lib/mcp.js):

- **Explicit** — `config.mcpServers` → one `ctx.plugin(McpClient, cfg)` per
  server (`@deepseek-ai/dsh-mcp-client`, optional peer; graceful warning if
  missing).
- **Auto-mirror** (`mcpMirror`, default on) — parses `~/.codex/config.toml`
  `[mcp_servers.*]` (TOML-lite parser: command/args/env/cwd + url/
  bearer_token_env_var + enabled), maps:
  - stdio → `{ transport: 'stdio', serverName, command, args, env }`
  - url → `{ transport: 'streamable-http', url, headers: { Authorization:
    'Bearer <process.env[VAR]>' } }`
  - skips `enabled = false`; **always excludes `dsh-plugins`** (the reverse
    bridge — would recurse); `mcpMirrorDeny`/`mcpMirrorOnly` filter; names in
    explicit `mcpServers` win.
  - `fs.watch(config.toml)` + 500 ms debounce → diff mount/unmount, so
    editing codex's config live-syncs dsh's MCP servers.
  - `failOnStartupError: false` on every instance: a failing server logs and
    continues.

## 6. Client bundle (lib/client.js)

Registers into the composer tool row slot `conversation.input.left`
(via `ctx.slots.inject(name, () => ctx.slots.register({…}, Component))`).
`inject: ['slots', 'remote', 'remote.commands']`. Renders a **Sync settings
dropdown** (`同步设置 ▾/▴`): the chevron toggles a menu with 从 Codex 导入
(`/import-all`), 自动导入 badge toggle (`/auto-import on|off`) and
查看镜像状态 (`/mcp-status`). **Opening the menu runs no command and adds no
conversation card** — the badge mirrors the last toggle in localStorage
(initial: off, the config default); toggling executes the command and the
result card in the conversation is the feedback. No inline results are
rendered, so the composer row never shifts. The platform settings seam
refuses third-party namespaces (dsh-host-apiproxy allowlist), which is why
the badge cannot read a live host value. Pure-presentation component; every
action goes through one injected `runCommand(line)` wrapper. Adapted from
dsh-import-agents' SyncButton (MIT — see NOTICE).

## 7. CLI (bin/dsh-codex-sync.js)

- `codex-install`: clones deepseek-harness-plugin-mcp (bobleer, MIT), builds
  it, upserts a marked block in `~/.codex/config.toml` wiring
  `[mcp_servers.dsh-plugins]` (the reverse MCP: dsh tools → Codex).
- `codex-uninstall`: strips the block.
- `doctor`: codex skills/sessions (+ oversized count), cloudflare token +
  MCP handshake, reverse bridge status.
