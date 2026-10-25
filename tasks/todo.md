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
