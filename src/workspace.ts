import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { errMsg, killTree, log, orphanGuard } from './core.ts';
import type { Config } from './workflow.ts';

/** SPEC 4.2: sanitize to [A-Za-z0-9._-]; if that changed anything, add a 64-bit hash of the original. */
export function workspaceKey(identifier: string): string {
  const safe = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === identifier ? safe : `${safe}-${createHash('sha256').update(identifier).digest('hex').slice(0, 16)}`;
}

/** SPEC 9.5: the workspace must be a direct child of the root. */
export function workspacePath(root: string, identifier: string): string {
  const path = resolve(root, workspaceKey(identifier));
  const rel = relative(resolve(root), path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(`workspace path for ${identifier} escapes root ${root}`);
  }
  return path;
}

export const hookEnv = (identifier: string, path: string) => ({
  SYMPHONY_ISSUE_IDENTIFIER: identifier,
  SYMPHONY_WORKSPACE: path,
});

export function runHook(
  name: string,
  script: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  log('info', 'hook start', { hook: name, cwd });
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', ['-lc', orphanGuard() + script], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let tail = '';
    const keep = (d: Buffer) => (tail = (tail + d).slice(-4000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const fail = (msg: string) => {
      log('warn', 'hook failed', { hook: name, cwd, error: msg });
      reject(new Error(msg));
    };
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      killTree(child);
      fail(`hook ${name} timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.on('error', (e) => fail(`hook ${name}: ${errMsg(e)}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolvePromise(tail.trim().slice(-1000));
      else fail(`hook ${name} exited ${code}: ${tail.trim().slice(-1000)}`);
    });
  });
}

export async function ensureWorkspace(cfg: Config, identifier: string): Promise<{ path: string; createdNow: boolean }> {
  if (cfg.workspaceShared) return { path: cfg.workspaceShared, createdNow: false };
  const path = workspacePath(cfg.workspaceRoot, identifier);
  await mkdir(cfg.workspaceRoot, { recursive: true });
  let createdNow = false;
  try {
    await mkdir(path);
    createdNow = true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    if (!(await stat(path)).isDirectory()) throw new Error(`${path} exists and is not a directory`);
  }
  if (createdNow && cfg.hooks.afterCreate) {
    try {
      await runHook('after_create', cfg.hooks.afterCreate, path, cfg.hooks.timeoutMs, hookEnv(identifier, path));
    } catch (e) {
      await rm(path, { recursive: true, force: true });
      throw e;
    }
  }
  return { path, createdNow };
}

export async function removeWorkspace(cfg: Config, identifier: string): Promise<void> {
  if (cfg.workspaceShared) return; // never delete the user's own checkout
  const path = workspacePath(cfg.workspaceRoot, identifier);
  if (!existsSync(path)) return;
  if (cfg.hooks.beforeRemove) {
    await runHook('before_remove', cfg.hooks.beforeRemove, path, cfg.hooks.timeoutMs, hookEnv(identifier, path)).catch(() => {});
  }
  await rm(path, { recursive: true, force: true });
  log('info', 'workspace removed', { issue: identifier, path });
}
