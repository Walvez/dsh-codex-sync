# dsh-codex-sync — Release SOP

How to cut a new version, publish to npm, and keep the market entry current.

## 1. Before publishing (checklist)

```bash
cd ~/Documents/dsh-codex-sync

# version bump (0.2.0 → 0.3.0, …)
#   - package.json "version"
#   - commit message convention: feat:/fix:/docs: + version

# mandatory local tests (project rule: 先本地测试全绿)
npm test                              # host + client + reader suites

# sanity
for f in lib/*.js lib/*.mjs bin/*.js lib/client.js; do node --check "$f"; done
node bin/dsh-codex-sync.js doctor   # health check still green

# tarball MUST contain (bundle breaks without these):
#   cordis.patch.yml        ← the bundle patch layer
#   lib/client.js           ← the client half (if changed)
npm pack --dry-run | grep -E "cordis.patch.yml|client.js"
```

Also verify, if touched:

- `files` field includes `lib`, `bin`, `cordis.patch.yml`, `examples`,
  `README.md`, `LICENSE`, `NOTICE`.
- `exports` has `"./client"` when the client bundle changed.
- `dsh.bundle.patch` points at an existing file.
- `bin` paths have **no `./` prefix** (npm rejects `./bin/x.js` and
  silently strips the bin entry — the tarball ships without the CLI).

## 2. Publish (npm 2FA: web-auth mode, device verification)

The npm account uses **web-auth 2FA**: there is NO 6-digit OTP code to pass
with `--otp`. The flow is terminal → browser popup → device confirm.

```bash
# In an interactive terminal (the reliable path):
npm publish

# Or from a non-interactive shell on the same machine — allocate a PTY so
# npm's interactivity check passes (browser popup still appears on the
# desktop; approve it there):
script -q /dev/null npm publish
```

> Gotcha history: a bare `npm publish` from a non-interactive shell bails
> immediately with `EOTP` and a masked auth URL — no popup, no wait. The
> PTY wrapper fixes that. A version conflict error
> (`cannot publish over the previously published versions: 0.2.0`) means the
> version is already live — bump again.

## 3. Verify after publish

`npm view` caches stale versions on this machine — the authoritative check
is the registry API directly:

```bash
curl -s https://registry.npmjs.org/dsh-codex-sync \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j['dist-tags'].latest)})"
```

## 3.5 Release flow (project rule, since v0.5.0)

1. implement → `npm test` green locally
2. install the packed tarball into the web profile (`pnpm add <tgz>`) and let
   the user restart + verify in the live UI
3. only after user acceptance: push GitHub → publish npm → restore the
   profile dependency to `github:Walvez/dsh-codex-sync` + `pnpm update`

## 4. Market / registry (usually nothing to do)

The market entry (awesome-dsh-plugin registry) carries `"npm":
"dsh-codex-sync"`, which resolves **latest** — a new npm version is picked up
automatically; no PR needed for routine releases.

Do open a PR only for: description/feature changes worth listing,
screenshots (`data/screenshots.json` in the registry repo), or category moves.
