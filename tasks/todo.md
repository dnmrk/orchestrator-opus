# Symphony (Claude Code + Jira port of openai/symphony SPEC.md)

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
- Pending user: stop aemwebshop + `make up` in shopware_latest; commit/stash the 3 tracked changes; restart Symphony

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
