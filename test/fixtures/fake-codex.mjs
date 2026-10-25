#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.some((a) => a.startsWith('sandbox_mode=')));
  assert.equal(args.at(-1), '-');
  const resumed = args.includes('resume');
  const thread = resumed ? args.at(-2) : 'codex-thread-123';
  if (resumed) assert.equal(thread, 'codex-thread-123');
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), tracker: process.env.SYMPHONY_TRACKER }) + '\n');
  const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  const mode = process.env.FAKE_CODEX_MODE;
  if (mode === 'malformed') process.stdout.write('not json\nnull\n');
  if (mode !== 'missing-thread') out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  if (process.env.FAKE_CODEX_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CODEX_SLEEP_MS)));
  out({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } });
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'working' } });
  if (mode === 'missing-result') return;
  if (mode === 'failed') return out({ type: 'turn.failed', error: { message: 'test failure' } });
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 7, output_tokens: 5 } });
  if (mode === 'nonzero') process.exitCode = 1;
});
