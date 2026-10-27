import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, realpath, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { lockFile } from './core.ts';
import { branchCommit, git } from './git.ts';

export const stateDir = (project: string) => join(project, '.symphony-linear');
export type Instance = { project: string; pid: number; url: string; token: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function projectRoot(path: string): Promise<string> {
  const project = await realpath(resolve(path));
  const root = await realpath(await git(project, 'rev-parse', '--show-toplevel'));
  if (root !== project) throw new Error(`Select the Git project root: ${root}`);
  await git(project, 'rev-parse', '--verify', 'HEAD');
  return root;
}

async function rejectSymlink(path: string) {
  const info = await lstat(path).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  if (info?.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
}

export async function initialize(project: string, base?: string): Promise<void> {
  const dir = stateDir(project);
  await rejectSymlink(dir);
  if (await git(project, 'ls-files', '--', '.symphony-linear')) throw new Error('.symphony-linear contains tracked files; untrack them before initialization');
  const ignore = join(project, '.gitignore');
  await rejectSymlink(ignore);
  const content = await readFile(ignore, 'utf8').catch((e) => { if (e.code !== 'ENOENT') throw e; return ''; });
  if (!content.split(/\r?\n/).includes('/.symphony-linear/')) await appendFile(ignore, `${content && !content.endsWith('\n') ? '\n' : ''}/.symphony-linear/\n`);
  await git(project, 'check-ignore', '--quiet', '.symphony-linear/probe');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  for (const child of ['tickets', 'worktrees', 'logs', 'worktree-state']) {
    await rejectSymlink(join(dir, child));
    await mkdir(join(dir, child), { recursive: true });
  }
  const workflow = join(dir, 'WORKFLOW.md');
  await rejectSymlink(workflow);
  try { await readFile(workflow); return; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const branch = base ?? await git(project, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => { throw new Error('Detached HEAD: pass --base-branch <branch>'); });
  await branchCommit(project, branch);
  const config = {
    tracker: { kind: 'local', provider: { dir: 'tickets' }, required_labels: ['agent'], active_states: ['To Do', 'In Progress', 'Rework'], terminal_states: ['Done', "Won't Do"] },
    board: { title: basename(project), columns: ['Backlog', 'To Do', 'In Progress', 'Human Review', 'Rework', 'Blocked', 'Done', "Won't Do"] },
    server: { port: 0 }, workspace: { project: '..', root: 'worktrees', base_branch: branch },
    agent: { provider: 'claude', max_concurrent_agents: 1, max_turns: 10 },
  };
  const prompt = `You are working on {{ issue.identifier }}: {{ issue.title }}\n{% if issue.description %}{{ issue.description }}{% endif %}\n\nWork in this ticket's Git worktree on its existing branch. Follow the project's AGENTS.md.\nUse $SYMPHONY_TRACKER to comment and transition this ticket. Move it to In Progress when starting.\nImplement the task and run the project's checks. Commit your changes; do not push, merge, or switch branches.\nComment a summary and verification results, then transition to Human Review. If blocked, explain why and transition to Blocked.\n`;
  await writeFile(workflow, `---\n${stringify(config)}---\n${prompt}`, { flag: 'wx', mode: 0o600 });
}

export async function readInstance(project: string): Promise<Instance | null> {
  let value: Instance;
  try { value = JSON.parse(await readFile(join(stateDir(project), 'runtime.json'), 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot read runtime.json: ${e.message}`); }
  if (value.project !== project || !Number.isInteger(value.pid) || value.pid <= 0 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url) || typeof value.token !== 'string' || !value.token) throw new Error('Invalid project runtime metadata');
  return value;
}

export async function control(instance: Instance, stop = false): Promise<boolean> {
  try {
    const res = await fetch(`${instance.url}/api/v1/instance${stop ? '/stop' : ''}`, {
      method: stop ? 'POST' : 'GET', headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(1500),
    });
    const body = await res.json();
    return res.ok && body.project === instance.project && body.pid === instance.pid;
  } catch { return false; }
}

/** Discover older daemons too, without a registry that would need migration or stale-entry cleanup. */
export async function listInstances(): Promise<Omit<Instance, 'token'>[]> {
  const { stdout } = await promisify(execFile)('ps', ['-axww', '-o', 'pid=,command='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const instances = await Promise.all(stdout.split('\n').map(async (line) => {
    // shortcut: ps cannot recover project paths containing newlines; use a registry if those need support.
    const match = /^\s*(\d+)\s+.+?\/bin\/symphony\.mjs _serve (.+)$/.exec(line);
    if (!match) return null;
    const instance = await readInstance(match[2]).catch(() => null);
    if (!instance || instance.pid !== Number(match[1]) || !await control(instance)) return null;
    return { project: instance.project, pid: instance.pid, url: instance.url };
  }));
  return instances.filter((instance) => instance !== null).sort((a, b) => a.project.localeCompare(b.project));
}

export async function saveInstance(instance: Instance) {
  const path = join(stateDir(instance.project), 'runtime.json');
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(instance) + '\n', { mode: 0o600 });
  await rename(temp, path);
}

async function openDashboard(url: string) {
  try {
    await promisify(execFile)(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 5000 });
  } catch {
    console.error(`Could not open browser. Open ${url} manually.`);
  }
}

export async function projectCommand(command: string, args: string[]) {
  if (command === 'list') {
    if (args.length) throw new Error('usage: symphony-linear list');
    const instances = await listInstances();
    if (!instances.length) { console.log('No running Symphony project instances.'); return; }
    console.log('PID\tURL\tPROJECT');
    for (const instance of instances) console.log(`${instance.pid}\t${instance.url}\t${instance.project}`);
    return;
  }
  const baseAt = args.indexOf('--base-branch');
  const base = baseAt < 0 ? undefined : args.splice(baseAt, 2)[1];
  if (baseAt >= 0 && (!base || command !== 'init')) throw new Error('--base-branch <branch> is only valid with init');
  if (args.length > 1 || args[0]?.startsWith('-')) throw new Error(`usage: symphony-linear ${command} [project]`);
  const project = await projectRoot(args[0] ?? '.');
  const dir = stateDir(project);
  if (command === 'init') {
    // The Git directory already exists, allowing serialization before creating project state.
    const lock = await git(project, 'rev-parse', '--absolute-git-dir');
    const unlock = await lockFile(join(lock, 'symphony-init.lock'), 15_000);
    try { await initialize(project, base); } finally { await unlock(); }
  }
  await rejectSymlink(dir);
  await readFile(join(dir, 'WORKFLOW.md')).catch(() => { throw new Error('Project is not initialized. Run symphony-linear init .'); });
  const unlock = await lockFile(join(dir, 'lifecycle.lock'), 20_000);
  try {
    const previous = await readInstance(project);
    const healthy = previous && await control(previous);
    if (command === 'status') {
      console.log(healthy ? `Running: ${previous.url}` : 'Stopped (no responding instance)');
      return;
    }
    if (command === 'open' && !healthy) throw new Error('No responding instance. Run symphony-linear start .');
    if (command === 'stop') {
      if (!healthy) { console.log('No responding instance; no process was signalled.'); return; }
      if (!await control(previous, true)) throw new Error('Instance rejected shutdown');
      for (let i = 0; i < 200; i++) {
        if (!await readInstance(project)) { console.log('Stopped'); return; }
        await sleep(100);
      }
      throw new Error('Shutdown is still in progress; check status and logs');
    }
    if (healthy) { console.log(`Running: ${previous.url}`); await openDashboard(previous.url); return; }
    if (previous) {
      let alive = false;
      try { process.kill(previous.pid, 0); alive = true; } catch (e: any) { if (e.code !== 'ESRCH') alive = true; }
      if (alive) throw new Error('Recorded process is alive but not responding; inspect logs before restarting');
    }
    const log = await open(join(dir, 'logs', 'daemon.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/symphony.mjs', import.meta.url)), '_serve', project], {
      cwd: project, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'], env: { ...process.env, SYMPHONY_INSTANCE_TOKEN: randomUUID() },
    });
    await log.close();
    try {
      const instance = await new Promise<Instance>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('Startup timed out')), 15_000);
        child.once('message', (m: Instance) => { clearTimeout(timer); resolveReady(m); });
        child.once('error', (e) => { clearTimeout(timer); reject(e); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Instance exited ${code}; see ${join(dir, 'logs', 'daemon.log')}`)); });
      });
      if (!await control(instance)) throw new Error('Instance failed readiness check');
      child.disconnect(); child.unref();
      console.log(`Running: ${instance.url}`);
      await openDashboard(instance.url);
    } catch (e) { child.kill('SIGTERM'); throw e; }
  } finally { await unlock(); }
}

export async function clearInstance(project: string, token: string) {
  if ((await readInstance(project))?.token === token) await rm(join(stateDir(project), 'runtime.json'), { force: true });
}
