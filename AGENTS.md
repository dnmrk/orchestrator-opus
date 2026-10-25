# AGENTS.md

Instructions for coding agents (Codex, Claude Code, and others) working on this repo.

## Project

Symphony is a TypeScript daemon that runs Claude Code or Codex against a ticket board (local markdown or Jira), with provider/model
selection per ticket. It runs on Node 24 via native type stripping, so there's no build step. Runtime deps are `yaml` and `liquidjs`
only. Tests use `node --test` with fake CLIs (`test/fixtures/fake-{claude,codex}.mjs`). See README.md for features and config.

- Every node/npm/tsc command runs **inside a container**, never on the host.
- Plans and review notes go in `tasks/todo.md`.
- Commit messages carry **no AI attribution trailer** (no `Co-Authored-By: Claude/Codex`). Don't push or merge unless asked.

## Worktree workflow (required when another agent may be active)

Several agents can work on this repo at once. The main checkout (`/Users/dnmrk/Sites/symphony`) and its container
(`symphony-app-1`) belong to whoever is already working there. **Do feature work in your own git worktree with your own
container.** Never edit, run commands in, or stop another agent's checkout or container.

```bash
# 1. See what's taken
git -C /Users/dnmrk/Sites/symphony worktree list
docker ps --filter name=symphony

# 2. Create your worktree (one per task; <slug> = short task name)
git -C /Users/dnmrk/Sites/symphony worktree add -b <branch> /Users/dnmrk/Sites/symphony-<slug> main

# 3. Give it its own container. The -p project name keeps it off symphony-app-1
cd /Users/dnmrk/Sites/symphony-<slug>
docker compose -p symphony-<slug> up -d
docker compose -p symphony-<slug> exec -T app npm ci

# 4. Work and verify, always with the same -p
docker compose -p symphony-<slug> exec -T app npm test
docker compose -p symphony-<slug> exec -T app npm run typecheck

# 5. Commit from the HOST: the container has no git, and the worktree's .git file points to a host path
git -C /Users/dnmrk/Sites/symphony-<slug> add <paths>
git -C /Users/dnmrk/Sites/symphony-<slug> commit -m "..."

# 6. Clean up after the branch is merged
docker compose -p symphony-<slug> down
git -C /Users/dnmrk/Sites/symphony worktree remove /Users/dnmrk/Sites/symphony-<slug>
git -C /Users/dnmrk/Sites/symphony branch -d <branch>
```

Rules:
- Always pass `-p symphony-<slug>`. Without it, compose names the project after the folder, and it's easy to attach to the wrong container.
- A branch can be checked out in only one worktree. If `worktree add` says it's in use, another agent owns it, so pick a new branch.
- `tasks/todo.md` is per branch. Write your plan in your worktree's copy, not the main checkout's.
- Before merging, rebase on `main` (another agent may have moved it) and rerun the tests in your container.
