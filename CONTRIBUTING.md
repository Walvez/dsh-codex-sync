# Contributing

Thanks for looking at `dsh-codex-sync`. Small, focused PRs are welcome.

## Setup

```bash
git clone https://github.com/Walvez/dsh-codex-sync.git
cd dsh-codex-sync
npm install
npm test
```

- Node.js **20+** (CI runs 20 and 22; no global DSH install required for tests)
- Please keep PRs against `main`

## What to change

| Area | Files |
|---|---|
| Host plugin / commands / settings | `lib/index.js`, `lib/state.js` |
| Codex rollout import | `lib/codex-reader.mjs`, `lib/convert.mjs`, `lib/import-service.js` |
| Composer Sync menu | `lib/client.js` (plain JS + `React.createElement`, no JSX) |
| CLI (`doctor`, `codex-install`) | `bin/dsh-codex-sync.js` |

Add or extend tests next to the change:

- `test/host.smoke.mjs` — commands, persistence, MCP mirror
- `test/codex-reader.test.mjs` — rollout parsing
- `test/import-service.test.mjs` — import filters
- `test/client.render.mjs` — client bundle SSR

`npm test` must stay green. CI on GitHub Actions is the same command.

## Pull requests

- One concern per PR
- Do not commit `node_modules/` or `*.tgz`
- Security issues: see [SECURITY.md](SECURITY.md), not a public issue
