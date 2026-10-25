---
# Jira variant. Copy into the target repo as WORKFLOW.md, then:
#   JIRA_EMAIL=... JIRA_API_TOKEN=... symphony path/to/WORKFLOW.md
tracker:
  kind: jira
  provider:
    base_url: https://your-org.atlassian.net
    project: ABC
    # Optional extra JQL ANDed onto the project scope:
    # jql: assignee = currentUser()
    # email / api_token default to $JIRA_EMAIL / $JIRA_API_TOKEN
  required_labels: [agent]          # only tickets you explicitly hand over
  active_states: [To Do, In Progress, Rework]
  terminal_states: [Done, Closed, Won't Do]
polling:
  interval_ms: 30000
workspace:
  root: ~/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 50 git@github.com:your-org/your-repo.git .
    git checkout -b "agent/$SYMPHONY_ISSUE_IDENTIFIER"
  before_run: |
    git fetch origin --quiet
agent:
  max_concurrent_agents: 2
  max_turns: 10
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
---

You are working unattended on Jira ticket {{ issue.identifier }}: {{ issue.title }}
URL: {{ issue.url }}
Status: {{ issue.state }}
Labels: {{ issue.labels | join: ", " }}

{% if attempt %}
This is follow-up attempt #{{ attempt }}. Resume from the current workspace state; do not redo finished work.
{% endif %}

## Ticket
{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}

## Rules
1. Nobody will answer questions. Do not ask for confirmation or wait for acknowledgment; decide and proceed.
2. Work only inside this repository checkout. Never touch other paths.
3. Run the project's tests and linters before handing off.
4. Tracker access goes through `$SYMPHONY_TRACKER` (scoped to this ticket):
   - `$SYMPHONY_TRACKER comment {{ issue.identifier }} - <<'EOF' ... EOF`
   - `$SYMPHONY_TRACKER transition {{ issue.identifier }} "In Progress"`

## Flow
1. If the ticket is in "To Do", transition it to "In Progress".
2. Implement the change on the current branch with focused commits.
3. Push and open a PR with `gh pr create --fill`; link the PR in a ticket comment.
4. Transition the ticket to "Human Review" (the handoff state — not active, so Symphony stops here). If checks are configured, Symphony gates that state: it runs them and moves the ticket back to you with the output if they fail.
5. If truly blocked (missing access, secrets, ambiguous requirements), comment what is missing and transition to "Blocked".

Your final message reports what was done and any blockers, nothing else.
