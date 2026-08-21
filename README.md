<!--
  Language toggle. The English README is the default; the full Chinese
  translation lives in README.zh-CN.md.
-->
<div align="center">

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

# dsh-codex-sync

**One plugin, two-way sync: OpenAI Codex ⇄ DeepSeek Harness (dsh)**

[![npm version](https://img.shields.io/npm/v/dsh-codex-sync.svg?style=flat-square)](https://www.npmjs.com/package/dsh-codex-sync)
[![CI](https://github.com/Walvez/dsh-codex-sync/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Walvez/dsh-codex-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933.svg?style=flat-square)](package.json)

Codex skills, instructions, config, session history and MCP servers flow into
DSH automatically — then one command wires a reverse MCP bridge so Codex can
discover and install dsh plugins. Bidirectional, closed loop.

```
┌─────────────────────┐        A: dsh capabilities → Codex        ┌─────────────────────┐
│  DeepSeek Harness   │  ┌──────────────────────────────────────┐  │   OpenAI Codex      │
│                     │  │  [mcp_servers.dsh-plugins]           │  │                     │
│  skills: ~/.codex/skills ──▶ first-class dsh skills            │  │  dsh_plugin_* tools │
│  instructions.md ─────────▶ system-prompt sections (live)      │  │  (search / inspect /│
│  sessions: history import ─◀────────────[mcp_servers]─────────  │  │   install plugins)  │
│  MCP: auto-mirror codex ──▶ the same servers in dsh            │  │                     │
│                     │  ◀── codex-install writes the config ───  │  │                     │
└─────────────────────┘        B: codex config → dsh            └─────────────────────┘
```

---

## ✨ Features

### 1. Skills bridge (automatic)

`~/.codex/skills/*/SKILL.md` are registered as **first-class DSH skills**
(`ctx.skills` provider):

- Full `SKILL.md` bodies loadable by the `skill` tool; the skill directory
  becomes a resource base (scripts / attachments resolve relative to it).
- Names are normalized to kebab-case; provider rank sits below dsh's bundled
  skills, so name collisions never shadow the built-ins.
- Drop a new skill into the directory → it appears on the next catalog scan.

### 2. Instructions & config injection (automatic, live)

- `~/.codex/instructions.md` (falls back to `AGENTS.md`) → system-prompt section.
- `~/.codex/config.toml` model settings → summarized system-prompt section.
- Both are **re-read on every prompt assembly** — edit the file, the next
  conversation picks it up, no restart needed.

### 3. Session history import (idempotent, semi/fully automatic)

```
/import-codex [--limit N] [--project substr] [--since ISO|ms]
/import-all                       # same as /import-codex (codex source today)
/attach-workspaces                # retro-fits workspaces for every import
/mcp-status                       # mirror state, one row + reason per server
/auto-import [on|off]             # persisted auto-import toggle
/codex-settings                   # all Sync settings, machine-readable
/codex-setting <key> on|off       # toggle one Sync setting
```

- Sessions are written through `ctx.sessionPersistence` — visible in the GUI
  immediately, fully resumable.
- **Idempotent**: already-imported ids are skipped; re-running only adds new ones.
- **Workspace auto-attach**: every imported session lands in its cwd-matching
  workspace (created on demand).
- **Oversize guard**: rollouts above `maxSessionBytes` (default 256 MiB) are
  skipped with a hint — avoids the Node string-limit crash a 679 MB Surge
  session once triggered.
- **Sub-agent threads filtered by default**: codex spawns each sub-agent as its
  own rollout (`parent_thread_id`, personas like Socrates/Popper) — roughly
  *half* of all rollouts. Import skips them so the session list stays clean;
  `/import-codex --include-subagents` or config `importSubagents: true` brings
  them back.
- **Control-block stripping**: injected system blocks (`<recommended_plugins>`,
  `<environment_context>`, AGENTS.md wrappers) are removed; titles and message
  text keep only real content.
- **New-schema tool traces**: standalone `custom_tool_call` /
  `custom_tool_call_output` response items become real `tool/call` +
  `tool/result` events with the *actual* output (capped at 4000 chars with a
  truncation note); `reasoning` summaries fold into the assistant message; raw
  `<image …>` fragments are stripped. The legacy `tool_use`-in-message schema
  still works.
- **Sync settings UI**: the composer "Sync" menu (below) operates imports,
  status and all feature switches without editing profile config.

### 4. Bidirectional MCP

**B → dsh (auto-mirror, the headline feature):** `~/.codex/config.toml`
`[mcp_servers.*]` is the single source of truth. dsh mounts the portable
servers and **watches the file live — add/remove/edit syncs instantly**:

- `stdio` entries → `transport: stdio` (command/args/env/cwd, `${VAR}` interpolation).
- `url` entries → `transport: streamable-http` (`bearer_token_env_var` → `Authorization` header).
- `enabled = false` skipped; `dsh-plugins` (the reverse bridge) is **hard-excluded**
  against recursion; explicit `mcpServers` config wins.
- Graceful degradation (`failOnStartupError: false`) — a broken server never
  takes the plugin down.

**A → Codex (one-shot install):**

```bash
dsh-codex-sync codex-install   # clone + build the reverse MCP server and wire
                               # [mcp_servers.dsh-plugins] into ~/.codex/config.toml
# restart Codex → dsh_plugin_search / dsh_plugin_install … 15 tools
```

---

## 🎛 Sync settings (GUI)

The composer row carries a **Sync ▾** menu. **English by default**; switch
to 中文 at any time via the *Language* row at the bottom of the menu
(persisted per browser). Badges seed automatically on mount — a failed seed
retries on the next open and can never leave permanent `?` — then mirror in
localStorage, so opening the menu adds no card. Every action (import, status,
toggle) reports through a normal conversation card. Each row has a **ⓘ**
icon right after its name — hovering it shows a floating tooltip explaining
what the switch or action does (the on/off badge stays pinned to the right).

| Section | Item | Backing command |
|---|---|---|
| Actions | Import now · Mirror status | `/import-all` · `/mcp-status` |
| Features | Import commands | `enableImport` |
| Features | Auto import | `autoImport` |
| Features | Instructions | `enableInstructions` |
| Features | Config summary | `enableConfig` |
| Features | Skills | `enableSkills` |
| Features | MCP mirror | `mcpMirror` |
| Features | Refresh states | `/codex-settings` |
| Language | English ⇄ 中文 (default English) | localStorage (`codex-sync.lang`) |

Toggles persist to `~/.dsh/codex-sync.json` **and override the profile
config defaults** — flip `enableInstructions` off to stop prompt injection
without touching `cordis.patch.yml`. Effect timing per feature:

| Key | Takes effect |
|---|---|
| `enableImport` | immediately (handlers gate themselves) |
| `autoImport` | at the next startup session |
| `enableInstructions`, `enableConfig` | next session/prompt build (sections stay mounted, text is gated) |
| `enableSkills` | next catalog scan (provider stays mounted, listing is gated) |
| `mcpMirror` | dsh restart (mirror mounts at plugin apply) |

---

## 📦 Install

### DSH side

Pick **exactly one** mounting style — mixing them makes the loader die at
startup with `duplicate loader entry id: codex-sync`:

```bash
# Option A — market/bundle (one-liner)
dsh plugin --profile web add dsh-codex-sync   # writes into dsh.profile.bundles

# Option B — insert row + dependency (the production-tested way)
#   1. dependencies: "dsh-codex-sync": "github:Walvez/dsh-codex-sync"  (or npm install dsh-codex-sync)
#   2. cordis.patch.yml insert list gets one row (see below / examples/)
#   3. restart dsh web
```

Production insert row (with mirror exclusions):

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

Fully commented example: [`examples/web-profile.cordis.patch.yml`](examples/web-profile.cordis.patch.yml).

### Codex side

```bash
npx dsh-codex-sync codex-install        # or locally: node bin/dsh-codex-sync.js codex-install
dsh-codex-sync doctor                   # health: skills / sessions (incl. sub-agent
                                        #         count) / cloudflare handshake / bridge
```

---

## ⚙️ Configuration

| Key | Default | Description |
|---|---|---|
| `codexHome` | `~/.codex` | Codex config directory |
| `enableSkills` | `true` | Register codex skills as first-class dsh skills |
| `enableInstructions` | `true` | Inject instructions.md / AGENTS.md into the prompt |
| `enableConfig` | `true` | Inject a config.toml model summary into the prompt |
| `enableImport` | `true` | Register /import-codex etc. |
| `maxSkills` | `100` | Max codex skills to register |
| `maxSessionBytes` | `268435456` (256 MiB) | Oversize import guard |
| `importSubagents` | `false` | Import codex sub-agent threads too (default: filtered; `parent_thread_id` marks them) |
| `mcpServers` | `{}` | Explicit MCP servers (dsh-mcp-client config) |
| `mcpMirror` | `true` | Auto-mirror `[mcp_servers.*]` from codex config |
| `mcpMirrorDeny` | `[]` | Server names never mirrored (`dsh-plugins` is always excluded) |
| `mcpMirrorOnly` | unset | When set, mirror ONLY these names |
| `mcpMirrorSilent` | `[]` | stdio servers started with `sh -c '… 2>/dev/null'` (kills chatty stderr like exa's mcp-remote logs; protocol runs on stdin/stdout so it is safe) |
| `autoImport` | `false` | Auto-incremental import at the first startup session |

Every boolean above can be toggled live from the **Sync ▾** menu without
editing this table — the persisted value in `~/.dsh/codex-sync.json` wins.

---

## 🔧 Development

```bash
npm test
```

- `test/host.smoke.mjs` — host smoke: command registry, invocation args,
  auto-import + setting persistence, mirror status (silent/denied/disabled rows).
- `test/client.render.mjs` — client bundle loads and SSR-renders under real React.
- `test/codex-reader.test.mjs` — rollout parsing: control-block stripping,
  title = first real user message, new-schema tool traces, image stripping,
  sub-agent header detection (9 unit cases).
- `test/import-service.test.mjs` — hermetic import: sub-agent filtering default
  and opt-in, report format.
- **CI (GitHub Actions, node 20 + 22, push & PR)**: the whole suite runs *without
  a dsh install* — host/client tests use the repo-local devDeps.

Release flow (hard rule): local `npm test` green → tarball install into the web
profile → user acceptance test → push GitHub → publish npm. See
[`docs/RELEASE.md`](docs/RELEASE.md).

---

## ❗ Lessons from the trenches

1. **patch syntax**: a top-level `- id:` row in `cordis.patch.yml` *overrides*
   an existing row; new plugins must go into the `- insert:` list.
2. **inject declarations**: `ctx.systemPrompt` must be in `inject: ['systemPrompt']`
   or cordis refuses to start.
3. **sync text providers**: systemPrompt section `text` providers must be synchronous.
4. **oversized sessions**: >512 MB single files make `readFileSync` throw the
   string-limit error — size-check before importing.
5. **Cloudflare MCP token**: `insufficient_scope` = token lacks
   `Account → Account Settings → Read` (`account:read`). Fix permissions in the
   dashboard — no new token needed, restart to apply.
6. **workspace.json concurrent writes**: held by the running server process —
   workspace retro-fits must run inside the GUI (`/attach-workspaces`);
   external scripts can overwrite and lose data.
7. **duplicate loader entry id** (hit live, 2026-08): a market update wrote
   dsh-codex-sync into `dsh.profile.bundles` while `cordis.patch.yml` already
   had an insert row → two `id: codex-sync` entries, loader crash on startup.
   Fix: keep exactly one (this machine kept the insert row; the market keeps
   dshmarket).

---

## 📜 License & credits

MIT License. This project integrates and reworks the following MIT-licensed
open-source works, with copyright notices preserved (see [NOTICE](NOTICE)):

- [dsh-plugin-codex-bridge](https://github.com/YYTbit/dsh-plugin-codex-bridge) (c) YYTbit — bridge approach & fix notes
- [dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents) (c) Chang-Tong / dongzhangust — session parsing/conversion/workspace attach
- [deepseek-harness-plugin-mcp](https://github.com/bobleer/deepseek-harness-plugin-mcp) (c) bobleer — Codex-side reverse MCP server

---

## 🗺 Roadmap

- [x] `autoImport` startup auto-import (v0.4.0, persisted toggle)
- [x] `/mcp-status` per-server mirror status (v0.4.0)
- [x] npm releases (v0.1.0 – v0.7.1, listed on the dsh market)
- [x] Sub-agent thread filtering (v0.7.1) · doctor real version
- [x] Sync settings: all feature toggles in the GUI (v0.7.2; ⓘ explainers + language switch v0.7.3)
- [ ] opencode / pi / claude-code session sources (reuse dsh-import-agents readers)
- [ ] Release automation (one-command version bump + PTY publish)