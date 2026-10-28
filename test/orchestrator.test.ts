import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Issue, Tracker } from '../src/core.ts';
import { Orchestrator, sortForDispatch } from '../src/orchestrator.ts';
import { issue, tmp, waitFor, writeWorkflow } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

class FakeTracker implements Tracker {
  issues = new Map<string, Issue>();
  onRefresh: () => void = () => {};
  async fetchIssuesByStates(states: string[]) {
    const s = states.map((x) => x.toLowerCase());
    return [...this.issues.values()].filter((i) => s.includes(i.state.toLowerCase())).map((i) => ({ ...i }));
  }
  async fetchIssuesByIds(ids: string[]) {
    this.onRefresh();
    return ids.flatMap((id) => (this.issues.has(id) ? [{ ...this.issues.get(id)! }] : []));
  }
}

function setup(extra = '', provider: 'claude' | 'codex' = 'claude') {
  const dir = tmp();
  const logFile = join(dir, `${provider}.log`);
  writeFileSync(logFile, '');
  process.env[provider === 'codex' ? 'FAKE_CODEX_LOG' : 'FAKE_CLAUDE_LOG'] = logFile;
  const workflowPath = writeWorkflow(dir, [
    'tracker: { kind: jira, active_states: [To Do, In Progress], terminal_states: [Done] }',
    'polling: { interval_ms: 60000 }',
    'workspace: { root: ws }',
    `claude: { command: node ${FAKE}, model: test-model }`,
    `codex: { command: node ${CODEX}, model: gpt-6.1-sol }`,
    `agent: { max_turns: 3, provider: ${provider} }`,
    extra,
  ].join('\n'));
  const tracker = new FakeTracker();
  const orch = new Orchestrator({ workflowPath, makeTracker: () => tracker, toolCommand: 'tool-cmd' });
  const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, tracker, orch, calls, workflowPath };
}

test('dispatch → continuation turn on the same session → handoff state releases the claim', async () => {
  const { dir, tracker, orch, calls } = setup();
  tracker.issues.set('1', issue());
  tracker.onRefresh = () => {
    if (calls().length >= 2) tracker.issues.get('1')!.state = 'Human Review';
  };
  await orch.start();
  try {
    await waitFor(() => calls().length === 2 && !orch.running.size);
    const [first, second] = calls();
    assert.match(first.prompt, /^Work on ABC-1: Do the thing/);
    assert.doesNotMatch(first.prompt, /## Review handoff/);
    assert.equal(first.args[first.args.indexOf('--session-id') + 1], second.args[second.args.indexOf('--resume') + 1]);
    assert.ok(first.args.includes('test-model'));
    assert.match(second.prompt, /Continue working on ABC-1/);
    assert.equal(first.cwd, join(dir, 'ws', 'ABC-1'));
    assert.equal(first.tracker, 'tool-cmd');
    assert.deepEqual(orch.totals.input, 20);
    // Continuation retry fires after ~1s, sees a non-active state, and releases the claim.
    assert.ok(orch.retries.has('1'));
    await waitFor(() => !orch.claimed.size, 3000);
    assert.equal(calls().length, 2);
  } finally {
    await orch.stop();
  }
});

test('a ticket chooses Codex over the Claude default, pins its model across reloads, and resumes its thread', async () => {
  const { tracker, orch, calls, workflowPath } = setup('', 'codex');
  // The workflow defaults to Claude, but this ticket explicitly selects Codex.
  writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('provider: codex', 'provider: claude'));
  tracker.issues.set('1', issue({ agent_provider: 'codex', agent_model: 'gpt-6-astra' }));
  let changed = false;
  tracker.onRefresh = () => {
    if (calls().length === 1 && !changed) {
      changed = true;
      tracker.issues.get('1')!.agent_provider = 'claude';
      tracker.issues.get('1')!.agent_model = 'sonnet';
      writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('gpt-6.1-sol', 'gpt-6-luna'));
      orch.reload();
    }
    if (calls().length >= 2) tracker.issues.get('1')!.state = 'Human Review';
  };
  await orch.start();
  try {
    await waitFor(() => calls().length === 2 && !orch.running.size);
    const [first, second] = calls();
    assert.ok(!first.args.includes('resume'));
    assert.ok(second.args.includes('resume'));
    assert.equal(second.args.at(-2), 'codex-thread-123');
    assert.ok(first.args.includes('gpt-6-astra'));
    assert.ok(second.args.includes('gpt-6-astra'));
    assert.equal(first.tracker, 'tool-cmd');
    assert.deepEqual({ input: orch.totals.input, output: orch.totals.output }, { input: 20, output: 10 });
    assert.equal(orch.snapshot().agent_totals.cost_usd, null);
    assert.equal(orch.recent[0].provider, 'codex');
    assert.equal(orch.recent[0].model, 'gpt-6-astra');
    assert.match(second.prompt, /Continue working on ABC-1/);
  } finally { await orch.stop(); }
});

test('a Claude ticket overrides the Codex workflow default', async () => {
  const { tracker, orch, calls } = setup();
  orch.reload();
  orch.cfg.agent.provider = 'codex';
  tracker.issues.set('1', issue({ agent_provider: 'claude', agent_model: 'sonnet' }));
  tracker.onRefresh = () => { if (calls().length) tracker.issues.get('1')!.state = 'Human Review'; };
  await orch.start();
  try {
    await waitFor(() => calls().length === 1 && !orch.running.size);
    assert.ok(calls()[0].args.includes('sonnet'));
    assert.equal(orch.recent[0].provider, 'claude');
    assert.equal(orch.snapshot().agent_totals.cost_usd, 0.01);
  } finally { await orch.stop(); }
});

test('Codex failure retries and Codex stalls respect the running attempt timeout', async () => {
  const failed = setup('', 'codex');
  failed.tracker.issues.set('1', issue());
  process.env.FAKE_CODEX_MODE = 'failed';
  await failed.orch.start();
  try {
    await waitFor(() => failed.orch.retries.has('1'));
    assert.match(failed.orch.retries.get('1')!.error!, /test failure/);
  } finally {
    await failed.orch.stop();
    delete process.env.FAKE_CODEX_MODE;
  }
  const stalled = setup('', 'codex');
  stalled.tracker.issues.set('1', issue());
  process.env.FAKE_CODEX_SLEEP_MS = '20000';
  await stalled.orch.start();
  try {
    await waitFor(() => stalled.orch.running.get('1')?.lastEvent === 'turn.started');
    const run = stalled.orch.running.get('1')!;
    assert.equal(run.sessionId, 'codex-thread-123');
    assert.equal(stalled.orch.snapshot().running[0].provider, 'codex');
    run.stallTimeoutMs = 1;
    await new Promise((r) => setTimeout(r, 10));
    await stalled.orch.reconcile();
    await waitFor(() => stalled.orch.retries.has('1'));
    assert.match(stalled.orch.retries.get('1')!.error!, /stalled/);
  } finally {
    await stalled.orch.stop();
    delete process.env.FAKE_CODEX_SLEEP_MS;
  }
});

test('reconciliation stops a run whose issue went terminal and removes its workspace', async () => {
  const { dir, tracker, orch } = setup();
  process.env.FAKE_CLAUDE_SLEEP_MS = '20000';
  tracker.issues.set('1', issue());
  await orch.start();
  try {
    await waitFor(() => orch.running.get('1')?.lastEvent === 'system/init');
    tracker.issues.get('1')!.state = 'Done';
    await orch.reconcile();
    await waitFor(() => !orch.running.size && !orch.claimed.size && !existsSync(join(dir, 'ws', 'ABC-1')));
  } finally {
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
    await orch.stop();
  }
});

test('failed turn schedules an exponential-backoff retry', async () => {
  const { tracker, orch } = setup();
  process.env.FAKE_CLAUDE_FAIL = '1';
  tracker.issues.set('1', issue());
  await orch.start();
  try {
    await waitFor(() => orch.retries.has('1'));
    const r = orch.retries.get('1')!;
    assert.equal(r.attempt, 1);
    assert.match(r.error!, /turn failed \(error_during_execution\)/);
    assert.ok(r.dueAt - Date.now() > 9000);
    assert.ok(orch.claimed.has('1'));
    assert.equal(orch.backoff(10), 300_000);
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
    await orch.stop();
  }
});

test('stalled run is killed and retried', async () => {
  const { tracker, orch } = setup('');
  process.env.FAKE_CLAUDE_SLEEP_MS = '20000';
  tracker.issues.set('1', issue());
  await orch.start();
  try {
    await waitFor(() => orch.running.get('1')?.lastEvent === 'system/init');
    orch.running.get('1')!.stallTimeoutMs = 1;
    await new Promise((r) => setTimeout(r, 10));
    await orch.reconcile();
    await waitFor(() => orch.retries.has('1'));
    assert.match(orch.retries.get('1')!.error!, /stalled/);
  } finally {
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
    await orch.stop();
  }
});

test('blocked, unlabeled, or non-active issues are not dispatched; per-state limits apply', async () => {
  const { orch } = setup();
  await orch.start();
  await orch.stop();
  orch.cfg.tracker.requiredLabels = ['agent'];
  assert.equal(orch.eligible(issue({ labels: ['agent'] })), true);
  assert.equal(orch.eligible(issue()), false);
  assert.equal(orch.eligible(issue({ labels: ['agent'], dispatchable: false })), false);
  assert.equal(orch.eligible(issue({ labels: ['agent'], state: 'Done' })), false);
  orch.cfg.tracker.requiredLabels = [' '];
  assert.equal(orch.eligible(issue({ labels: ['agent'] })), false);
  orch.cfg.agent.maxConcurrentByState = { 'in progress': 0 };
  assert.equal(orch.availableSlots('In Progress'), 0);
  assert.equal(orch.availableSlots('To Do'), 10);
});

test('invalid WORKFLOW.md reload keeps the last good config and pauses dispatch', async () => {
  const { orch, workflowPath } = setup();
  orch.reload();
  const good = orch.cfg;
  writeFileSync(workflowPath, '---\ntracker: [\n---\n');
  utimesSync(workflowPath, new Date(), new Date(Date.now() + 5000));
  orch.reload();
  assert.equal(orch.cfg, good);
  assert.match(orch.configError!, /workflow_parse_error/);
});

test('dispatch order: priority 1..4 first, then oldest, then identifier', () => {
  const sorted = sortForDispatch([
    issue({ identifier: 'N', priority: null, created_at: '2020-01-01T00:00:00Z' }),
    issue({ identifier: 'B', priority: 2, created_at: null }),
    issue({ identifier: 'A', priority: 2, created_at: null }),
    issue({ identifier: 'O', priority: 2, created_at: '2021-01-01T00:00:00Z' }),
    issue({ identifier: 'P1', priority: 1 }),
  ]);
  assert.deepEqual(sorted.map((i) => i.identifier), ['P1', 'O', 'A', 'B', 'N']);
});

test('exhausting max_turns while still active comments, moves to Blocked, and is not re-dispatched', async () => {
  const { tracker, orch, calls } = setup();
  const writes: string[] = [];
  Object.assign(tracker, {
    comment: async (key: string, text: string) => void writes.push(`comment ${key}: ${text}`),
    transition: async (key: string, state: string) => {
      writes.push(`transition ${key} ${state}`);
      tracker.issues.get('1')!.state = state;
      return state;
    },
  });
  tracker.issues.set('1', issue());
  await orch.start();
  try {
    await waitFor(() => writes.length === 2);
    assert.equal(calls().length, 3); // max_turns: 3
    assert.match(writes[0], /^comment ABC-1: Symphony: used all 3 turns/);
    assert.equal(writes[1], 'transition ABC-1 Blocked');
    assert.equal(orch.retries.size, 0);
    assert.equal(orch.claimed.size, 0);
    assert.equal(orch.parked.size, 0);
    assert.equal(orch.recent[0].outcome, 'blocked');
  } finally {
    await orch.stop();
  }
});

test('if the Blocked transition fails, the issue is parked until its state changes', async () => {
  const { tracker, orch, calls } = setup();
  Object.assign(tracker, { transition: async () => { throw new Error('no transition to "Blocked"'); } });
  tracker.issues.set('1', issue());
  await orch.start();
  try {
    await waitFor(() => orch.parked.has('1'));
    assert.equal(orch.claimed.size, 0);
    await orch.tick(); // still "To Do" → skipped
    assert.equal(orch.running.size, 0);
    assert.equal(calls().length, 3);
    tracker.issues.get('1')!.state = 'In Progress'; // user moved it
    await orch.tick();
    assert.equal(orch.parked.size, 0);
    assert.equal(orch.running.size, 1);
  } finally {
    await orch.stop();
  }
});

test('a second service on the same workspace refuses to start until the first stops', async () => {
  const { orch, tracker, workflowPath } = setup();
  const second = new Orchestrator({ workflowPath, makeTracker: () => tracker, toolCommand: 'tool-cmd' });
  await orch.start();
  try {
    await assert.rejects(second.start(), /already using/);
  } finally {
    await orch.stop();
  }
  await second.start();
  await second.stop();
});

function gated(extra: string, commands: string[], provider: 'claude' | 'codex' = 'claude') {
  const t = setup(['checks:', '  commands:', ...commands.map((c) => `    - '${c}'`), extra].join('\n'), provider);
  const writes: string[] = [];
  let moved = 0;
  Object.assign(t.tracker, {
    comment: async (key: string, text: string) => void writes.push(`comment ${key}: ${text}`),
    transition: async (key: string, state: string) => {
      writes.push(`transition ${key} ${state}`);
      t.tracker.issues.get('1')!.state = state;
      return state;
    },
  });
  // The "agent" moves the ticket to Human Review at the end of every turn.
  t.tracker.onRefresh = () => {
    const n = t.calls().length;
    if (n > moved) {
      moved = n;
      t.tracker.issues.get('1')!.state = 'Human Review';
    }
  };
  t.tracker.issues.set('1', issue());
  return { ...t, writes };
}

test('checks pass → evidence comment, claim released, no extra turn', async () => {
  const { orch, calls, writes } = gated('', ['echo ok']);
  await orch.start();
  try {
    await waitFor(() => writes.length === 1 && !orch.running.size);
    assert.match(writes[0], /^comment ABC-1: Symphony checks passed/);
    assert.match(writes[0], /echo ok/);
    await waitFor(() => !orch.claimed.size, 3000);
    assert.equal(calls().length, 1);
  } finally {
    await orch.stop();
  }
});

test('failing check comments, moves back, and resumes the same session with the failure; then passes', async () => {
  const { orch, calls, writes } = gated('', ['test -f "$SYMPHONY_WORKSPACE/ok" || { touch "$SYMPHONY_WORKSPACE/ok"; echo boom; exit 1; }']);
  await orch.start();
  try {
    await waitFor(() => writes.length === 3 && !orch.running.size);
    assert.match(writes[0], /^comment ABC-1: .*boom/s);
    assert.equal(writes[1], 'transition ABC-1 To Do');
    assert.match(writes[2], /checks passed/);
    const [first, second] = calls();
    assert.equal(calls().length, 2);
    assert.equal(first.args[first.args.indexOf('--session-id') + 1], second.args[second.args.indexOf('--resume') + 1]);
    assert.match(second.prompt, /boom/);
    assert.doesNotMatch(second.prompt, /Continue working on/);
  } finally {
    await orch.stop();
  }
});

test('Codex handoff checks fail once, resume the same thread, then pass', async () => {
  const { orch, calls, writes } = gated('', ['test -f "$SYMPHONY_WORKSPACE/ok" || { touch "$SYMPHONY_WORKSPACE/ok"; echo boom; exit 1; }'], 'codex');
  await orch.start();
  try {
    await waitFor(() => writes.length === 3 && !orch.running.size);
    assert.match(writes[0], /boom/);
    assert.equal(writes[1], 'transition ABC-1 To Do');
    assert.match(writes[2], /checks passed/);
    assert.equal(calls().length, 2);
    assert.ok(calls()[1].args.includes('resume'));
    assert.equal(calls()[1].args.at(-2), 'codex-thread-123');
    assert.match(calls()[1].prompt, /checks failed[\s\S]*boom/);
    assert.equal(orch.recent[0].provider, 'codex');
  } finally { await orch.stop(); }
});

test('checks failing on every turn exhaust max_turns and block the issue', async () => {
  const { orch, tracker, calls, writes } = gated('', ['echo nope; exit 1']);
  await orch.start();
  try {
    await waitFor(() => tracker.issues.get('1')!.state === 'Blocked');
    assert.equal(calls().length, 3);
    assert.equal(writes.filter((w) => w.startsWith('transition ABC-1 To Do')).length, 3);
    assert.equal(orch.recent[0].outcome, 'blocked');
  } finally {
    await orch.stop();
  }
});

test('a run is not stalled or stopped while its checks run in the handoff state', async () => {
  const { orch, calls, writes } = gated('', ['sleep 1']);
  await orch.start();
  try {
    await waitFor(() => orch.running.get('1')?.checking === true);
    assert.equal(orch.running.get('1')!.lastMessage, 'Running checks');
    orch.cfg.claude.stallTimeoutMs = 50;
    await new Promise((r) => setTimeout(r, 100));
    await orch.reconcile();
    assert.equal(orch.running.get('1')!.stop, undefined);
    await waitFor(() => writes.length === 1 && !orch.running.size);
    assert.match(writes[0], /checks passed/);
    assert.equal(calls().length, 1);
  } finally {
    await orch.stop();
  }
});

test('a reconcile tick mid-turn does not change which state a failed gate returns the ticket to', async () => {
  const { orch, tracker, writes } = gated('', ['exit 1']);
  tracker.issues.set('1', issue({ state: 'In Progress' }));
  process.env.FAKE_CLAUDE_SLEEP_MS = '500';
  await orch.start();
  try {
    await waitFor(() => orch.running.get('1')?.lastEvent === 'system/init');
    await orch.reconcile(); // the fake agent has "moved" the ticket to Human Review by now
    assert.equal(tracker.issues.get('1')!.state, 'Human Review');
    await waitFor(() => writes.length >= 2);
    assert.equal(writes[1], 'transition ABC-1 In Progress');
  } finally {
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
    await orch.stop();
  }
});

test('aborting a run during checks posts no failure comment and does not transition', async () => {
  const { orch, writes } = gated('', ['sleep 20']);
  await orch.start();
  await waitFor(() => orch.running.get('1')?.checking === true);
  await orch.stop();
  assert.deepEqual(writes, []);
});

test('handoff keeps activity visible and returning to To Do starts fresh with review feedback', async () => {
  const { tracker, orch, calls, workflowPath } = setup();
  writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8') + '\n{{ issue.description }}');
  tracker.issues.set('1', issue({ description: 'Original request' }));
  tracker.onRefresh = () => { if (calls().length) tracker.issues.get('1')!.state = 'Human Review'; };
  await orch.start();
  try {
    await waitFor(() => calls().length === 1 && !orch.running.size);
    const previous = orch.issueDetail('ABC-1')!;
    assert.ok(previous.recent_events.some((e) => e.message === 'done'));
    assert.equal(previous.workspace.path, calls()[0].cwd);
    await waitFor(() => !orch.claimed.size, 3000);
    tracker.issues.get('1')!.state = 'To Do';
    tracker.issues.get('1')!.description = 'Original request\n\n## Comments\n\n### 2026-10-27T00:00:00Z\n\nPlease fix the edge case';
    await orch.tick();
    assert.ok(orch.issueDetail('ABC-1')!.recent_events.some((e) => e.message === 'done'));
    await waitFor(() => calls().length === 2 && !orch.running.size);
    const [first, second] = calls();
    assert.ok(!second.args.includes('--resume'));
    assert.notEqual(first.args[first.args.indexOf('--session-id') + 1], second.args[second.args.indexOf('--session-id') + 1]);
    assert.match(second.prompt, /Original request[\s\S]*Please fix the edge case/);
    assert.equal(second.cwd, first.cwd);
    assert.equal(orch.issueDetail('ABC-1')!.recent_events.filter((e) => e.message === 'done').length, 2);
    assert.ok(!('events' in orch.snapshot().recent[0]));
  } finally { await orch.stop(); }
});

for (const provider of ['claude', 'codex'] as const) test(`${provider} review after restart uses compact context in a fresh session and reuses work`, async () => {
  const { tracker, orch, calls, workflowPath } = setup('', provider);
  writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('kind: jira', 'kind: local') + '\n{{ issue.description }}');
  const original = 'Requirements: fix search and preserve keyboard navigation.';
  const old = 'Old investigation '.repeat(1000);
  tracker.issues.set('1', issue({ description: `${original}\n\n## Comments\n\n### 2026-10-26T00:00:00.000Z\n\n${old}` }));
  tracker.onRefresh = () => { if (calls().length) tracker.issues.get('1')!.state = 'Human Review'; };
  await orch.start();
  try {
    await waitFor(() => calls().length === 1 && !orch.running.size);
    assert.match(calls()[0].prompt, /## Review handoff/);
    assert.match(calls()[0].prompt, /Old investigation/);
  } finally { await orch.stop(); }
  tracker.issues.get('1')!.description += '\n\n### 2026-10-26T12:00:00.000Z\n\n## Handoff\n\nCompleted search.ts. Tests passed; keep keyboard fix. Remaining: empty query.\n\n### 2026-10-27T00:00:00.000Z\n\nReview: handle whitespace input too.';
  tracker.issues.get('1')!.state = 'To Do';
  const restarted = new Orchestrator({ workflowPath, makeTracker: () => tracker, toolCommand: 'tool-cmd' });
  await restarted.start();
  try {
    await waitFor(() => calls().length === 2 && !restarted.running.size);
    const [first, next] = calls();
    assert.equal(next.cwd, first.cwd);
    assert.ok(!next.args.includes('--resume') && !next.args.includes('resume'));
    assert.match(next.prompt, /Requirements: fix search and preserve keyboard navigation/);
    assert.match(next.prompt, /Completed search.ts/);
    assert.match(next.prompt, /Review: handle whitespace input too/);
    assert.ok(!next.prompt.includes('Old investigation'));
    assert.ok(next.prompt.length < first.prompt.length / 5);
    assert.match(tracker.issues.get('1')!.description!, /Old investigation/);
  } finally { await restarted.stop(); }
});


for (const provider of ['claude', 'codex'] as const) test(`${provider} records each turn's usage once, before refreshing state`, async () => {
  const { tracker, orch, calls } = setup('', provider);
  const reports: unknown[] = [];
  Object.assign(tracker, { recordUsage: async (...args: unknown[]) => { reports.push(args); } });
  tracker.issues.set('1', issue());
  tracker.onRefresh = () => { if (calls().length >= 2) tracker.issues.get('1')!.state = 'Human Review'; };
  try {
    await orch.start();
    await waitFor(() => orch.recent.length > 0);
    assert.deepEqual(reports, [
      ['ABC-1', { input: 10, output: 5 }, 'To Do'],
      ['ABC-1', { input: 10, output: 5 }, 'To Do'],
    ]);
  } finally { await orch.stop(); }
});


for (const provider of ['claude', 'codex'] as const) test(`${provider} keeps reported usage when the CLI fails after reporting it`, async () => {
  const { tracker, orch } = setup('', provider);
  const reports: unknown[] = [];
  Object.assign(tracker, { recordUsage: async (...args: unknown[]) => { reports.push(args); } });
  tracker.issues.set('1', issue());
  const envKey = provider === 'claude' ? 'FAKE_CLAUDE_FAIL' : 'FAKE_CODEX_MODE';
  process.env[envKey] = provider === 'claude' ? '1' : 'nonzero';
  try {
    await orch.start();
    await waitFor(() => orch.recent.length > 0);
    assert.deepEqual(reports, [['ABC-1', { input: 10, output: 5 }, 'To Do']]);
    assert.equal(orch.recent[0].outcome, 'failed');
  } finally {
    await orch.stop();
    delete process.env[envKey];
  }
});
