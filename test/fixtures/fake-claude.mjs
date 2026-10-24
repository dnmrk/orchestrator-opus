#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`: logs its invocation, emits init/assistant/result.
import { appendFileSync } from 'node:fs';

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  const sid = args[args.indexOf('--session-id') + 1] ?? args[args.indexOf('--resume') + 1];
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), tracker: process.env.SYMPHONY_TRACKER }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: sid });
  if (process.env.FAKE_CLAUDE_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_SLEEP_MS)));
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Bash' }] } });
  out({ type: 'result', subtype: process.env.FAKE_CLAUDE_FAIL ? 'error_during_execution' : 'success', is_error: !!process.env.FAKE_CLAUDE_FAIL, result: 'done', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
});
