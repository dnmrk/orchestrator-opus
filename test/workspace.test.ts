import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildConfig, loadWorkflow } from '../src/workflow.ts';
import { ensureWorkspace, removeWorkspace, workspaceKey, workspacePath } from '../src/workspace.ts';
import { tmp, writeWorkflow } from './helpers.ts';

test('workspace keys: unchanged when safe, hashed when sanitized, collision resistant', () => {
  assert.equal(workspaceKey('ABC-123'), 'ABC-123');
  assert.match(workspaceKey('a/b'), /^a_b-[0-9a-f]{16}$/);
  assert.notEqual(workspaceKey('a/b'), workspaceKey('a:b'));
});

test('workspace path must stay a child of the root', () => {
  assert.throws(() => workspacePath('/w', '..'));
  assert.throws(() => workspacePath('/w', '.'));
  assert.equal(workspacePath('/w', '../x'), `/w/${workspaceKey('../x')}`);
});

const cfgWith = (hooks: string) => {
  const dir = tmp();
  return buildConfig(loadWorkflow(writeWorkflow(dir, `tracker: { kind: jira }\nworkspace: { root: ws }\nhooks:\n${hooks}`)));
};

test('after_create runs once with env; reuse does not rerun it; before_remove runs', async () => {
  const cfg = cfgWith('  after_create: echo "$SYMPHONY_ISSUE_IDENTIFIER" >> created\n  before_remove: echo bye > ../removed\n  timeout_ms: 5000');
  const a = await ensureWorkspace(cfg, 'ABC-1');
  const b = await ensureWorkspace(cfg, 'ABC-1');
  assert.equal(a.createdNow, true);
  assert.equal(b.createdNow, false);
  assert.equal(readFileSync(join(a.path, 'created'), 'utf8'), 'ABC-1\n');
  await removeWorkspace(cfg, 'ABC-1');
  assert.equal(existsSync(a.path), false);
  assert.equal(existsSync(join(cfg.workspaceRoot, 'removed')), true);
});

test('after_create failure or timeout removes the half-built workspace', async () => {
  const failing = cfgWith('  after_create: exit 3');
  await assert.rejects(ensureWorkspace(failing, 'ABC-2'), /exited 3/);
  assert.equal(existsSync(workspacePath(failing.workspaceRoot, 'ABC-2')), false);
  const slow = cfgWith('  after_create: sleep 5\n  timeout_ms: 200');
  await assert.rejects(ensureWorkspace(slow, 'ABC-3'), /timed out/);
});

test('workspace.shared: every issue uses the existing dir, it is never removed, concurrency forced to 1', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = tmp();
  mkdirSync(join(dir, 'project'));
  writeFileSync(join(dir, 'project', 'keep.txt'), 'mine');
  const cfg = buildConfig(loadWorkflow(writeWorkflow(dir, 'tracker: { kind: jira }\nworkspace: { shared: project }\nagent: { max_concurrent_agents: 5 }\nhooks:\n  after_create: exit 1')));
  assert.equal(cfg.agent.maxConcurrent, 1);
  const a = await ensureWorkspace(cfg, 'ABC-1');
  const b = await ensureWorkspace(cfg, 'ABC-2');
  assert.deepEqual([a.path, b.path], [join(dir, 'project'), join(dir, 'project')]);
  await removeWorkspace(cfg, 'ABC-1');
  assert.equal(readFileSync(join(dir, 'project', 'keep.txt'), 'utf8'), 'mine');
  assert.throws(() => buildConfig(loadWorkflow(writeWorkflow(tmp(), 'tracker: { kind: jira }\nworkspace: { shared: nope }'))), /not an existing directory/);
});
