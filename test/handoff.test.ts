import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactDescription } from '../src/handoff.ts';
import { LocalTracker } from '../src/local.ts';
import { tmp } from './helpers.ts';

const comment = (text: string, day = '26') => `### 2026-10-${day}T10:00:00.000Z\n\n${text}\n`;
const thread = (...comments: string[]) => `Original requirements: preserve accessibility.\n\n## Comments\n\n${comments.join('\n')}`;

test('compact context keeps requirements, latest cumulative handoff and every newer comment', () => {
  const old = 'Old exploration '.repeat(1000);
  const handoff = comment('## Handoff\n\nChanged src/a.ts on branch agent/DEV-1. Tests passed. Keep the earlier keyboard fix.');
  const feedback = comment('New review: fix empty input.\nDo not change the public API.', '27');
  const description = thread(comment(old), comment('## Handoff\n\nOutdated summary'), handoff, feedback);
  const compact = compactDescription(description)!;
  assert.equal(compact, thread(handoff, feedback));
  assert.ok(compact.length < description.length / 10);
  assert.ok(!compact.includes('Old exploration'));
  assert.ok(!compact.includes('Outdated summary'));
});

test('missing, empty or misplaced handoffs leave history intact', () => {
  for (const description of [null, '', 'Requirements only', thread(comment('feedback')),
    thread(comment('## Handoff')), thread(comment('## Handoff\n\n  ')),
    thread(comment('An example:\n## Handoff\nExample text')),
    thread(comment('```md\n## Handoff\nExample text\n```'))]) {
    assert.equal(compactDescription(description), description);
  }
});

test('CRLF, repeated comment sections and headings within feedback preserve newer content', () => {
  const handoff = comment('## Handoff\n\nImplemented café search. Remaining: keyboard support.');
  const feedback = comment('### Accessibility\nKeep all details here.', '27');
  const description = thread(comment('Old activity'), handoff) + '\n## Comments\n\n' + feedback;
  const compact = compactDescription(description.replaceAll('\n', '\r\n'))!;
  assert.match(compact, /Implemented café search/);
  assert.match(compact, /### Accessibility\r\nKeep all details here/);
  assert.ok(!compact.includes('Old activity'));
});

test('a new tracker reads the persisted handoff without changing stored comment history', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'tickets'));
  writeFileSync(join(dir, 'tickets', 'DEV-1.md'), '---\nstate: To Do\ntitle: Fix search\n---\nOriginal requirements: preserve accessibility.\n');
  const tracker = new LocalTracker(join(dir, 'tickets'), ['Done']);
  await tracker.comment('DEV-1', 'Old exploration');
  await tracker.comment('DEV-1', '## Handoff\n\nChanged search.ts; tests pass. Keep keyboard support.');
  await tracker.transition('DEV-1', 'Human Review');
  await tracker.comment('DEV-1', 'New feedback: handle empty input');
  await tracker.transition('DEV-1', 'To Do');
  const restarted = new LocalTracker(join(dir, 'tickets'), ['Done']);
  const [issue] = await restarted.fetchIssuesByIds(['DEV-1']);
  const compact = compactDescription(issue.description)!;
  assert.ok(!compact.includes('Old exploration'));
  assert.match(compact, /Changed search.ts; tests pass/);
  assert.match(compact, /New feedback: handle empty input/);
  assert.match(compact, /Status changed from Human Review to To Do/);
  const [unchanged] = await restarted.fetchIssuesByIds(['DEV-1']);
  assert.equal(unchanged.description, issue.description);
  assert.match(unchanged.description!, /Old exploration/);
});
