# Changelog

## 1.10.7 — 2026-11-12

- **Fixed: importing any chat with an answered question failed** with
  `cannot safely transform unclassified message source`. The v2→v3 migration
  stage validates `source.kind` against a closed set that does not contain
  `user-question-reply`, while the *current* (v4) write gate does accept it — so
  1.10.6's card shape broke the v0→v4 chain. The importer now writes those
  messages through the migration as plain `user` messages and restores the reply
  kind on the migrated events (matched by message id), which the current gate
  validates and the questions projection reads.
- Re-imported the thread that failed (`codex-01a1b4be…`): 6262 messages →
  60893 events, **48 answer cards**, no migration error.
- Test: import a reply envelope end to end, assert the stored source survived and
  the log still encodes/restores in the installed format. 98 tests total.

## 1.10.6 — 2026-11-12

- **Question answers survive the round trip in both directions.**
  - Codex → DSH: Codex stores an answer as bare markup
    (`<send_user_message_question_reply>[{questionItemId, question, answer}]`),
    which DSH printed as source text. The converter now recognises that envelope
    and emits a `user/message` with `source.kind = 'user-question-reply'` plus the
    `{questions, answers}` JSON DSH's user-questions UI reads, so it renders as an
    answered-question card (the Host folds exactly this shape to settle a
    question).
  - DSH → Codex: `dshEventsToCodexMessages` writes that card back as the Codex
    envelope instead of the raw JSON, rebuilding `questionItemId` as
    `["request_user_input_async","call_…",<index>]` so a re-import yields the same
    card.
  - Verified on a real rollout (234 messages): 2 answer cards, no markup left;
    round trip keeps callId, question id, question and answer identical.
- Tests: envelope → card (incl. a skipped answer and plain text staying plain),
  card → envelope, and the full round trip. 97 total.

## 1.10.5 — 2026-11-12

- **Fixed: 管理已同步 could not show some imported chats, so they were
  undeletable.** 1.10.4 filtered Codex side chats out of the catalog, and the
  manage view is catalog-driven — a side chat an older build had imported then
  vanished from the list entirely (the reported case: `codex-01a1c47b…`). The
  `only=imported` view now keeps side chats, and it also lists **orphaned
  imports** — sessions this plugin wrote whose Codex thread no longer exists —
  taking their title from the DSH session log. The import view keeps hiding side
  chats.
- Fixed a crash when grouping an orphan (no cwd → `cwd.length` on null).

## 1.10.4 — 2026-11-12

- **Codex side chats are no longer synced or listed.** When Codex Desktop opens a
  conversation in its side panel it forks the thread: the new rollout carries
  `session_meta.payload.forked_from_id` (and a `history_base` naming the parent),
  the same name and the same history prefix — so the picker showed two rows with
  one title (“继续 WeKnora 插件化集成”) and importing the fork duplicated the chat.
  The reader now records `forkedFromId` (a paginated continuation segment points
  `history_base` at ITSELF, which is the same thread, not a fork), and both the
  catalog and the importer drop forked threads. The import result reports
  `side-chat-skipped N` with a hint. On this machine that is 27 threads, and the
  catalog now has no duplicate titles.
- Note: a side chat imported by an older build stays in DSH; remove it with
  管理已同步.

## 1.10.3 — 2026-11-12

- **Fixed: 管理已同步 looked like it did nothing.** The host answers `ok: true`
  even when every id was refused (the usual reason: the chat is open in DSH, so
  the Host holds its write handle and refuses deletion), and the panel ignored
  the returned lines — so a refused delete displayed “已删除已同步对话”. The
  result view now shows the host's report (`[deleted] …` / `[refused] …`) and
  says “没有删除任何会话” when nothing was removed, so the reason is visible.
  Verified against the running Host: deleting an open chat returns
  `[refused] … : 对话正在 DSH 中打开，关闭它之后才能删除`.

## 1.10.2 — 2026-11-12

- **Fixed: an imported chat could silently stay without a workspace, so the
  sidebar showed it nowhere.** `workspace.attachSession()` returns without error
  when the registry filters the id back out (an archived Session never reaches
  `workspace.sessionIds`), and the importer counted that as success. Attach is
  now verified against `workspace.sessionIds`, retried once (the header index can
  lag right after a write), and every session that stays ungrouped is reported as
  `[ungrouped] <id> → <workspace>: <reason>` plus a hint to run
  `/attach-workspaces` after closing the chat.
- Note: DSH allows two workspaces with the same display title (different paths),
  so one Codex project that spans several repo roots can show up as several
  same-named groups; the chat may sit in the sibling group rather than the one
  you were looking at.

## 1.10.1 — 2026-11-12

- **Fixed: the import picker listed the same chat two or three times.** Codex
  paginates one thread into several rollout files — the base
  `rollout-<ts>-<uuid>.jsonl[.zst]` plus `rollout-<ts>-<uuid>_<fork>` segments
  that carry the same `session_meta.payload.id` and only the delta turns. The
  importer already merged them, but `listImportCatalog` built one row per FILE,
  so those threads appeared once per segment (6 threads / 8 extra rows here).
  Rows are now folded per thread id: one row, spanning first to newest segment,
  with the later segment widening `lastTime` so the “有更新” (stale) flag stays
  correct.

## 1.10.0 — 2026-11-12

- **New: 管理已同步 (manage synced chats)** — a picker that lists the chats this
  plugin imported, grouped by Codex project exactly like the import view, with
  checkboxes and a delete button (Sync settings → 管理已同步).
  DSH itself has **no** delete-Session API — the workspace controller only
  offers archive/unarchive/pin/unpin — so `archive` keeps the artifact and a
  later re-import still sees the old Session. This panel removes it for real:
  the session directory, its projection-cache entry, and the archive flag (the
  SQLite index reconciles itself).
  Safety: only `codex-*` ids are accepted (a chat created in DSH can never be
  removed this way), a chat that is open in DSH is refused instead of deleted,
  ids that are not in the store are reported as missing, and `dryRun` reports
  without touching anything. The Codex original is never touched.
- Host: `GET /dsh-codex-sync/catalog?only=imported` (catalog restricted to
  already-imported threads), `POST /dsh-codex-sync/delete` → `lib/delete-imported.mjs`.
- Tests: 6 new cases (removal + cache + archive flag, native-session refusal,
  open-chat refusal, missing id, dryRun, path lookup). 88 total.

## 1.9.3 — 2026-11-12

- **The replayed goal chain is now admissible for DSH's real goal fold.**
  `@deepseek-ai/dsh-goal` validates strictly: `create` must be revision 1 / phase
  active / zero rounds, every later change is exactly revision + 1 and preserves
  `createdAt` + `roundsStarted`, `pause`/`block` only apply to an active goal,
  `resume` is the only way back to active, and a goal id may be created only
  once per session (`seenGoalIds`). The importer violated the last rule twice:
  a re-import whose diffed suffix spanned the rebuilt log re-appended the goal
  `create` (⇒ `goal create requires a fresh active revision-one goal with zero
  rounds`, which left the goal projection broken), and a Codex goal that changed
  back to active was written as a second `create` instead of `resume`.
  Now: goal events never travel in the diffed suffix (`diffImportEvents` filters
  them), re-imports read the stored goal back from the log and continue it
  (`resume`/`pause`/`block`/`complete` with the right revision), and an
  impossible move (anything out of `complete`) appends nothing.
- Tests fold the produced log with the **real** `foldGoal` from
  `@deepseek-ai/dsh-goal` — create → pause → blocked → resume stays admissible —
  plus a regression test that a re-imported turn does not duplicate the create.

## 1.9.2 — 2026-11-12

- **Imported chats no longer land in 创造模式 (the `cordis` agent preset).**
  The import hardcoded `agentPreset: 'cordis'` in the Session header, so every
  chat synced from Codex opened in DSH's plugin-authoring preset. Imports now
  default to `standard` (标准模式) and accept a preset override:
  `config.importAgentPreset`, or `/import-codex --preset ptc`. The same default
  is used by `lib/dsh-writer.mjs` for CLI-side writes.
  A preset is fixed at session creation, so chats imported by an older version
  must be deleted and re-imported to change it.

## 1.9.1 — 2026-11-11

- **Updating a chat that is open in DSH no longer aborts the whole import.**
  DSH's JSONL backend keeps one write handle per Session id and refuses a second
  (`session "…" is already owned by an active write handle`), which is exactly
  what happens when the chat you are re-importing is open in the GUI. The
  importer now retries once (the handle is released when the view switches) and
  then records `[busy] …` + a hint instead of failing the batch; every other
  append error still fails loud.
- Result line reports `busy N` so a partial run is visible.

## 1.9.0 — 2026-11-11

- **Goal mode now survives the trip in both directions.**
  - Codex → DSH: the reader picks up Codex's `event_msg/thread_goal_updated`
    snapshots (the last one wins) and the importer replays them as the
    `goal/change` events DSH's `ctx.goals` reads ("backed exclusively by the
    owning session log"), so an unfinished Codex goal arrives **active** and a
    paused one arrives paused. On re-import only the transition is appended, and
    only when the phase actually changed.
  - DSH → Codex: the exporter reads the session's last `goal/change` and writes a
    `thread_goal_updated` snapshot into the rollout, so Codex shows the goal
    again. `active`/`paused` map directly; a `blocked` goal exports as `paused`
    (Codex's known statuses are only active/paused); a **completed** goal is not
    re-exported as a live one.
- Goal `objective`, `createdAt`/`updatedAt` and the goal id
  (`goal-codex-<threadId>`, stable across re-imports) are preserved; Codex's
  `tokensUsed`/`timeUsedSeconds` are not carried into DSH's `roundsStarted`
  (different meaning).
- Tests: reader goal snapshot, import (create + pause), re-import transition,
  export snapshot + blocked/complete mapping. 77 tests total.

## 1.8.5 — 2026-11-11

- Filter the other Codex desktop envelopes that were imported as user messages:
  `<codex_internal_context>`, `<guardian_tool_descriptions>`,
  `<external_codex_apps_*>` (opened pages, streamed block edits),
  `<in-app-browser-context>`, `<external_browser_tabs>`,
  `<node_repl_review_evidence>`, `<heartbeat>`, and the
  `<no retained transcript delta entries>` placeholder. The opener now also
  matches tags that carry attributes (`<… source="goal">`).
- Kept on purpose: `<proposed_plan>` (real assistant content) and
  `<send_user_message_question_reply>` (carries the user's own answer).
- Over the 1134 rollouts here, the envelopes that leaked into transcripts went
  from ~8100 blocks to 0 (only those two kept families remain).

## 1.8.4 — 2026-11-11

- **Activated skills no longer land in the imported transcript.** Codex hands a
  skill to the model as a user message wrapped in `<skill>…</skill>` (the whole
  SKILL.md: frontmatter, path and body), and the reader only dropped a fixed list
  of openers, so the skill text was imported as if the user had typed it.
  `<skill>` / `<skills>` are now filtered like the other injections.
- Verified over all 1132 rollouts here: 0 remaining `<skill>` blocks (one
  imported chat had 20 of them).

## 1.8.3 — 2026-11-11

- Listen for `agent/created` instead of `agent/session-start`: this DSH build
  has no `agent/session-start` event, so both startup hooks were silent no-ops.
  The catalog event is `agent/created({ agent, source })` with
  `SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'`.
- Affected: the autoImport startup hook (it never imported) and the new
  workspace-title migration hook; the latter now runs once per process.

## 1.8.2 — 2026-11-11

- **Workspaces are named after the Codex project, not the path.** Attaching an
  imported session used to title its workspace `basename (~/…/path)`, so one
  Codex project (which owns several repo roots) showed up under each repo's
  folder name, with a path glued on. Titles are now `projects.name` from
  `~/.codex/state_5.sqlite` (`zbwx-frontend-v2 (~/…)` → `zbwx-v2`), falling back
  to the folder name alone — never a path.
- Existing auto-generated titles are migrated at startup and on every attach
  (`/attach-workspaces` included). Titles you renamed yourself are left alone.
- New `test/attach-workspaces.test.mjs` covers project-name resolution, the
  path-free fallback, the legacy-title migration and custom-title preservation.

## 1.8.1 — 2026-11-11

- **Importing no longer reloads the whole page.** The client used to call
  `window.location.reload()` 2.5 s after a successful import (on both the HTTP
  and command paths), which interrupted whatever you were reading. It now
  re-fetches the plugin's own catalog so the rows flip to "imported", and offers
  「刷新列表」/「Refresh list」 in the result panel for the sidebar, which the Host
  owns and does not let a plugin refresh in place.
- Removed the now-unused reload timer and its cleanup effect.

## 1.8.0 — 2026-11-11

- **Titles and project names now come from Codex's own state**
  (`~/.codex/state_5.sqlite`): `threads.name` is the title the sidebar shows
  (`threads.title` is often a pasted prompt), and `projects.name` +
  `project_roots.path` give the project a chat belongs to. Previously titles
  came from `session_index.jsonl` (which misses ~25% of threads and can be
  stale) and projects were guessed from the cwd folder name, which split one
  Codex project into several entries (e.g. `zbwx-v2` appeared per repo).
- **Internal threads are no longer listed as chats**: Codex marks guardian
  reviews (`{"subagent":{"other":"guardian"}}`, ~985 rows here) and spawned
  sub-agents in `threads.source`; both are now hidden unless sub-agents are
  requested, matching the Codex sidebar. Their nesting uses the recorded
  `parent_thread_id`.
- **The 256 MiB session cap is gone by default (now 2 GiB)**: the reader streams,
  so the cap only hid real conversations. Two sessions here (388 MiB and 1.2 GB,
  6090 and 8882 messages) previously never appeared in the list.
- `doctor` reports the catalog source and the zstd/compressed session split.
- New `test/codex-index.test.mjs` covers path normalization, title precedence,
  project resolution (by id and longest root) and origin classification.

## 1.7.1 — 2026-11-11

- **Read zstd-compressed Codex rollouts** (`rollout-*.jsonl.zst`, what current Codex
  Desktop writes). Inflating them uses the runtime's own `node:zlib` zstd decoder, so
  no extra dependency and no conversion of Codex's data is needed. Multi-frame
  rollouts (a rollout extended by appending a frame) are decoded frame by frame
  instead of stopping at the first frame.
- **Keep the Codex thread name on import**: titles come from
  `~/.codex/session_index.jsonl` (`thread_name`) instead of falling back to the
  first prompt.
- **Stream rollouts instead of `readFileSync`**, so a large session can no longer hit
  Node's string-length ceiling.
- **Find the session-format migration packages inside the Desktop app on Windows**
  (`process.resourcesPath` → `app.asar/dsh/node_modules`), which is required to
  import into the current (v4) format on that platform.
- Accept host `0.2.2-rc.1` in `peerDependencies`.
- Tests: reader runs on the installed DSH packages (17 import-service tests green
  against v0→v4), plus coverage for compressed and multi-frame rollouts and for
  Windows-correct ESM imports in the test harness.

## 1.6.2 — 2026-10-05

- Import sessions in the installed DSH current format and support handle-based persistence, incremental assistant replies, new turns, and idempotent re-imports (PR #3).
- Preserve standard function-call arguments; add regression coverage for string, object, empty, legacy and custom-tool inputs.
- Admit the verified official DSH MCP client 0.2.0-rc.2 peer and document npm/CLI versus Desktop versions and text-only reverse-export scope.
- Support checksummed Zstandard compression on Node 20 via the zstd CLI, isolate MCP test fixtures, and clean up timers on failures.
- Retain backups and validate repaired legacy artifacts before writing. Repair validation used temporary copies only.
- CI: Node 20/22 each pass 61 tests; install the exact packed source into official DSH 0.2.0-rc.2 without compatibility exemptions.

Based on main merge commit 2274ee86923b56f84db29d266625abd09761093e. No new application logic beyond that verified commit.
