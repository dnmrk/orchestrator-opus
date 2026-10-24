import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Issue } from '../src/core.ts';

export const tmp = () => mkdtempSync(join(tmpdir(), 'symphony-test-'));

export function writeWorkflow(dir: string, frontMatter: string, body = 'Work on {{ issue.identifier }}: {{ issue.title }}') {
  const path = join(dir, 'WORKFLOW.md');
  writeFileSync(path, `---\n${frontMatter}\n---\n${body}\n`);
  return path;
}

export function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: '1', native_ref: null, identifier: 'ABC-1', title: 'Do the thing', description: null, priority: null,
    state: 'To Do', branch_name: null, url: null, assignee_id: null, labels: [], blocked_by: [], dispatchable: true,
    created_at: null, updated_at: null, ...over,
  };
}

export async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
