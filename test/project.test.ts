import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { git } from '../src/git.ts';
import { initialize, projectRoot, readInstance, stateDir, control, listInstances } from '../src/project.ts';
import { buildConfig, loadWorkflow } from '../src/workflow.ts';
import { ensureWorkspace, removeWorkspace } from '../src/workspace.ts';
import { worktreeStarted } from '../src/worktree.ts';
import { stringify } from 'yaml';
import { shq } from '../src/core.ts';
import { tmp } from './helpers.ts';

const exec = promisify(execFile);
const cli = (...args: string[]) => exec(process.execPath, [process.env.SYMPHONY_TEST_CLI ?? resolve('src/cli.ts'), ...args], { timeout: 30_000 });
async function repo() {
  const dir = join(tmp(), 'project with spaces');
  await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'tests@example.com');
  await git(dir, 'config', 'user.name', 'Tests');
  await writeFile(join(dir, 'file.txt'), 'base\n');
  await git(dir, 'add', 'file.txt');
  await git(dir, 'commit', '-m', 'base');
  return dir;
}
const config = (dir: string) => buildConfig(loadWorkflow(join(stateDir(dir), 'WORKFLOW.md')));

test('initialization preserves config/tickets and ignores state; rejects tracked state and symlinks', async () => {
  const dir = await repo();
  await writeFile(join(dir, '.gitignore'), 'existing');
  await initialize(dir);
  const workflow = join(stateDir(dir), 'WORKFLOW.md');
  const original = await readFile(workflow, 'utf8');
  await writeFile(join(stateDir(dir), 'tickets', 'DEV-1.md'), 'keep');
  await initialize(dir);
  assert.equal(await readFile(workflow, 'utf8'), original);
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'existing\n/.symphony-linear/\n');
  await git(dir, 'check-ignore', '--quiet', '.symphony-linear/tickets/DEV-1.md');
  assert.equal(config(dir).agent.provider, 'claude');
  await git(dir, 'add', '-f', '.symphony-linear/tickets/DEV-1.md');
  await assert.rejects(initialize(dir), /tracked files/);
  const other = await repo();
  await symlink(tmp(), stateDir(other));
  await assert.rejects(initialize(other), /symlink/);
  await mkdir(join(other, 'nested'));
  await assert.rejects(projectRoot(join(other, 'nested')), /project root/);
});

test('worktrees use chosen committed base, reuse work, and protect dirty trees and review branches', async () => {
  const dir = await repo();
  await git(dir, 'branch', 'release');
  const base = await git(dir, 'rev-parse', 'release');
  await writeFile(join(dir, 'file.txt'), 'new main\n');
  await git(dir, 'commit', '-am', 'move main');
  await initialize(dir);
  const cfg = config(dir);
  const ws = await ensureWorkspace(cfg, 'DEV-1', async () => 'release');
  assert.equal(await git(ws.path, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(ws.path, 'branch', '--show-current'), 'symphony/DEV-1');
  assert.ok(worktreeStarted(cfg, 'DEV-1'));
  await writeFile(join(ws.path, 'keep.txt'), 'untracked work');
  await assert.rejects(removeWorkspace(cfg, 'DEV-1'), /modified or untracked/);
  assert.ok(existsSync(join(ws.path, 'keep.txt')));
  assert.equal((await ensureWorkspace(cfg, 'DEV-1', async () => 'main')).createdNow, false);
  await git(ws.path, 'add', '.');
  await git(ws.path, 'commit', '-m', 'ticket work');
  const sha = await git(ws.path, 'rev-parse', 'HEAD');
  await removeWorkspace(cfg, 'DEV-1');
  assert.equal(existsSync(ws.path), false);
  assert.equal(await git(dir, 'rev-parse', 'symphony/DEV-1'), sha);
  await ensureWorkspace(cfg, 'DEV-1', async () => 'missing');
  assert.equal(await git(ws.path, 'rev-parse', 'HEAD'), sha);
  await assert.rejects(ensureWorkspace(cfg, 'DEV-2', async () => '--help'), /Base branch does not exist/);
  assert.equal(worktreeStarted(cfg, 'DEV-2'), false);
  await removeWorkspace(cfg, 'DEV-1');
  await git(dir, 'branch', '-D', 'symphony/DEV-1');
  await assert.rejects(ensureWorkspace(cfg, 'DEV-1'), /was deleted/);
});

test('background init is repeatable and concurrent, projects have separate ports, stop is authenticated', async () => {
  assert.equal((await cli('list')).stdout.trim(), 'No running Symphony project instances.');
  await assert.rejects(cli('list', 'extra'), /usage: symphony-linear list/);
  await assert.rejects(cli('list', '--base-branch', 'main'), /usage: symphony-linear list/);
  const a = await repo(), b = await repo();
  try {
    await Promise.all([cli('init', a), cli('init', a), cli('init', b)]);
    const first = (await readInstance(a))!, second = (await readInstance(b))!;
    assert.notEqual(first.url, second.url);
    const listed = await exec(process.execPath, [process.env.SYMPHONY_TEST_CLI ?? resolve('bin/symphony.mjs'), 'list'], { cwd: tmp(), timeout: 30_000 });
    const lines = listed.stdout.trim().split('\n');
    assert.equal(lines[0], 'PID\tURL\tPROJECT');
    assert.equal(lines.length, 3);
    assert.ok(lines.includes(`${first.pid}\t${first.url}\t${a}`));
    assert.ok(lines.includes(`${second.pid}\t${second.url}\t${b}`));
    assert.ok(!listed.stdout.includes(first.token) && !listed.stdout.includes(second.token));
    assert.deepEqual((await listInstances()).map((instance) => instance.project), [a, b].sort((x, y) => x.localeCompare(y)));
    assert.ok(await control(first));
    assert.match((await cli('status', a)).stdout, /Running:/);
    await cli('init', a);
    assert.equal((await readInstance(a))!.pid, first.pid);
    const denied = await fetch(first.url + '/api/v1/instance/stop', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(denied.status, 403);
    await cli('stop', a);
    assert.equal(await readInstance(a), null);
    assert.ok(await control(second));
    const afterStop = (await cli('list')).stdout;
    assert.ok(!afterStop.includes(a));
    assert.ok(afterStop.includes(b));
    assert.match((await cli('status', a)).stdout, /Stopped/);
    await cli('start', a);
    assert.ok(await control((await readInstance(a))!));
    assert.ok((await cli('list')).stdout.includes(a));
  } finally { await Promise.all([cli('stop', a), cli('stop', b)]); }
});

test('base branch API persists choices and locks them after worktree creation; provider selection remains independent', async () => {
  const dir = await repo();
  await git(dir, 'branch', 'release');
  try {
    await cli('init', dir);
    const { url } = (await readInstance(dir))!;
    const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const created = await post('/api/v1/tickets', { title: 'Choose', state: 'Backlog', base_branch: 'release', agent_provider: 'codex' });
    assert.equal(created.status, 201);
    const { identifier } = await created.json();
    const board = await (await fetch(url + '/api/v1/board')).json();
    assert.ok(board.branches.includes('release'));
    assert.equal(board.tickets[0].base_branch, 'release');
    assert.equal(board.tickets[0].effective_provider, 'codex');
    assert.equal((await post(`/api/v1/tickets/${identifier}/base-branch`, { base_branch: 'main' })).status, 200);
    assert.equal((await post(`/api/v1/tickets/${identifier}/base-branch`, { base_branch: 'missing' })).status, 400);
    await ensureWorkspace(config(dir), identifier, async () => 'main');
    assert.equal((await post(`/api/v1/tickets/${identifier}/base-branch`, { base_branch: 'release' })).status, 409);
    assert.equal((await post(`/api/v1/tickets/${identifier}/agent`, { agent_provider: 'claude' })).status, 200);
    assert.equal((await post('/api/v1/tickets', { title: 'Invalid', base_branch: '--help' })).status, 400);
  } finally { await cli('stop', dir); }
});

test('stale metadata never signals an unrelated live process', async () => {
  const dir = await repo();
  await initialize(dir);
  const server = createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  try {
    await writeFile(join(stateDir(dir), 'runtime.json'), JSON.stringify({ project: dir, pid: process.pid, url: `http://127.0.0.1:${addr.port}`, token: 'unrelated' }));
    assert.match((await cli('stop', dir)).stdout, /no process was signalled/);
    await assert.rejects(cli('start', dir), /alive but not responding/);
    process.kill(process.pid, 0);
  } finally { server.close(); }
});

test('startup failures report logs and release the lifecycle lock', async () => {
  const dir = await repo();
  await initialize(dir);
  const path = join(stateDir(dir), 'WORKFLOW.md');
  const text = await readFile(path, 'utf8');
  await writeFile(path, '---\ninvalid: [\n---\n');
  await assert.rejects(cli('start', dir), /see .*daemon.log/);
  assert.equal(existsSync(join(stateDir(dir), 'lifecycle.lock')), false);
  assert.equal(await readInstance(dir), null);
  await writeFile(path, text);
  try { await Promise.all([cli('start', dir), cli('start', dir)]); assert.ok(await control((await readInstance(dir))!)); }
  finally { await cli('stop', dir); }
});

for (const provider of ['claude', 'codex']) test(`${provider} background dispatch uses the selected branch and hands off through the installed tracker tool`, async () => {
  const dir = await repo();
  await git(dir, 'branch', 'release');
  await writeFile(join(dir, 'file.txt'), 'new main\n');
  await git(dir, 'commit', '-am', 'move main');
  await initialize(dir);
  const path = join(stateDir(dir), 'WORKFLOW.md');
  const wf = loadWorkflow(path);
  wf.config[provider] = { command: `${shq(process.execPath)} ${shq(resolve('test/fixtures/fake-project-agent.mjs'))}` };
  await writeFile(path, `---\n${stringify(wf.config)}---\n${wf.promptTemplate}`);
  try {
    await cli('start', dir);
    const { url } = (await readInstance(dir))!;
    const res = await fetch(url + '/api/v1/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'End to end', state: 'To Do', agent: true, base_branch: 'release', agent_provider: provider }) });
    assert.equal(res.status, 201);
    const { identifier } = await res.json();
    let ticket: any;
    for (let i = 0; i < 100; i++) {
      const board = await (await fetch(url + '/api/v1/board')).json();
      ticket = board.tickets.find((t: any) => t.identifier === identifier);
      if (ticket.state === 'Human Review') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ticket.state, 'Human Review', await readFile(join(stateDir(dir), 'logs/daemon.log'), 'utf8'));
    assert.equal(ticket.base_locked, true);
    assert.match(ticket.description, /Completed from selected base/);
    assert.equal(await readFile(join(stateDir(dir), 'worktrees', identifier, 'completed.txt'), 'utf8'), provider);
  } finally { await cli('stop', dir); }
});

test('failed project setup retries before dispatch, preserves files, and runs again for a recreated checkout', async () => {
  const dir = await repo();
  await initialize(dir);
  const cfg = config(dir);
  cfg.hooks.afterCreate = 'echo preserved > setup.txt; exit 1';
  await assert.rejects(ensureWorkspace(cfg, 'DEV-1'), /exited 1/);
  const ws = join(cfg.workspaceRoot, 'DEV-1');
  assert.equal(await readFile(join(ws, 'setup.txt'), 'utf8'), 'preserved\n');
  await assert.rejects(ensureWorkspace(cfg, 'DEV-1'), /exited 1/);
  cfg.hooks.afterCreate = 'echo ready > setup.txt';
  await ensureWorkspace(cfg, 'DEV-1');
  assert.equal(await readFile(join(ws, 'setup.txt'), 'utf8'), 'ready\n');
  await git(ws, 'add', '.');
  await git(ws, 'commit', '-m', 'setup');
  await removeWorkspace(cfg, 'DEV-1');
  cfg.hooks.afterCreate = 'echo recreated > setup.txt';
  await ensureWorkspace(cfg, 'DEV-1');
  assert.equal(await readFile(join(ws, 'setup.txt'), 'utf8'), 'recreated\n');
});

test('a stopped process with stale metadata is replaced without touching its old port', async () => {
  const dir = await repo();
  await initialize(dir);
  await writeFile(join(stateDir(dir), 'runtime.json'), JSON.stringify({ project: dir, pid: 2147483647, url: 'http://127.0.0.1:1', token: 'old' }));
  await writeFile(join(stateDir(dir), 'lifecycle.lock'), '2147483647');
  await writeFile(join(stateDir(dir), 'daemon.lock'), '2147483647');
  try { await Promise.all([cli('start', dir), cli('start', dir)]); assert.ok(await control((await readInstance(dir))!)); }
  finally { await cli('stop', dir); }
});

test('list ignores malformed, stale and unresponsive daemon metadata without exposing tokens', async () => {
  const root = tmp();
  const bin = join(root, 'bin');
  await mkdir(bin);
  const daemon = join(bin, 'symphony.mjs');
  await writeFile(daemon, 'setInterval(() => {}, 1000);');
  const children = [];
  const server = createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    for (const mode of ['missing', 'malformed', 'wrong-pid', 'unresponsive']) {
      const project = join(root, mode + ' project');
      await mkdir(stateDir(project), { recursive: true });
      const child = spawn(process.execPath, [daemon, '_serve', project], { stdio: 'ignore' });
      children.push(child);
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      if (mode === 'missing') continue;
      await writeFile(join(stateDir(project), 'runtime.json'), mode === 'malformed' ? '{' : JSON.stringify({
        project, pid: mode === 'wrong-pid' ? process.pid : child.pid,
        url: `http://127.0.0.1:${port}`, token: 'do-not-print-this-token',
      }));
    }
    assert.deepEqual(await listInstances(), []);
    assert.equal((await cli('list')).stdout.trim(), 'No running Symphony project instances.');
    for (const child of children) process.kill(child.pid!, 0);
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
