import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, loadWorkflow, renderPrompt } from '../src/workflow.ts';
import { issue, tmp, writeWorkflow } from './helpers.ts';

test('parses front matter, applies defaults and jira state defaults', () => {
  const dir = tmp();
  const wf = loadWorkflow(writeWorkflow(dir, 'tracker:\n  kind: jira\nworkspace:\n  root: ws'));
  assert.equal(wf.promptTemplate, 'Work on {{ issue.identifier }}: {{ issue.title }}');
  const cfg = buildConfig(wf);
  assert.deepEqual(cfg.tracker.activeStates, ['To Do', 'In Progress']);
  assert.equal(cfg.workspaceRoot, join(dir, 'ws'));
  assert.equal(cfg.pollIntervalMs, 30_000);
  assert.equal(cfg.agent.maxTurns, 20);
  assert.equal(cfg.claude.command, 'claude');
});

test('expands ~ and $VAR in workspace.root, normalizes by-state limits', () => {
  process.env.SYM_TEST_ROOT = '~/sym';
  const cfg = buildConfig(loadWorkflow(writeWorkflow(tmp(), [
    'tracker: { kind: jira }', 'workspace: { root: $SYM_TEST_ROOT }',
    'agent: { max_concurrent_agents_by_state: { " In Progress ": 2, Todo: 0 } }',
  ].join('\n'))));
  assert.equal(cfg.workspaceRoot, join(homedir(), 'sym'));
  assert.deepEqual(cfg.agent.maxConcurrentByState, { 'in progress': 2 });
});

test('no front matter → whole file is the prompt; missing kind fails validation', () => {
  const path = join(tmp(), 'WORKFLOW.md');
  writeFileSync(path, 'Just a prompt\n');
  const wf = loadWorkflow(path);
  assert.deepEqual(wf.config, {});
  assert.throws(() => buildConfig(wf), /tracker.kind is required/);
});

test('error classes', () => {
  assert.throws(() => loadWorkflow('/nope/WORKFLOW.md'), { code: 'missing_workflow_file' });
  assert.throws(() => loadWorkflow(writeWorkflow(tmp(), '- a\n- b')), { code: 'workflow_front_matter_not_a_map' });
  assert.throws(() => loadWorkflow(writeWorkflow(tmp(), 'a: [')), { code: 'workflow_parse_error' });
  assert.throws(() => buildConfig(loadWorkflow(writeWorkflow(tmp(), 'tracker: { kind: jira }\nagent: { max_turns: 0 }'))), /max_turns/);
});

test('strict rendering: attempt null is fine, unknown variables and filters fail', async () => {
  assert.equal(await renderPrompt('{{ issue.identifier }}{% if attempt %} retry {{ attempt }}{% endif %}', issue(), null), 'ABC-1');
  assert.equal(await renderPrompt('{% if attempt %}retry {{ attempt }}{% endif %}', issue(), 2), 'retry 2');
  await assert.rejects(renderPrompt('{{ issue.nope }}', issue(), null), { code: 'template_render_error' });
  await assert.rejects(renderPrompt('{{ issue.title | nope }}', issue(), null), /template_/);
  assert.match(await renderPrompt('', issue(), null), /configured tracker/);
});

test('checks: off by default, defaults when set, handoff_state must not be active or terminal', () => {
  const build = (extra: string) => buildConfig(loadWorkflow(writeWorkflow(tmp(), `tracker: { kind: jira }\n${extra}`)));
  assert.deepEqual(build('').checks.commands, []);
  const cfg = build('checks: { commands: [make test] }');
  assert.deepEqual(cfg.checks, { commands: ['make test'], handoffState: 'Human Review', timeoutMs: 600_000 });
  assert.equal(build('checks: { commands: [x], handoff_state: Review, timeout_ms: 5 }').checks.timeoutMs, 5);
  assert.throws(() => build('checks: { commands: [x], handoff_state: in progress }'), /checks.handoff_state/);
  assert.throws(() => build('checks: { commands: [x], handoff_state: Done }'), /checks.handoff_state/);
  assert.throws(() => build('checks: { commands: [x], timeout_ms: 0 }'), /checks.timeout_ms/);
});
