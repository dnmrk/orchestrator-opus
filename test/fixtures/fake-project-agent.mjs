#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

process.stdin.resume();
process.stdin.on('end', () => {
  const codex = process.argv.includes('exec');
  if (codex) {
    const roots = process.argv.find((a) => a.startsWith('sandbox_workspace_write.writable_roots='));
    assert.ok(roots, 'project Codex runs need board/Git write roots');
    const paths = JSON.parse(roots.slice(roots.indexOf('=') + 1));
    assert.ok(paths.some((p) => p.endsWith('/tickets')));
    assert.ok(paths.some((p) => p.endsWith('/.git')));
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'project-thread' }) + '\n');
  }
  assert.equal(process.env.SYMPHONY_INSTANCE_TOKEN, undefined);
  const id = process.env.SYMPHONY_ISSUE_IDENTIFIER;
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  assert.equal(git('branch', '--show-current'), `symphony/${id}`);
  assert.equal(git('show', 'HEAD:file.txt'), 'base');
  writeFileSync('completed.txt', codex ? 'codex' : 'claude');
  git('add', 'completed.txt');
  git('commit', '-m', 'complete ticket');
  execFileSync(process.env.SYMPHONY_TRACKER, ['comment', id, 'Completed from selected base']);
  execFileSync(process.env.SYMPHONY_TRACKER, ['transition', id, 'Human Review']);
  process.stdout.write(JSON.stringify(codex ? { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } } : { type: 'result', subtype: 'success', result: 'done' }) + '\n');
});
