import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalTracker } from '../src/local.ts';
import { tmp } from './helpers.ts';

function board(files: Record<string, string>) {
  const dir = join(tmp(), 'tickets');
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, tracker: LocalTracker.fromProvider({ dir: 'tickets' }, join(dir, '..'), ['Done']) };
}

const FILES = {
  'ABC-1.md': '---\nstate: To Do   # set by me\ntitle: Add login\npriority: 2\nlabels: [Agent, agent]\ncreated: 2026-01-01\n---\nUsers need to log in.\n',
  'ABC-2.md': '---\nstate: To Do\nblocked_by: [ABC-1, ABC-9]\n---\n# Logout button\n\nAfter login exists.\n',
  'ABC-3.md': '---\nstate: Done\ntitle: Old\n---\n',
  'BROKEN.md': '---\nstate: To Do\n---\nno title here\n',
  'README.md': 'not a ticket',
  'notes.txt': 'ignored',
};

test('lists tickets by state; title from header or heading; malformed and README skipped', async () => {
  const { tracker } = board(FILES);
  const todo = await tracker.fetchIssuesByStates(['to do']);
  assert.deepEqual(todo.map((i) => i.identifier), ['ABC-1', 'ABC-2']);
  const [a, b] = todo;
  assert.equal(a.title, 'Add login');
  assert.equal(a.priority, 2);
  assert.deepEqual(a.labels, ['agent']);
  assert.equal(a.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(a.description, 'Users need to log in.');
  assert.match(a.url!, /^file:\/\/.*ABC-1\.md$/);
  assert.equal(b.title, 'Logout button');
  assert.deepEqual(await tracker.fetchIssuesByStates([]), []);
});

test('blockers: dispatchable only when every blocker file exists and is terminal', async () => {
  const { dir, tracker } = board(FILES);
  let [b] = await tracker.fetchIssuesByIds(['ABC-2']);
  assert.deepEqual(b.blocked_by, [
    { id: 'ABC-1', identifier: 'ABC-1', state: 'To Do' },
    { id: 'ABC-9', identifier: 'ABC-9', state: null },
  ]);
  assert.equal(b.dispatchable, false);
  writeFileSync(join(dir, 'ABC-2.md'), '---\nstate: To Do\nblocked_by: ABC-3\n---\n# Logout\n');
  [b] = await tracker.fetchIssuesByIds(['ABC-2']);
  assert.equal(b.dispatchable, true);
});

test('fetchIssuesByIds: missing omitted, malformed fails, path traversal ignored', async () => {
  const { tracker } = board(FILES);
  assert.deepEqual((await tracker.fetchIssuesByIds(['ABC-1', 'NOPE', 'ABC-1', '../ABC-1', '..'])).map((i) => i.id), ['ABC-1']);
  await assert.rejects(tracker.fetchIssuesByIds(['BROKEN']), /tracker_response/);
});

test('transition keeps header comments and other keys; comment appends under ## Comments', async () => {
  const { dir, tracker } = board(FILES);
  assert.equal(await tracker.transition('ABC-1', 'Human Review'), 'Human Review');
  await tracker.comment('ABC-1', 'Opened branch agent/ABC-1');
  await tracker.comment('ABC-1', 'Tests pass');
  const text = readFileSync(join(dir, 'ABC-1.md'), 'utf8');
  assert.match(text, /^---\nstate: Human Review # set by me\ntitle: Add login\n/);
  assert.equal(text.match(/## Comments/g)!.length, 1);
  assert.match(text, /### .+\n\nOpened branch agent\/ABC-1\n\n### .+\n\nTests pass\n$/);
  const [issue] = await tracker.fetchIssuesByIds(['ABC-1']);
  assert.equal(issue.state, 'Human Review');
  await assert.rejects(tracker.comment('ABC-1', '  '), /empty/);
  await assert.rejects(tracker.transition('NOPE', 'Done'), /no ticket/);
});

test('ticket without a header gets one on transition', async () => {
  const { dir, tracker } = board({ 'X-1.md': '# Plain ticket\n' });
  await tracker.transition('X-1', 'To Do');
  assert.match(readFileSync(join(dir, 'X-1.md'), 'utf8'), /^---\nstate: To Do\ncreated: \d{4}-\d\d-\d\dT[\d:.]+Z\n---\n# Plain ticket\n$/);
});

test('$SYMPHONY_TRACKER works unquoted from an agent shell and stays scoped', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dir } = board({ 'X-1.md': '---\nstate: To Do\ntitle: T\n---\n', 'X-2.md': '---\nstate: To Do\ntitle: T\n---\n' });
  const workflow = join(dir, '..', 'WORKFLOW.md');
  writeFileSync(workflow, '---\ntracker: { kind: local }\n---\n');
  const env = {
    ...process.env,
    SYMPHONY_TRACKER: fileURLToPath(new URL('../bin/symphony-tracker', import.meta.url)),
    SYMPHONY_NODE: process.execPath,
    SYMPHONY_WORKFLOW: workflow,
    SYMPHONY_ISSUE_IDENTIFIER: 'X-1',
  };
  const run = (cmd: string) => spawnSync('bash', ['-c', cmd], { env, encoding: 'utf8' });
  assert.equal(run('$SYMPHONY_TRACKER transition X-1 In Progress').status, 0);
  assert.equal(run("printf 'multi\\nline' | $SYMPHONY_TRACKER comment X-1 -").status, 0);
  assert.match(readFileSync(join(dir, 'X-1.md'), 'utf8'), /state: In Progress[\s\S]*multi\nline\n$/);
  const denied = run('$SYMPHONY_TRACKER transition X-2 Done');
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /scoped to X-1/);
});

test('created survives rewrites: recorded from birth time on first write, then kept', async () => {
  const { dir, tracker } = board({ 'X-1.md': '---\nstate: To Do\ntitle: T\n---\nBody\n' });
  const [before] = await tracker.fetchIssuesByIds(['X-1']);
  await new Promise((r) => setTimeout(r, 20));
  await tracker.comment('X-1', 'first');
  await tracker.transition('X-1', 'Done');
  const [after] = await tracker.fetchIssuesByIds(['X-1']);
  assert.equal(after.created_at, before.created_at);
  assert.equal(readFileSync(join(dir, 'X-1.md'), 'utf8').match(/^created:/gm)!.length, 1);
  assert.match(after.description!, /^Body\n\n## Comments\n\n### .+\n\nfirst$/);
});
