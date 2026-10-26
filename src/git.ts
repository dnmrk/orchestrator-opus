import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function branches(project: string): Promise<string[]> {
  return (await git(project, 'for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/'))
    .split('\n').filter((s) => s && !s.endsWith('/HEAD')).map((s) => s.replace(/^refs\/(heads|remotes)\//, ''));
}

export async function branchCommit(project: string, branch: string): Promise<string> {
  if (!(await branches(project)).includes(branch)) throw new Error(`Base branch does not exist: ${branch}`);
  // Fully qualified refs avoid option/revision-expression injection and tag ambiguity.
  for (const prefix of ['refs/heads/', 'refs/remotes/']) {
    try { return await git(project, 'rev-parse', '--verify', `${prefix}${branch}^{commit}`); } catch {}
  }
  throw new Error(`Cannot resolve base branch: ${branch}`);
}
