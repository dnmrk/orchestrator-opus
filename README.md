# Symphony (Claude Code)

An implementation of [openai/symphony `SPEC.md`](https://github.com/openai/symphony/blob/main/SPEC.md):
a daemon that polls a ticket board (local markdown files, or Jira), gives every eligible ticket its own workspace, and runs Claude Code
headless in it until the ticket leaves an active state (e.g. moves to `Human Review`).

Differences from the spec: the coding agent is Claude Code (`claude -p --output-format stream-json`)
instead of Codex app-server, so the front-matter key is `claude` instead of `codex`. A spec "turn" is
one `claude -p` invocation; continuation turns use `--resume <session>` on the same session. SSH
workers (Appendix A) are not implemented.

![Board with a running agent, a retry, and tickets waiting for review](docs/screenshots/board.jpg)

## Features

**Orchestration (SPEC core)**
- Polls the tracker, dispatches eligible tickets by priority and age, and respects `blocked_by`,
  `required_labels`, and global and per-state concurrency limits.
- Runs multi-turn Claude Code sessions. Turn 1 renders the Liquid prompt, and later turns `--resume`
  the same session with a continuation prompt.
- Reconciles every tick. A ticket that leaves an active state stops its agent, and a silent agent
  is killed after `stall_timeout_ms`.
- Retries failures with exponential backoff, and continues 1 s after a clean exit if the ticket is
  still active.
- A ticket that uses up `max_turns` gets a comment and moves to `Blocked`, so it can't loop forever.
- Hot-reloads `WORKFLOW.md`. An invalid edit pauses new dispatch and keeps the last good config.

**Trackers**
- **Local**: one markdown file per ticket, with a YAML header and the body as description.
  There are no services to run.
- **Jira Cloud**: REST v3 with token paging, blockers from issue links, and ADF flattened to text.
- Agents update their own ticket through `$SYMPHONY_TRACKER comment|transition`, which is scoped to
  the dispatched key.

**Workspaces**
- Each ticket gets its own directory under `workspace.root`, with `after_create`, `before_run`,
  `after_run`, and `before_remove` hooks.
- `workspace.shared` mode runs every ticket in one existing checkout, such as a Docker-mounted
  Shopware project, one agent at a time.

**Dashboard** (local-only, no build)
- A Linear-style board with drag-and-drop moves, configurable and hidden columns, a filter,
  `c` for a new issue, and system, light, and dark themes.
- An issue view showing the description, live agent activity, comments, and properties.
- An Activity tab with running agents, the retry queue, recent runs, tokens, cost, and agent time.
- A JSON API (SPEC 13.7). Writes are protected against cross-site requests and DNS rebinding.

**Footprint**: Node 24 runs the TypeScript directly with no build step. The only runtime
dependencies are `yaml` and `liquidjs`, and the test suite fakes `claude` (`test/fixtures/fake-claude.mjs`).

## Run

Local board, no external services:

```bash
mkdir -p ~/symphony-board/tickets
cp WORKFLOW.example.md ~/symphony-board/WORKFLOW.md    # set the clone path in after_create
cat > ~/symphony-board/tickets/DEV-1.md <<'EOF'
---
state: To Do
title: Add a health-check endpoint
labels: [agent]
---
Return 200 with {"ok": true} on GET /health. Add a test.
EOF
node src/cli.ts ~/symphony-board/WORKFLOW.md
```

The agent clones your local repo, works on `agent/DEV-1`, pushes the branch back, comments on the
ticket file, and sets `state: Human Review`. To send it back, set `state: Rework`; to clean its
workspace, set `state: Done`. For Jira, start from `WORKFLOW.jira.example.md`.

Needs Node ≥ 24 (TypeScript runs via native type stripping, no build), plus `claude`, `git`, and
`gh` on `PATH`. Logs are JSON lines on stdout; `SYMPHONY_LOG_LEVEL=debug` adds every agent event.
`WORKFLOW.md` is re-read on change. An invalid edit pauses dispatch and keeps the last good config.

## Dashboard

Set `server.port` in WORKFLOW.md (the local example uses `4555`) or pass `--port 4555`, then open
<http://127.0.0.1:4555/>.

- **Board**: one column per state in `board.columns`. The default is the active states,
  `Human Review`, the blocked state, then the terminal states.
  - `board.hidden_columns` collapse into a side list that shows counts and accepts drops. Click one
    to show it, and use a column's ⋯ menu to hide it again. These choices are saved per browser.
  - Drag a card to change its state.
  - Use **New issue**, a column's **+**, or `c` to create a ticket (local tracker only).
    "Let an agent pick this up" adds `required_labels`.
  - Cards show priority, labels, and an agent chip: the turn while it runs, or the retry countdown.

  ![Board in dark theme](docs/screenshots/board-dark.jpg)

- **Issue view**: click a card to see the description, live agent activity, the comment thread,
  and a comment box. The sidebar has status, priority, labels, the agent state, the workspace,
  and the ticket file. Esc, ×, or a backdrop click closes it.

  ![Issue view with an agent working](docs/screenshots/issue.jpg)

- **Activity**: running agents, the retry queue, recent runs, and token, cost, and agent-time totals.

  ![Activity tab](docs/screenshots/activity.jpg)

Screenshots use demo data.

Board writes (`POST /api/v1/tickets`, `/api/v1/tickets/<id>/state`, `/api/v1/tickets/<id>/comments`)
require `Content-Type: application/json` and a same-origin `Origin`, so another website you visit
can't create work for an unattended agent. It binds to 127.0.0.1 only and rejects non-local `Host` headers. JSON API (SPEC 13.7):
`GET /api/v1/state`, `GET /api/v1/<ticket>`, `POST /api/v1/refresh` (poll now). Changing the port
needs a restart.

Development (inside the container): `docker compose up -d && docker compose exec app npm test` / `npm run typecheck`.

## Front matter (beyond the spec's core keys)

| key | default | notes |
|---|---|---|
| `board.columns` / `board.hidden_columns` / `board.title` | active states, `Human Review`, blocked, terminal / `[]` / board dir name | Linear-style board: visible columns, the collapsible "Hidden columns" list (counts, drop targets, click to show), and the header title |
| `workspace.shared` | — | run every ticket in this existing directory (e.g. a Docker-mounted project checkout) instead of per-ticket workspaces; never created or deleted, forces `max_concurrent_agents` to 1 (deviation from SPEC 9) |
| `agent.blocked_state` | `Blocked` | ticket that used all `max_turns` while still active gets a comment and moves here instead of being re-dispatched (deviation from SPEC 7.1); if that move fails it is skipped until its state changes |
| `claude.command` | `claude` | launched via `bash -lc` in the workspace |
| `claude.model` | — | passed as `--model` |
| `claude.permission_mode` | `bypassPermissions` | passed as `--permission-mode` |
| `claude.allowed_tools` | `[]` | passed as `--allowedTools` |
| `claude.turn_timeout_ms` | `3600000` | |
| `claude.stall_timeout_ms` | `300000` | `<= 0` disables; no events during a long Bash call count as a stall |

Hooks and the agent get `SYMPHONY_ISSUE_IDENTIFIER` and `SYMPHONY_WORKSPACE`. The agent also gets
`SYMPHONY_ISSUE_ID`, `SYMPHONY_WORKFLOW`, and `SYMPHONY_TRACKER`.

## Local adapter profile (SPEC 11.2)

- **kind:** `local`. **provider keys:** `dir` (default `tickets`, relative to WORKFLOW.md, `~`/`$VAR` ok),
  `prefix` (default `DEV`; the board creates `<prefix>-<next number>.md`). No secrets.
- **default states:** active `To Do`, `In Progress`; terminal `Done`.
- **scope:** every `*.md` in `dir` except `README.md`. Filename without `.md` = `id` = `identifier`
  (must match `[A-Za-z0-9._-]+`). `native_ref` = `{path}`; `url` = `file://` URL.
- **header fields:** `state` (required), `title` (or the first `# heading`), `priority` (int),
  `labels`, `blocked_by` (ticket ids), `assignee`, `branch`, `created` (else file birth time).
  The body (including `## Comments`) is the description.
- **dispatchable:** every `blocked_by` ticket exists and is in a terminal state.
- **malformed:** missing state/title or bad YAML → skipped with a warning when listing; fails ID refresh.
- **agent tools:** `transition` rewrites `state:` (keeps your YAML comments); `comment` appends a
  timestamped entry under `## Comments`. Writes are atomic (temp file + rename).

## Jira adapter profile (SPEC 11.2)

- **kind:** `jira`, Jira Cloud REST v3, basic auth (email + API token).
- **provider keys:** `base_url` (required, http(s), env fallback `JIRA_BASE_URL`), `project` (required
  project key), `jql` (optional, ANDed onto the scope), `email` / `api_token` (secrets, accept
  `$VAR`, env fallback `JIRA_EMAIL` / `JIRA_API_TOKEN`; empty = missing).
- **default states:** active `To Do`, `In Progress`; terminal `Done`.
- **scope & paging:** `project = "<project>" [AND (<jql>)]` via `POST /rest/api/3/search/jql`, 100 per
  page with `nextPageToken`, up to 100 pages (more → `tracker_pagination`). ID refresh uses
  `id in (...)` in chunks of 100. If Jira rejects that list because an id is gone (HTTP 400), it falls
  back to one query per id and leaves out the missing ones.
- **mapping:** `id` = numeric issue id; `identifier` = issue key; `native_ref` = `{key, project}`;
  `priority` Highest/High/Medium/Low → 1–4, otherwise null; `description` is ADF flattened to text;
  `labels` are lowercased and de-duplicated; `blocked_by` = links whose inward description contains
  "blocked by"; `branch_name` = null.
- **dispatchable:** true when every blocker is in a terminal state.
- **malformed:** records missing id/key/summary/status are skipped (and logged) in state queries.
  They fail ID refresh with `tracker_response`.
- **errors:** `TrackerError.category` is one of `invalid_tracker_config`, `missing_tracker_secret`,
  `unsupported_tracker_kind`, `tracker_request`, `tracker_status`, `tracker_response`,
  `tracker_pagination`, or `tracker_rate_limited`. The message is human-readable.
- **agent tools:** `$SYMPHONY_TRACKER comment <KEY> [text|-]` and
  `$SYMPHONY_TRACKER transition <KEY> <state>`, which matches the target status name or the transition
  name. Both refuse any key other than the dispatched issue.

## Trust posture

This targets **trusted environments**, like upstream. Agents default to `bypassPermissions`, because
an unattended run can't answer permission prompts. They can run anything your user can, with your
`claude` login, git and `gh` credentials, and Docker socket. The only isolation is the per-ticket
directory under `workspace.root`.

Shortcut (Jira only): the agent inherits the host environment, `JIRA_API_TOKEN` included, because the
`$SYMPHONY_TRACKER` tool runs as the agent's child. To keep the token away from the agent, move the
tools behind a local socket owned by the orchestrator.

Use `required_labels` to choose which tickets get picked up, and keep `max_concurrent_agents` low
until you trust the prompt.
