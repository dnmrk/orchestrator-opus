import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { adfToText, JiraTracker, jiraProvider } from '../src/jira.ts';

const raw = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id),
  key: `ABC-${id}`,
  fields: {
    summary: `Issue ${id}`,
    status: { name: 'To Do' },
    priority: { name: 'High' },
    labels: [' Agent ', 'agent', ''],
    created: '2026-01-02T03:04:05.000+0000',
    issuelinks: [],
    ...over,
  },
});

/** Local stand-in for Jira's /search/jql: serves `pages` in order and records request bodies. */
async function fakeJira(pages: unknown[] | ((body: any) => { status: number; json: unknown })) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      bodies.push({ url: req.url, auth: req.headers.authorization, body });
      const r = typeof pages === 'function' ? pages(body) : { status: 200, json: pages[bodies.length - 1] };
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const tracker = new JiraTracker(jiraProvider({ base_url: `http://127.0.0.1:${port}/`, email: 'a@b.c', api_token: 't', project: 'ABC' }), ['Done']);
  return { tracker, bodies, close: () => server.close() };
}

test('provider validation and env fallback', () => {
  assert.throws(() => jiraProvider({ base_url: 'https://x.atlassian.net', project: 'ABC', email: '', api_token: '' }), /missing_tracker_secret/);
  assert.throws(() => jiraProvider({ base_url: 'x', project: 'ABC' }), /invalid_tracker_config/);
  process.env.JIRA_EMAIL = 'e@x';
  process.env.JIRA_API_TOKEN = 'tok';
  assert.equal(jiraProvider({ base_url: 'https://x.atlassian.net', project: 'ABC' }).apiToken, 'tok');
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
});

test('ADF → text', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'hardBreak' }, { type: 'text', text: 'world' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
    ],
  };
  assert.equal(adfToText(doc), 'Hello\nworld\n\n- one');
  assert.equal(adfToText(null), null);
});

test('normalization: labels, priority, timestamps, blockers drive dispatchable', async () => {
  const { tracker, close } = await fakeJira([]);
  close();
  const blocked = (state: string) => raw(1, {
    issuelinks: [
      { type: { inward: 'is blocked by' }, inwardIssue: { id: '9', key: 'ABC-9', fields: { status: { name: state } } } },
      { type: { inward: 'is blocked by' }, outwardIssue: { id: '8', key: 'ABC-8', fields: { status: { name: 'To Do' } } } },
    ],
  });
  const i = tracker.normalize(blocked('In Progress'))!;
  assert.deepEqual(i.labels, ['agent']);
  assert.equal(i.priority, 2);
  assert.equal(i.created_at, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(i.blocked_by, [{ id: '9', identifier: 'ABC-9', state: 'In Progress' }]);
  assert.equal(i.dispatchable, false);
  assert.equal(tracker.normalize(blocked('done'))!.dispatchable, true);
  assert.equal(tracker.normalize(raw(2, { summary: '' })), null);
});

test('fetchIssuesByStates paginates, scopes JQL, skips malformed; empty states make no request', async () => {
  const { tracker, bodies, close } = await fakeJira([
    { issues: [raw(1), raw(2, { status: null })], nextPageToken: 'p2', isLast: false },
    { issues: [raw(3)], isLast: true },
  ]);
  try {
    assert.deepEqual(await tracker.fetchIssuesByStates([]), []);
    const issues = await tracker.fetchIssuesByStates(['To Do', 'Say "hi"']);
    assert.deepEqual(issues.map((i) => i.identifier), ['ABC-1', 'ABC-3']);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].body.jql, 'project = "ABC" AND status in ("To Do", "Say \\"hi\\"") ORDER BY created ASC');
    assert.equal(bodies[1].body.nextPageToken, 'p2');
    assert.equal(bodies[0].auth, 'Basic ' + Buffer.from('a@b.c:t').toString('base64'));
  } finally {
    close();
  }
});

test('fetchIssuesByIds is strict and falls back per id when Jira rejects a missing id', async () => {
  const { tracker, close } = await fakeJira((body) =>
    body.jql.includes('id in') ? { status: 400, json: { errorMessages: ['does not exist'] } }
      : body.jql.endsWith('id = 7') ? { status: 400, json: {} }
      : { status: 200, json: { issues: [raw(1)], isLast: true } });
  try {
    assert.deepEqual((await tracker.fetchIssuesByIds(['1', '7', '1'])).map((i) => i.id), ['1']);
  } finally {
    close();
  }
  const bad = await fakeJira([{ issues: [raw(1, { summary: '' })], isLast: true }]);
  try {
    await assert.rejects(bad.tracker.fetchIssuesByIds(['1']), /tracker_response/);
  } finally {
    bad.close();
  }
});
