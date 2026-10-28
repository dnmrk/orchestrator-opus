import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, waitFor } from './helpers.ts';
import { runTurn, summarize, summarizeCodex, type AgentEvent, type TurnOptions } from '../src/agent.ts';
import { buildConfig } from '../src/workflow.ts';

const PARENT = fileURLToPath(new URL('./fixtures/orphan-parent.mjs', import.meta.url));
const CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const provider of ['claude', 'codex']) test(`a killed service takes its ${provider} agent down with it`, async () => {
  const beat = join(tmp(), 'beat');
  const parent = spawn(process.execPath, [PARENT, beat, provider], { stdio: 'ignore' });
  await waitFor(() => existsSync(beat));
  parent.kill('SIGKILL');
  await sleep(2500); // the guard polls once a second
  const last = statSync(beat).mtimeMs;
  await sleep(500);
  assert.equal(statSync(beat).mtimeMs, last, 'agent still running after its service died');
});

function codexTurn(mode = '') {
  const events: AgentEvent[] = [];
  const cfg = buildConfig({ path: '/tmp/WORKFLOW.md', config: { tracker: { kind: 'local' } }, promptTemplate: '' }).codex;
  const options: TurnOptions = {
    provider: 'codex', cfg: { ...cfg, command: `node ${CODEX}` }, cwd: tmp(), sessionId: '', resume: false,
    prompt: 'Implement the ticket', env: { ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: '' },
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  };
  return { options, events };
}

test('Codex captures its thread, resumes explicitly, and reports usage without double counting cache', async () => {
  const { options, events } = codexTurn('malformed');
  await runTurn(options);
  const thread = events.find((e) => e.sessionId)?.sessionId;
  assert.equal(thread, 'codex-thread-123');
  assert.equal(events.filter((e) => e.type === 'malformed').length, 2);
  assert.deepEqual(events.find((e) => e.usage)?.usage, { input: 10, output: 5 });
  assert.equal(events.find((e) => e.type === 'item.started')?.message, 'npm test');
  await runTurn({ ...options, sessionId: thread!, resume: true });
  await assert.rejects(runTurn({ ...options, sessionId: '', resume: true }), /without a thread ID/);
  assert.equal(summarizeCodex({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/a.ts' }] } }).message, 'Updating files: src/a.ts');
});

test('Codex terminal failures, missing results/thread IDs, and nonzero exits reject', async () => {
  for (const [mode, error] of [
    ['failed', /test failure/], ['missing-result', /without a result/],
    ['missing-thread', /without a thread ID/], ['nonzero', /agent exited 1/],
  ] as const) {
    await assert.rejects(runTurn(codexTurn(mode).options), error);
  }
});

test('Codex abort and timeout stop the process and cannot be treated as successful turns', async () => {
  const controller = new AbortController();
  const { options } = codexTurn();
  options.signal = controller.signal;
  options.env.FAKE_CODEX_SLEEP_MS = '20000';
  options.onEvent = (e) => { if (e.type === 'thread.started') controller.abort('ticket cancelled'); };
  await assert.rejects(runTurn(options), /ticket cancelled/);
  const timed = codexTurn().options;
  timed.env.FAKE_CODEX_SLEEP_MS = '20000';
  timed.cfg.turnTimeoutMs = 100;
  await assert.rejects(runTurn(timed), /turn_timeout/);
  await assert.rejects(runTurn(options), /ticket cancelled/);
});

test('Claude activity includes shell commands and readable file descriptions', () => {
  const summary = (name: string, input?: object) => summarize({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }).message;
  assert.equal(summary('Edit', { file_path: 'src/a.ts', old_string: 'secret' }), 'Editing src/a.ts');
  assert.equal(summary('Write', { file_path: 'README.md' }), 'Writing README.md');
  assert.equal(summary('Read'), 'Reading a file');
  assert.equal(summary('Bash', { description: 'Run the test suite', command: 'npm test' }), 'Run the test suite:\nnpm test');
  assert.equal(summary('Bash', { command: 'pwd' }), 'Running a shell command:\npwd');
  assert.equal(summary('Bash'), 'Running a shell command');
  assert.equal(summary('Grep', { pattern: 'transition' }), 'Searching for transition');
  assert.equal(summary('Glob', { pattern: '*.ts' }), 'Finding files matching *.ts');
  assert.equal(summary('Task'), 'Using Task');
});
