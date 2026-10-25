---
# Local board: no Jira, no GitHub. Suggested layout (keep the board OUT of the code repo,
# otherwise every workspace clone gets a stale copy of the tickets):
#
#   ~/symphony-board/WORKFLOW.md      <- this file
#   ~/symphony-board/tickets/DEV-1.md <- one markdown file per ticket
#
# Run:  node ~/Sites/symphony/src/cli.ts ~/symphony-board/WORKFLOW.md
tracker:
  kind: local
  provider:
    dir: tickets                      # relative to this file
  required_labels: [agent]            # only tickets you explicitly hand over
  active_states: [To Do, In Progress, Rework]
  terminal_states: [Done, Won't Do]
polling:
  interval_ms: 10000
server:
  port: 4555                          # dashboard at http://127.0.0.1:4555/
workspace:
  root: ~/symphony-workspaces
hooks:
  # Clone straight from your local checkout; the agent pushes its branch back into it.
  after_create: |
    git clone /Users/you/Sites/your-project .
    git checkout -b "agent/$SYMPHONY_ISSUE_IDENTIFIER"
  before_run: |
    git fetch origin --quiet
agent:
  provider: claude                    # default for tickets without a choice; claude or codex
  max_concurrent_agents: 1
  max_turns: 10
  blocked_state: Blocked              # where a ticket goes if it uses all turns without a handoff
# checks:                            # Symphony runs these when the agent moves a ticket to the handoff state
#   # docker exec checks only see the agent's code with workspace.shared (your mounted checkout);
#   # per-ticket clones under workspace.root are not mounted in your containers.
#   commands:
#     - docker compose exec -T web vendor/bin/phpunit
#   handoff_state: Human Review
#   timeout_ms: 600000
claude:
  command: claude
  model: opus
  permission_mode: bypassPermissions   # unattended; see README "Trust posture"
  stall_timeout_ms: 900000             # long test suites emit no events
codex:
  command: codex
  model: gpt-6.1-sol                  # tickets can choose another model
  sandbox: workspace-write           # grant external board/remote access explicitly; see README
  stall_timeout_ms: 900000
---

You are working unattended on ticket {{ issue.identifier }}: {{ issue.title }}
Status: {{ issue.state }}

{% if attempt %}
This is follow-up attempt #{{ attempt }}. Resume from the current workspace state; do not redo finished work.
{% endif %}

## Ticket
{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}

## Rules
1. Nobody will answer questions. Do not ask for confirmation or wait for acknowledgment; decide and proceed.
2. Work only inside this repository checkout. Never touch other paths.
3. Run the project's tests and linters before handing off.
4. The ticket is NOT in this repo. Update it only through `$SYMPHONY_TRACKER`:
   - `$SYMPHONY_TRACKER transition {{ issue.identifier }} In Progress`
   - `$SYMPHONY_TRACKER comment {{ issue.identifier }} - <<'EOF'` ... `EOF`

## Flow
1. If the ticket is in "To Do", transition it to "In Progress".
2. Implement the change on the current branch with focused commits.
3. `git push origin HEAD` (pushes the branch back into the local project repo).
4. Comment a short summary: what changed, how it was verified, the branch name.
5. Transition the ticket to "Human Review" (not an active state, so Symphony stops here). If checks are configured, Symphony gates that state: it runs them and moves the ticket back to you with the output if they fail.
6. If truly blocked, comment what is missing and transition to "Blocked".

Your final message reports what was done and any blockers, nothing else.
