# Symphony (Claude Code + Jira port of openai/symphony SPEC.md)

## Claude + Codex tickets — feat/claude-codex-tickets

- [x] Add workflow provider defaults and Codex command/model/sandbox/timeouts; preserve legacy Claude workflows.
- [x] Persist ticket provider/model choices and expose validated board create/edit APIs; select before Todo.
- [x] Add Codex JSON turn parsing and explicit thread resume, retaining shared process cleanup and handoff checks.
- [x] Snapshot provider/model per attempt; expose provider/model and honest cost reporting in activity.
- [x] Add accessible provider/model controls to ticket creation and Properties, plus card labels.
- [x] Test config, ticket persistence, API validation, both runners, continuation, errors, cancellation, and handoff checks.
- [x] Update README, metadata, and example workflows; run full tests/typecheck in this worktree's container and inspect UI.

Scope: src/{core,workflow,agent,local,jira,orchestrator,server,dashboard.html}, tests/fixtures, README, example workflows, package description.
No dependencies, automatic fallback, push, merge, or live-board changes. Existing tickets default to Claude unless the workflow changes its default.
Codex defaults to workspace-write with approvals disabled; broader access must be explicitly configured for external tracker files/remotes/Docker.

Review: provider/model selectors in create and ticket Properties; status is disabled while selection is unsaved. Local headers use existing locked atomic writes; Jira uses reserved labels with incremental add/remove operations. Provider/model and stall timeout are pinned per attempt; both runners share cancellation/orphan protection and the existing handoff gate. Codex token totals include cache once; cost_usd becomes null after Codex runs.

Verification: container tests 60/60; typecheck clean; browser create/edit/save/reset, Codex dispatch, switch back to Claude, and activity totals checked on a disposable board. Real installed Codex gpt-6.1-sol and Claude opus each completed a tiny first turn and explicit resume with remembered context in a scratch directory. No tools or project edits in those live CLI checks. No dependencies added.

Not checked: real Jira Cloud writes or a full authenticated ticket workflow with external board/remote/Docker access. Codex sandbox access must be configured for the deployment. No push, merge, or live-board edits.

Decisions (my calls — user skipped questions):
- TypeScript on Node 24, run directly via native type stripping (no build step). Deps: `yaml`, `liquidjs`.
- Tracker adapter: Jira Cloud (REST v3, `/search/jql`). Agent: Claude Code headless (`claude -p --output-format stream-json`),
  first turn `--session-id <uuid>`, continuation turns `--resume <uuid>`. Front-matter key `claude` replaces spec's `codex`.
- Tracker writes go through `$SYMPHONY_TRACKER comment|transition` (our CLI), scoped to the current issue.
- Dev commands (npm install / test / typecheck) run in `docker compose` service `app` (node:24-slim).
- Out of scope v1: HTTP dashboard (13.7), SSH workers (Appendix A), Linear adapter.

## Tasks
- [x] package.json, tsconfig, compose.yaml, .gitignore
- [x] src/core.ts — Issue type, Tracker interface, norm, $VAR resolution, JSON logger, process-group kill
- [x] src/workflow.ts — WORKFLOW.md loader, typed config + defaults + validation, strict Liquid render
- [x] src/jira.ts — adapter (fetch by states/ids, pagination, ADF→text, blockers, dispatchable) + comment/transition
- [x] src/workspace.ts — sanitized keys, root containment, hooks w/ timeout, create/remove
- [x] src/agent.ts — Claude Code turn runner (stream-json parse, turn timeout, abort)
- [x] src/orchestrator.ts — poll tick, reconcile (stall + state), dispatch/concurrency, retries/backoff, reload, startup cleanup
- [x] src/cli.ts — daemon entry + `tracker` agent tool
- [x] tests (node:test) incl. end-to-end with fake `claude` + fake tracker
- [x] WORKFLOW.example.md + README (Jira adapter profile, trust posture)
- [x] Verify: `docker compose exec app npm test` and `npm run typecheck` green

## Review
Files: src/{core,workflow,jira,workspace,agent,orchestrator,cli}.ts, test/*.test.ts + fixtures/fake-claude.mjs,
WORKFLOW.example.md, README.md, package.json, tsconfig.json, compose.yaml.

Commands run (container `app`, node 24.22): `npm install`, `npm test` (21/21 pass), `npm run typecheck` (tsc 7.0.2, clean),
example WORKFLOW render, CLI startup validation (missing secret → exit 1), tracker tool scoping (other key → refused).
Host: one 2-turn `claude -p --model haiku` smoke test confirming stream-json `result` shape and `--session-id` → `--resume` continuity.

Not verified: real Jira Cloud calls (no credentials here), a real end-to-end ticket run.
Bug found by tests: workspace containment rejected sanitized keys starting with `..` (e.g. `.._x-<hash>`); fixed to compare path segments.

## Round 2 — local tracker (no Jira/GitHub)
- [x] src/local.ts — `tracker.kind: local`, one markdown file per ticket, YAML header for state/labels/blockers
- [x] TrackerTools interface; cli selects adapter by kind; per-kind default states moved into workflow.ts; `Config.workflowDir`
- [x] bin/symphony-tracker wrapper (fixes `$SYMPHONY_TRACKER` being a shell-quoted string that broke when expanded unquoted)
- [x] WORKFLOW.example.md is now the local board; Jira example moved to WORKFLOW.jira.example.md; README local adapter profile

Verified: 27/27 tests, typecheck clean, and a real CLI end-to-end in the container (local board → orchestrator →
fake agent calling `$SYMPHONY_TRACKER` → ticket moved to Human Review + comment; unlabeled ticket ignored).
The first end-to-end run exposed the quoting bug plus the runaway continuation loop (20 turns, re-dispatched every ~1s while the ticket stays active).

## Round 3 — dashboard (SPEC 13.7)
- [x] `server.port` config + `--port` CLI flag; src/server.ts (127.0.0.1, Host check, 404/405 JSON envelope)
- [x] Orchestrator snapshot/issueDetail/requestRefresh; per-run event ring buffer (hook chatter filtered); recent outcomes; rate limits
- [x] src/dashboard.html — single-file client polling /api/v1/state every 2s, row click → detail + events, "Poll now"
Verified: 28/28 tests, typecheck clean; live API in container during a real CLI run (running row, events, rate limit, totals);
UI rendered in Chrome from captured API snapshots (container doesn't publish ports).
- [x] Round 4: agent.blocked_state — exhausted max_turns → comment + transition to Blocked; parked fallback if transition fails (30/30 tests)

## Round 5 — Linear-style board
- [x] Board tab: state columns, cards (key, priority, labels, agent status, turn-budget strip), drag to move, New ticket dialog, ticket panel (status, description, comments, live agent events, add comment); old tables → Activity tab
- [x] API: GET /api/v1/board, POST /api/v1/tickets, POST /api/v1/tickets/:id/{state,comments}; JSON + same-origin guard, 100KB body cap
- [x] LocalTracker.create (next `<prefix>-N`, `wx` flag); `board.columns` config
Verified: 33/33 tests, typecheck; UI clicked through in Chrome against a stateful API stub (create, drag, panel, comment layout).
Not verified: phone-width layout (window resize didn't apply), light theme screenshot.

## Round 6 — shopware_latest on the main stack
- [x] `workspace.shared` (never created/deleted, concurrency forced to 1) + test (34/34)
- [x] ~/symphony-board/WORKFLOW.md: before_run guards (web container running; no uncommitted tracked changes off the agent branch), agent/<ID> branch from upgrade/v6.7.13.0, after_run returns to base when clean; Shopware prompt (container-only commands, no destructive DB ops, git add specific paths)
- [x] User: stop aemwebshop + `make up` in shopware_latest; commit/stash the 3 tracked changes; restart Symphony (confirmed 2026-10-25)

## Round 7 — Linear-style board
- [x] Linear layout: Inter, status icons per state, cards (key, icon+title, priority/agent/labels, Updated date), column ⋯ (hide) and + (new issue in column), hidden-columns list (counts, click to show, drop to move), Filter, `c` shortcut, theme toggle (system/light/dark)
- [x] board.hidden_columns + board.title; dashboard.html served per request; WCAG AA greys
- [x] ~/symphony-board: Linear states (Backlog/Todo/In Progress/Human Review + Rework/Merging/Blocked/Done/Canceled/Duplicate); Rework + Merging flows in prompt
- Verified: 35/35 tests, typecheck, preview in Chrome (dark + light, new-issue dialog), live restart with 0 running agents

## Round 8 — issue detail as centered modal
- [x] Side panel → centered <dialog> (1080px, two columns: reading column max 720px + 300px properties sidebar: Properties / Agent / Details); full-screen single column under 720px; Esc/×/backdrop close
- [x] Inline `code` and **bold** rendering in description, comments, agent activity; Linear-style dates
- [x] Bug: LocalTracker atomic rename reset birth time → created_at drifted to last write. Now `created:` is written on create and stamped on first rewrite (test added, 36/36)
- Verified live in Chrome (dark + light) on DEV-1/DEV-2; restarted Symphony with 0 running agents

## Round 9 — concurrency hardening (Codex review findings 1–3)
Branch `fix/concurrency-hardening`. Baseline in container: 36/36.
- [x] core.ts `lockFile(path, waitMs)`: `open wx` + our pid; a lock whose pid is dead (or garbage) is stale and taken over
- [x] local.ts: `comment`/`transition` go through `update()` — per-ticket `<ID>.md.lock`, re-read inside the lock (fixes lost updates + same-pid tmp-name clash)
- [x] orchestrator.ts: `start()` takes a no-wait service lock (tmpdir, keyed on shared checkout ?? workspace root) before first dispatch; `stop()` releases. cli.ts: stop the orchestrator if the dashboard port fails
- [x] core.ts `orphanGuard()`: shell prefix on agent turns + hooks; SIGKILLs the process group ~1s after the service dies
- [x] Tests first (red), then green: concurrent comments+transition, stale/live lock, second service refused, killed service takes its agent down
- [x] Verify: `docker compose exec app npm test` + `npm run typecheck`
Review — files: src/{core,local,orchestrator,cli,agent,workspace}.ts; test/{local,orchestrator,agent}.test.ts, test/fixtures/orphan-parent.mjs.
Commands (container `app`): `npm test` 40/40, `npm run typecheck` clean; agent.test.ts 3× stable; no leftover watcher processes.
Red first: old local.ts fails the concurrency test with `ENOENT rename ABC-1.md.<pid>.tmp` (same-pid tmp clash); without the
service lock the second orchestrator starts (test hangs on its timer); without the guard the `bash -lc` agent outlived a SIGKILLed parent.
Not covered: two services on one local board with *different* workspace roots (lock is keyed on the workspace); a human editing the .md
in an editor mid-write; pid reuse within the guard's 1s poll.

## Round 10 — handoff checks gate (ported from orchestrator-astra)
Goal: "Human Review" means the orchestrator ran the project's checks and they passed. The agent saying so isn't enough.
Branch `feat/handoff-checks`, in worktree `../symphony-handoff-checks` off `main` (9c7622f), so it stays clear of the Codex session in the main checkout.

Config (front matter, all optional; no `commands` = current behaviour, unchanged):
```yaml
checks:
  commands:                      # each runs via runHook (bash -lc, orphan guard, process-group kill) in the workspace
    - docker compose exec -T web vendor/bin/phpunit
  handoff_state: Human Review    # default "Human Review"; validated as not active and not terminal
  timeout_ms: 600000             # per command, default 600000
```

Flow (orchestrator side, outside the agent's control):
1. After each turn in `runWorker`, refetch the issue. If it's in `handoff_state` and checks are set, run them in order and stop at the first failure.
2. **Pass**: comment `Symphony checks passed at <git HEAD sha>` with the command list, then return. The release path is the same as today.
3. **Fail**: comment with the failing command and the tail of its output, transition back to the ticket's last active state
   (`e.issue.state`), then run the next turn **on the same session** with a prompt containing the failure output. Counts toward `max_turns`.
   Running out of turns goes through the existing `block()` path, to `Blocked`.
4. `reconcile()` no longer stops a run whose issue is in `handoff_state` while checks are set, so the worker owns the gate.
5. Stall detection skips a run while its checks are running (`checking` flag). Checks have their own timeout, and `lastMessage` reads "Running checks" on the board.

Files: src/workflow.ts (Config.checks + validation), src/workspace.ts (`runHook` resolves with its output tail, so callers can read the sha;
existing callers ignore the value), src/orchestrator.ts (gate, reconcile, stall skip, failure prompt), test/orchestrator.test.ts,
test/workflow.test.ts, README.md (front matter table + Features), WORKFLOW.example.md / WORKFLOW.jira.example.md (commented `checks:` block, prompt mentions the gate).

- [x] workflow.ts: parse + validate `checks`; tests for defaults, and for a handoff_state that's active or terminal being rejected
- [x] workspace.ts: `runHook` returns `Promise<string>` (the output tail)
- [x] orchestrator.ts: gate in runWorker, `checksFailedPrompt`, reconcile exemption, `checking` stall skip
- [x] Tests (red first): pass → evidence comment with sha and claim released; fail → comment + transition back + next turn uses `--resume`
      and its prompt contains the failure; fail every turn → Blocked; a check longer than stall_timeout isn't killed; no `checks` → unchanged (existing tests stay green)
- [x] Docs: README + both example workflows
- [x] Verify: `docker compose exec app npm test` + `npm run typecheck`

Not ported from astra (deliberately):
- Revision numbers: Jira already serializes edits, and a local ticket is guarded by its file lock.
- SQLite store / crash recovery: the tracker is the source of truth (SPEC).
- Saved patch and digest: the pushed branch plus the checked sha cover it.
- Checks that must not modify the tree.
- Checks when a human drags a ticket to Human Review: only agent runs are gated.

### Review
Files: src/workflow.ts, src/workspace.ts, src/orchestrator.ts, test/orchestrator.test.ts, test/workflow.test.ts, README.md, WORKFLOW.example.md, WORKFLOW.jira.example.md.
Ran in the symphony-handoff container: `npm test` 45/45 pass (baseline 40), `npm run typecheck` clean.
Red first: the 4 new orchestrator tests timed out in waitFor and the workflow test threw on `cfg.checks` being undefined, before any src change.
Not covered: the sha path (tests run in a non-git workspace), a check being aborted mid-run by shutdown, tracker without a transition tool (throws, worker retry path).

### Review: fix round
Three review bugs fixed, each with a red test first (45 -> 48 tests, all pass; typecheck clean):
- reconcile's handoff exemption set `e.issue`, so a mid-turn tick made a failed gate transition back to Human Review (red: `transition ABC-1 Human Review`). It now leaves `e.issue` alone.
- an abort during checks was reported as a check failure (red: bogus "Check failed" comment + transition on `orch.stop()`). Aborted runs now rethrow.
- handoff_state validation ran with no `checks.commands` (red: `Human Review` in terminal_states failed to load). Now only validated when commands are set.
Also: the failure-path refetch keeps `e.issue` if the issue vanished.
Live smoke (2026-10-25, host Symphony from the worktree, sandbox board + throwaway repo, `claude --model haiku`): DEV-1 →
check 1 failed ("must contain exactly one line: Hello, Symphony!") → failure comment → turn 2 resumed the SAME session
(1 dispatch, 1 session id) → agent fixed + committed → both checks passed → comment `checks passed at a54c634…`, which matches
the workspace HEAD with a clean tree → ticket stayed in Human Review. 2 turns, 19 s. Merged to main (ff), 48/48 + typecheck in `app`.
Live service restarted on the merged code (2026-10-25 15:28), and ~/symphony-board/WORKFLOW.md now has a `checks:` block.


## Plan — project-local symphony-linear initialization

Implementation authorized by the user after confirming provider and per-ticket base-branch choices.

Confirmed requirements:
- Globally installed Node CLI named `symphony-linear`; existing local markdown board, no Linear integration.
- `symphony-linear init .` initializes the selected project and starts a background instance.
- Project-local configuration, tickets, worktrees, logs and runtime metadata live under `.symphony-linear/`.
- Agents work in isolated per-ticket Git worktrees. Provide start/stop/status commands.
- Host Node is allowed for end users; development Node/npm/typecheck/test commands remain container-only.

Proposed behavior:
- Share the installed application code; do not copy the application or node_modules into each project. Git worktree administrative metadata necessarily lives in Git's own directory.
- Require an existing Git checkout with a commit. Resolve the selected directory to a canonical project identity; reject ambiguous nested selections with a useful message.
- Add `/.symphony-linear/` to the project root .gitignore without overwriting its contents. Verify effective ignore rules before writing state; reject already tracked state, without automatically untracking user files. Ignore rules prevent ordinary staging, not force-add.
- Generate WORKFLOW.md, tickets/, worktrees/, logs/ and runtime metadata. Repeated init preserves existing configuration/tickets and reports an existing healthy instance.
- Bind the dashboard to 127.0.0.1 with port 0 so the OS allocates a free port. Persist and print the actual URL only after startup succeeds.
- One instance per canonical project; different projects run independently. Protect concurrent start/init; verify instance identity before stop, handle stale state, and wait for readiness/shutdown.
- Generate worktree creation/removal through Git; preserve dirty worktrees and review branches. No automatic remote push or merge. Adjust example agent prompt to worktree semantics.
- Preserve the existing explicit-workflow CLI for compatibility. No project-language detection or automatic dependency installation in v1.

Confirmed ticket settings:
- Claude is the workflow default. Reuse existing per-ticket Claude/Codex and model selection; no init-time provider question or automatic fallback. Provider changes apply to the next attempt, not an already running session.
- Add a per-ticket starting/base branch selector to creation and ticket details before the first dispatch. Keep this separate from the existing `branch`/`branch_name` field: the base branch is the source, while each agent works on its own ticket branch.

Proposed branch semantics:
- Initialize a project default base branch from the checked-out branch; allow overriding it in WORKFLOW.md. On detached HEAD, require an explicit base branch.
- Offer local and already fetched remote-tracking branches; do not automatically fetch. Resolve and validate the chosen ref in the selected project at worktree creation, using argument-safe Git invocation.
- Store the choice as `base_branch` on local tickets. At first dispatch, record the resolved commit and create the ticket branch/worktree from it. Existing ticket worktrees are reused on retries and rework; never silently reset/rebase them when the base moves.
- Make the base choice read-only after workspace creation. Missing/deleted branches produce an actionable ticket failure without falling back to another branch.
- Ignore uncommitted changes in the primary checkout; no auto-push or merge.

Implementation sequence:
- [x] CLI packaging and project initialization; generated workflow and safe ignore handling.
- [x] Ticket base-branch field, branch listing/validation, dashboard selector and API persistence.
- [x] Git worktree lifecycle and prompt, including dirty workspace preservation.
- [x] Background lifecycle, project lock, readiness, dynamic port and status URL.
- [x] Docs and focused integration tests, then full tests/typecheck in an isolated container.

Scope: package.json, src/{core,local,workflow,dashboard.html} for ticket base-branch configuration/UI, src/cli.ts, small project/lifecycle module(s) as needed, src/workspace.ts, src/orchestrator.ts (locking/cleanup), src/server.ts (bound address as needed), generated workflow template, bin launcher if needed, tests/fixtures and README. Reuse LocalTracker, config loader, dashboard, process handling and server port-0 support.

Validation: two projects simultaneously; repeat/concurrent init; occupied ports; startup failure/stale metadata; unrelated-process stop protection; paths with spaces; .gitignore preservation and already tracked state; worktree branch/base and safe cleanup; branch persistence, invalid refs, moved/deleted bases, retry/rework preservation and provider override/default; existing explicit-workflow behavior. Use fake agent CLIs, no paid agent dispatch.

Limits/risks: Git ignore is not an absolute commit prohibition; Git worktrees share repository metadata and are not security sandboxes. Provider authentication and sandbox access to shared Git metadata/local board need validation. Local ignored tickets are not backed up by Git. Runtime port may change after restart.


### Project initialization — implementation and verification

Implemented the global `symphony-linear` alias with init/start/stop/status, authenticated background lifecycle,
OS-selected localhost ports, ignored project-local state, Claude defaults and per-ticket provider/model selection.
Added local/remote-tracking base branch selection, immutable starting commit metadata, Git worktree creation,
retry/rework reuse and safe removal that retains branches and refuses dirty trees. Failed setup hooks retry
before dispatch. Deleted ticket branches fail instead of silently recreating from the old base.

The packaged JS launcher uses Node's type-stripping API only for this package's own TS files, including
background children and tracker tools; this fixes global npm installs under node_modules without a build.
Codex project attempts receive writable roots for the local ticket directory and shared Git metadata.
The development image now includes Git for actual worktree integration tests. Stale lock recovery is
serialized to prevent two concurrent starters from reclaiming the same dead lock and dispatching twice.
An interrupted recovery guard requires inspection rather than unsafe automatic takeover.

Verification (isolated symphony-project-init container):
- Full suite: 71/71 passed; TypeScript typecheck clean; git diff --check clean.
- npm pack + global install into /tmp/symphony-installed succeeded.
- All 10 project tests also passed using the globally installed command, including both fake-provider
  end-to-end runs that commit on the selected branch and update tickets through the installed tracker tool.
- Dashboard script parses; branch selection and locking verified through HTTP API.

Not checked: visual browser interaction, real authenticated Claude/Codex runs, platform-specific sandbox
policy behavior, or Windows (the project requires Bash/POSIX process handling). No host Node/npm commands,
no global host installation, no push, no merge, and no edits to the main checkout.


### Interactive installed-package test — 2026-10-26

Tested the globally installed tarball in Chrome through a localhost-only proxy to a disposable
container project with a space-containing path. Used fake Claude/Codex CLIs, actual Git worktrees,
actual commits and the installed tracker helper.

Passed:
- New-ticket form defaults to Claude and exposes local base branches.
- Created a Codex ticket from release; changed its base branch before dispatch.
- Unsaved provider changes disable status transitions, including while saving a branch change.
- Dispatched from the UI; ticket reached Human Review with its comment and locked base selector.
- Created and dispatched a second ticket using default Claude; it also reached Human Review.
- Git graph confirms both ticket commits descend from release, not the newer main commit.
- Visually inspected the rendered ticket panel; no layout issue observed. No browser console errors.
- Stopped/restarted the daemon: new port allocated, both tickets/providers persisted in the UI.

No code changes were needed. This supersedes the earlier untested-browser limitation. Real
provider authentication/inference and platform-specific sandbox enforcement remain untested.
Stopped the disposable service and removed its test container after verification.


## Setup documentation

- [x] Add docs/SETUP.md: prerequisites, agent install/authentication, local checkout or tarball install, project initialization, setup/check hooks, first ticket, branch review/rework, lifecycle, multiple projects and troubleshooting.
- [x] Replace README setup duplication with a quickstart and link to the guide; distinguish dynamic project ports from standalone fixed ports.
- [x] Include the guide in npm package files so README links work after installation.
- [x] Check Markdown links, package file inclusion and diff whitespace against current CLI behavior.

Scope: README.md, docs/SETUP.md, package.json and this task log. Documentation only; no runtime behavior changes.

Validation: relative Markdown files/anchors and code fences checked with Python; package files include the guide and AGENTS.md; git diff --check clean. Agent installation/sign-in instructions checked against official provider documentation. No runtime tests rerun for this documentation-only change.

## Dashboard redesign — Linear-style workspace

User requested Impeccable and confirmed balanced attention to board clarity, ticket details and activity.
Used the official Impeccable skill from a temporary checkout; the visual brief is the existing Linear-style product UI.

- [x] Inspect dashboard renderers, event handlers, server and board tests; retain API and tracker contracts.
- [x] Redesign navigation, board, ticket details, creation form and activity with one shared visual vocabulary.
- [x] Preserve system/light/dark themes, keyboard operation, filtering, drag/drop, hidden columns and ticket settings.
- [x] Verify desktop/mobile renders, interactive workflows, full tests and typecheck in isolated symphony-dashboard container.

Scope: src/dashboard.html, product/design context and this log. No framework or runtime dependency additions.
Direction: daily-use operation; quiet cool neutrals, DM Sans, compact persistent navigation, distinct content/lanes,
clear issue titles and restrained semantic color. Mobile moves navigation to the top and keeps board scrolling local.
Main risks: layout clipping, theme contrast, tab/focus regressions and unsaved ticket settings during polling.

### Dashboard redesign review and validation

- 73/73 tests passed, including two new regression tests covering saved views, headings, roving tab focus and keyboard navigation.
- TypeScript typecheck and git diff --check passed. All Node/npm commands ran in symphony-dashboard container.
- Actual browser smoke against disposable local tickets: filter/no-match state, view click/Home navigation, issue creation with Codex/model,
  agent save/dirty-state guard, comment posting, status transition, drag/drop, column hiding/restoring and light/dark theme switching passed.
- Inspected desktop (1512px), mobile (390px) and narrow (320px); fixed 320px navigation overflow. No browser console errors observed.
- Official Impeccable detector ran once: dark action-button contrast fixed; footer/native-dialog padding findings reviewed as false positives.
- Independent Impeccable finish reviewer found faint enabled lane creation labels; removed opacity and used higher-contrast text.
  Same five view captures recaptured and reviewer returned ship. Evidence: .impeccable/review/.
- Impeccable launcher was initially unavailable; used its documented direct-context fallback and honored the user-pinned Linear direction.
  No seed/decision-comp round was performed. Product and design context recorded in PRODUCT.md and DESIGN.md.

Limits: populated activity tables were not visually exercised; real Jira/provider authentication and paid inference were not tested.
Preview uses synthetic local tickets on http://127.0.0.1:4567, without starting orchestration. No push or merge.

## Standardize dropdown fields

- [x] Inspect every select/model field in creation and issue detail, including branch locking and agent-save handlers.
- [x] Share field height, border, chevron, padding, focus, disabled and option-menu styling; wrap bare branch select.
- [x] Align creation labels/model inputs and verify desktop/mobile, light/dark and field interactions.

Scope: src/dashboard.html CSS and branch-field markup; no API, selection semantics or dependencies change.

Dropdown verification: 73/73 tests and typecheck pass in symphony-dashboard container; git diff --check clean.
Chrome desktop/dark and 390px mobile/light: selected values, provider-dependent model suggestions, dirty-agent
status disabling, shared 36px control heights, visible focus, themed open menus and no dialog horizontal overflow.
No console warnings/errors. Branch select now shares the same wrapper; its API/locking regression tests pass.
Progressive CSS base-select enhancement themes option menus where supported; older browsers retain native pickers.
Model remains an editable datalist field with matching field chrome. Safari/Firefox and branch field browser interaction
were not exercised. No new logic/dependencies or API changes. Evidence: .impeccable/review/dropdowns-*.png.

## Ticket activity and review feedback

- [x] Record local status moves atomically in the existing comment thread, through both board and agent callers.
- [x] Describe provider tool events in English; retain bounded recent activity after handoff and during rework.
- [x] Preserve repeated comment sections and make older retained model activity available.
- [x] Cover transitions, event summaries, completed activity and fresh review dispatch; document context/session behavior.

Scope: local tracker, agent event summaries, orchestrator detail/history, dashboard, setup guide and focused tests. No new dependencies or session-resume policy changes. Status/comments remain in ticket files; streamed activity stays bounded in daemon memory.

Validation: 77/77 tests passed and typecheck clean in symphony-ticket-review-comments container; git diff --check clean. Regression coverage includes board/agent status writes, no-op transitions, comment preservation, readable tool summaries, repeated comment headings, retained handoff activity, fresh session feedback and workspace reuse. Updated existing exact-body assertions for the new status entries.

Limits: no real provider inference or visual browser smoke; no merge, push or deployment. Previously discarded streamed events cannot be recovered. Stream history is retained only in bounded daemon memory; Jira comment fetching remains unchanged.

## Compact review context

- [x] Ask local agents to post a concise, cumulative handoff in the existing ticket comment thread.
- [x] Render local first-turn prompts with original requirements, latest handoff and all newer comments; preserve full history if no handoff exists.
- [x] Keep ticket storage, dashboard history, fresh sessions and workspace reuse intact.
- [x] Test parsing/fallback, both providers' review dispatch and persistence across daemon restart; update docs.

Scope: small prompt helper, orchestrator first-turn caller, tests and setup guide. No session persistence, added model calls, dependencies or Jira behavior changes. Handoffs must carry unresolved feedback and requirement changes forward; do not truncate summaries or feedback.

Validation: 83/83 tests and typecheck passed in the isolated task container. Covered newest-checkpoint selection, original requirements and all newer feedback, missing/empty/misplaced handoff fallback, CRLF/repeated sections, unchanged stored history, persisted tracker rereads and fresh daemon review dispatch for both Claude and Codex. Long-history test prompts shrink to less than one fifth of the original without an additional model call.

Limits: local timestamped comments only; agents must write a cumulative handoff for compaction to apply. No real model runs or measured billing savings. No hard truncation of feedback or summaries. Full historical comments remain accessible in the ticket file/dashboard. Not merged, pushed or deployed.

## List running project instances

- [x] Add `symphony-linear list`, usable from any directory, with PID, URL and canonical project path.
- [x] Discover existing background daemons through the process table and reuse readInstance/control to verify identity.
- [x] Exclude stale, malformed and unresponsive records; omit private control tokens.
- [x] Test empty/multiple instances, paths with spaces, stop/restart and invalid arguments; document scope and verify tests/typecheck.

Scope: src/cli.ts and src/project.ts, project tests, README/setup guide and development image (procps supplies ps on slim Linux). No registry, filesystem scan, new runtime npm dependencies or lifecycle policy changes. Lists background project instances visible on this machine; standalone foreground workflows remain outside the project lifecycle.

Validation: 84/84 tests passed, typecheck and git diff --check clean in symphony-list-instances container. The shipped bin launcher lists two actual authenticated background projects from outside a Git checkout, preserves paths with spaces, hides tokens, and reflects stop/restart. Fake daemon processes verify missing/corrupt metadata, PID mismatch and a non-Symphony endpoint are omitted without stopping the processes.

Limits: macOS runtime discovery not exercised; Linux integration passed. Foreground standalone workflows, other process namespaces and newline-containing paths are outside discovery scope. No host Node/npm commands, installation, merge or push.


## Open project dashboard

- [x] Open the ready dashboard after init/start, including an already running instance.
- [x] Add open [project], validate instance identity, and refuse stopped projects.
- [x] Cover launcher success/failure and lifecycle behavior; update help and setup docs.
- [x] Run tests and typecheck in symphony-open-dashboard container.

Scope: project lifecycle, CLI routing/help, project tests, README and setup guide. Use macOS open/Linux xdg-open without a dependency; browser launch failure prints a manual URL and preserves the daemon. No standalone workflow or server changes.

Validation: 85/85 tests passed and typecheck clean in the isolated symphony-open-dashboard container; git diff --check clean. A fake platform launcher fetches the dashboard before recording its URL, covering init/start/open, existing-instance reuse, stopped-project refusal, argument validation and launcher failures without terminating the daemon.

Limits: actual macOS/Linux desktop browser launch was not exercised; Linux uses xdg-open and macOS uses open. No new dependency, host Node/npm command, global installation, merge or push.


## Investigate startup ExperimentalWarning

- [x] Reproduce the warning through the shipped bin/symphony.mjs launcher in Node 24.22.1.
- [x] Trace it to the packaged-source load hook calling node:module stripTypeScriptTypes.
- [x] Verify background lifecycle using the shipped launcher.

Finding: this is Node's experimental-API notice, emitted by the public stripping API even though native TypeScript execution is stable. The hook is needed for globally installed source under node_modules. No runtime fix is required by the warning alone; keep warnings visible rather than adding a process-wide suppression or a build dependency.

Validation: all 12 project integration tests passed with SYMPHONY_TEST_CLI=/app/bin/symphony.mjs in the isolated container, including actual background readiness, status, stop/start, browser launching and both fake-provider dispatches. No runtime code changed; real provider runs and the user’s host process were not inspected.


## Default symphony-linear to help

- [x] Route argument-free symphony-linear to the existing help text while preserving symphony's default WORKFLOW.md execution.
- [x] Cover both executable aliases with real symlinks to the packaged launcher.
- [x] Verify project tests, typecheck and whitespace in the isolated container.

Scope: CLI entrypoint, one regression test and task notes; no launcher, configuration or workflow changes.

Validation: 13/13 project tests passed, typecheck and git diff --check clean. Alias regression uses real symlinks from outside a project and confirms argument-free output matches --help exactly; symphony still attempts WORKFLOW.md. Full suite not repeated for this routing-only change; no host global reinstall, merge or push.


## Local merge verification

Rebased feat/open-dashboard onto current main before merging. Full suite: 86/86 tests passed; typecheck and git diff --check clean in the isolated symphony-open-dashboard container. Reviewed CLI routing, shared browser launcher, readiness/failure behavior, regression tests and documentation. Desktop browser launch remains untested; no global installation or remote push.
