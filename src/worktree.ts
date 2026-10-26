import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { branchCommit, git } from './git.ts';
import { lockFile } from './core.ts';
import type { Config } from './workflow.ts';
import { runHook, hookEnv, workspaceKey, workspacePath } from './workspace.ts';

type WorktreeState = { branch: string; base_branch: string; base_commit: string; created?: boolean; initialized?: boolean };
const recordPath = (cfg: Config, id: string) => join(cfg.workflowDir, 'worktree-state', `${workspaceKey(id)}.json`);
export function worktreeStarted(cfg: Config, id: string) { return existsSync(recordPath(cfg, id)); }
export async function worktreeLock(cfg: Config, id: string) {
  await mkdir(join(cfg.workflowDir, 'worktree-state'), { recursive: true });
  return lockFile(recordPath(cfg, id) + '.lock', 5000);
}

export async function ensureWorktree(cfg: Config, id: string, readBase: () => Promise<string | null>) {
  const unlock = await worktreeLock(cfg, id);
  try {
    const path = workspacePath(cfg.workspaceRoot, id);
    const record = recordPath(cfg, id);
    let state: WorktreeState | null = null;
    try { state = JSON.parse(await readFile(record, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const createdNow = !existsSync(path);
    if (!createdNow) {
      if (!state || await git(path, 'symbolic-ref', '--short', 'HEAD') !== state.branch) throw new Error(`Unexpected workspace at ${path}; inspect it before retrying`);
    } else {
      if (!state) {
        const base = await readBase() ?? cfg.baseBranch!;
        const commit = await branchCommit(cfg.projectRoot!, base);
        const branch = `symphony/${workspaceKey(id)}`;
        if (await git(cfg.projectRoot!, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`)) throw new Error(`Branch ${branch} already exists; refusing to reuse unrelated work`);
        state = { branch, base_branch: base, base_commit: commit };
        // Persist before creation so retries never silently choose a newer base commit.
        await writeFile(record, JSON.stringify(state) + '\n', { flag: 'wx' });
      }
      await mkdir(cfg.workspaceRoot, { recursive: true });
      const exists = await git(cfg.projectRoot!, 'for-each-ref', '--format=%(refname)', `refs/heads/${state.branch}`);
      if (!exists && state.created) throw new Error(`Ticket branch ${state.branch} was deleted; restore it before retrying`);
      await git(cfg.projectRoot!, 'worktree', 'add', ...(exists ? [] : ['-b', state.branch]), path, exists ? state.branch : state.base_commit);
      state.created = true;
      state.initialized = false;
    }
    if (!state.initialized && cfg.hooks.afterCreate) {
      await runHook('after_create', cfg.hooks.afterCreate, path, cfg.hooks.timeoutMs, hookEnv(id, path));
    }
    if (!state.initialized) {
      const temp = `${record}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ ...state, created: true, initialized: true }) + '\n');
      await rename(temp, record);
    }
    return { path, createdNow };
  } finally { await unlock(); }
}

export async function removeWorktree(cfg: Config, id: string) {
  const unlock = await worktreeLock(cfg, id);
  try {
    const path = workspacePath(cfg.workspaceRoot, id);
    if (!existsSync(path)) return;
    if (!worktreeStarted(cfg, id)) throw new Error(`Refusing to remove unrecognized workspace ${path}`);
    // No --force: Git refuses dirty trees, untracked files and submodules. Keep the review branch.
    await git(cfg.projectRoot!, 'worktree', 'remove', path);
  } finally { await unlock(); }
}
