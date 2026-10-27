# Set up Symphony

Symphony runs a local ticket board and dispatches its tickets to Claude Code or Codex. Install
Symphony once, then initialize each project you want to manage. This guide covers the
`symphony-linear` command and local markdown tickets; no Linear account is needed.

## 1. Check prerequisites

Use macOS or Linux with:

- Node.js 24 or later, including npm.
- Git and Bash available in your shell.
- An existing project Git repository with at least one commit.
- The coding agent you intend to use, installed and authenticated under your user account.
- The project's normal development tools, such as Docker, PHP or Python, if its tasks need them.

Check the basic tools in a terminal:

```bash
node --version
npm --version
git --version
bash --version
```

The commands in this guide are **end-user commands on your machine**. Docker is not required
for the Symphony daemon itself. Contributors developing Symphony must run Node/npm commands
inside their own container, following [AGENTS.md](../AGENTS.md).

## 2. Install and authenticate a coding agent

Claude is Symphony's default provider. Install only Claude if that is all you need; install
Codex too if you want to select it on tickets. Symphony reuses each CLI's authentication.
It does not sign in for you or switch providers automatically when one fails.

### Claude Code

Follow the [official Claude Code installation instructions](https://code.claude.com/docs/en/setup).
For macOS/Linux, the documented installer is:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
claude
```

Complete the first-run setup and sign-in, then exit the interactive session before starting
Symphony. Use the same operating-system user for both programs.

### Codex

Follow the [official Codex CLI setup instructions](https://learn.chatgpt.com/docs/codex/cli).
For macOS/Linux, the documented installer is:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex --version
codex
```

Complete sign-in in the interactive CLI, then exit it. A ticket's selected model must be
available to the account you authenticated.

## 3. Install Symphony once

Use your local Symphony checkout. For example, if it is at `~/Sites/symphony`:

```bash
cd ~/Sites/symphony
npm ci --omit=dev
npm install --global .
symphony-linear --help
```

Keep this checkout in place when installing from a directory: npm can link the global command
to it. There is no build step. Both `symphony-linear` and the existing `symphony` command are
installed.

Alternatively, install a supplied package file:

```bash
npm install --global /absolute/path/to/symphony-0.1.0.tgz
symphony-linear --help
```

Use a local checkout or package file; this project is not published to the npm registry.

## 4. Initialize your project

Navigate to the **root of the project you want agents to work on**, rather than the Symphony
installation directory:

```bash
cd ~/Sites/project1
git status
symphony-linear init .
```

If the project has no Git history yet, create and review an initial commit first.
For a different initial default branch, use an existing branch name:

```bash
symphony-linear init . --base-branch main
```

An explicit base branch is required if the project is on a detached HEAD. The flag sets the
default only when creating the workflow; repeating `init` preserves existing configuration.
To change that default later, edit `workspace.base_branch` in `.symphony-linear/WORKFLOW.md`.

Successful initialization prints an address such as:

```text
Running: http://127.0.0.1:49173
```

Initialization and `start` open the dashboard in your default browser. Symphony runs in the
background and keeps running when the terminal closes. If the browser cannot open (for example,
on a headless machine), open the **address printed by your command** manually.
Each project gets an available localhost port, which can change after a restart.

Initialization adds `/.symphony-linear/` to the project's `.gitignore` and creates:

```text
project1/
  .gitignore
  .symphony-linear/
    WORKFLOW.md       # configuration and agent instructions
    tickets/          # ticket markdown files and comments
    worktrees/        # isolated ticket checkouts
    worktree-state/   # original base commit and ticket branch records
    logs/daemon.log   # daemon output
    runtime.json     # running instance address and private control token
```

The daemon also uses temporary lock files. Git maintains worktree metadata in its own Git
directory. Repeating `init .` preserves the workflow and tickets and reports the running
instance when one already exists. Commit the `.gitignore` change if you want the ignore rule
shared with other developers. Ignored tickets need their own backup.

## 5. Configure project setup and checks

Each ticket starts with a fresh Git worktree containing committed files. Dependencies,
untracked files and local environment files from your main checkout are not copied.
Add any required setup commands to the YAML header of `.symphony-linear/WORKFLOW.md`.
Preserve its existing configuration and the agent instructions below the closing `---`.

For example, **for a Node project**:

```yaml
hooks:
  after_create: |
    npm ci
checks:
  commands:
    - npm test
  handoff_state: Human Review
```

Replace these commands with the selected project's actual setup and verification commands.
Hooks and checks run inside the ticket's worktree. A Docker command must target a container
that uses that worktree's code; a container mounted to the original checkout will test the
original checkout instead.

The generated workflow runs one agent per project. Change
`agent.max_concurrent_agents` only when the project's tooling supports concurrent worktrees.
Configuration edits hot-reload; an invalid edit pauses new dispatch and is reported in the log.
See the [configuration reference](../README.md#front-matter-beyond-the-specs-core-keys) for
provider, timeout and check settings.

## 6. Run your first ticket

1. Click **New issue** in the dashboard and leave its status in **Backlog** while preparing it.
2. Write a specific title and description, including what should change and how to verify it.
3. Keep **Agent can pick this up** checked so the ticket receives the required `agent` label.
4. Choose **Coding agent**: Claude is the default; choose Codex for that ticket if preferred.
5. Leave **Model** blank to use that provider's default, or enter a model available to your account.
6. Select **Base branch**, then create the ticket.
7. On an existing ticket, click **Save agent** after changing its provider or model.
8. Move the ticket to **To Do** when it is ready to run.

The branch selector includes local and already fetched remote-tracking branches. Fetch through
Git yourself if a remote branch is missing. At first dispatch Symphony resolves the selected
base to a commit and creates a branch such as `symphony/DEV-1` in the ticket's worktree.
The base selector then locks. Retries and rework keep using that ticket branch and worktree.

Watch the ticket's activity and the dashboard's **Activity** tab. On completion, the agent
commits locally, adds a comment and moves the ticket to **Human Review**. Configured handoff
checks must pass before the handoff is accepted.

## 7. Review and finish the work

For `DEV-1`, inspect its branch from the project's main checkout:

```bash
git log --oneline main..symphony/DEV-1
git diff main...symphony/DEV-1
```

Replace `main` with the branch you selected as the base. To request changes, leave a ticket
comment and move it to **Rework**. Provider changes apply to the next attempt; they do not
replace an already running session.

Review, merge and push the branch yourself according to your project's workflow. Symphony
does not automatically merge or push project-local ticket branches. After accepting the work,
move the ticket to **Done**. Terminal workspaces are cleaned up on daemon startup, or when a
running/retrying ticket is observed in a terminal state. A ticket already idle in Human Review
may therefore keep its worktree until the next stop/start. Cleanup removes clean worktrees
and retains branches; dirty or untracked work is preserved. Keep the branch while further
rework may be needed.

## 8. Start, stop and manage multiple projects

From an initialized project root:

```bash
symphony-linear status .
symphony-linear stop .
symphony-linear start .
symphony-linear open .          # reopen the running dashboard
```

There is no separate restart command: run `stop`, then `start`. `status` prints the current
address; `open` opens it without starting an instance. Stopping preserves tickets and worktrees.
Instances do not start automatically after a machine reboot.

Use an explicit path to manage another project:

```bash
symphony-linear init ~/Sites/project2
symphony-linear status ~/Sites/project1
symphony-linear stop ~/Sites/project2
```

Each project has independent configuration, tickets and a background instance. To see all running
project instances from any directory:

```bash
symphony-linear list
```

The command prints PID, dashboard URL and project path after verifying each instance is responding.
It discovers already-running daemons, omits stale/unresponsive entries and never prints control tokens.
It lists background project instances visible to your user on the current machine; standalone foreground
workflows and processes inside other containers or machines are not included. Discovery uses `ps`
(included on macOS; install `procps` on minimal Linux systems if missing).

## Troubleshooting

| Symptom | What to do |
|---|---|
| `symphony-linear: command not found` | Reopen the terminal, check that the global npm executable directory is on `PATH`, and rerun `symphony-linear --help`. |
| Global install reports a permission error | Use a user-owned Node installation or npm prefix, then add its executable directory to `PATH`. |
| `Select the Git project root` | Run `git rev-parse --show-toplevel`, change to that directory, then initialize it. |
| Detached HEAD | On first initialization, pass `--base-branch` with an existing local or fetched remote branch. |
| `.symphony-linear` contains tracked files | Review `git ls-files -- .symphony-linear`; remove those files from the Git index before retrying. Keep your local data. |
| Dashboard no longer opens | Run `symphony-linear status .` and use its current address; run `start .` if stopped. |
| Ticket stays in Backlog or does not start | Move it to To Do, confirm the `agent` label, check blockers, and inspect the daemon log. An agent already running may occupy the concurrency slot. |
| Agent executable or login fails | Check `claude --version` or `codex --version`, sign in interactively as the same user, then stop/start the instance if its environment changed. |
| Selected base branch is missing | Fetch it if needed, or choose an existing branch before the ticket starts. |
| An existing ticket branch blocks creation | Inspect that branch before resolving the collision; Symphony refuses to reuse unrelated work. |
| Ticket branch was deleted after cleanup | Restore the ticket branch before requesting rework. Symphony will not recreate it from an old base and lose the ticket's commit history. |
| Worktree remains after Done | Check `git -C .symphony-linear/worktrees/DEV-1 status`. Commit or preserve remaining work before arranging cleanup. |
| Recorded process is alive but unresponsive | Inspect the log and process before changing runtime metadata. The stop command authenticates the server rather than signalling an unverified PID. |
| Lock recovery reports an interrupted recovery | Inspect the named `.reclaim` directory and confirm no recovery is running before removing a stale guard. |

Read the local daemon log with:

```bash
tail -n 100 .symphony-linear/logs/daemon.log
```

Use trusted projects: Claude's default workflow allows unattended commands. Git worktrees
share repository metadata and are not a security boundary. Codex project runs retain their
configured sandbox and receive write access for local ticket files and shared Git metadata;
network and Docker access may require additional configuration. See the
[trust posture](../README.md#trust-posture) before enabling unattended work.

For Jira or a standalone workflow file, use the existing foreground `symphony` interface and
follow [Run](../README.md#run) and the Jira example workflow in the repository root.

### Review feedback and session context

For local tickets, leave feedback as a comment before moving Human Review back to To Do or Rework.
The next dispatch starts a new agent session and renders the workflow prompt with the latest ticket
description when the template includes `issue.description`. For local tickets with a handoff,
the prompt includes the original requirements, the latest handoff and every newer comment.
Older comments stay in the ticket file and dashboard. Without a handoff, the full thread is included.
It reuses the ticket workspace and branch, so finished code remains available. Continuation turns
and failed handoff checks within one attempt resume the same session. Custom prompts must include
`{{ issue.description }}` for the model to receive comments.

Local status moves are timestamped in the ticket activity. Model activity remains visible after
handoff, bounded to 100 events per detail view from the daemon's last 20 runs (50 events per run).
This streamed activity is cleared when the daemon restarts; ticket comments and status history
persist in the ticket file. Jira comments are not currently fetched into the prompt or dashboard.

Local agents are asked to leave a comment starting with `## Handoff` before review or a blocker.
This is a cumulative summary (aim: 200 words) of completed work, relevant files/branch, key decisions,
verification, remaining issues and unresolved feedback or requirement changes. It is stored in
the existing ticket file, so the next fresh session can use it even after a daemon restart or
provider change. No extra model call generates a summary. Feedback after the handoff is included
in full; Symphony does not truncate it. The handoff serves as the workflow's summary comment.
Custom workflow prompts must include `{{ issue.description }}`.

This reduces repeated history in prompts; actual token/cost savings depend on the model's work
and caching. A missing or empty handoff keeps the full history. If a handoff omits an important
decision, the next agent may need to inspect the full ticket file or relevant code.
