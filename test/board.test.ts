import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { LocalTracker } from '../src/local.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { startServer } from '../src/server.ts';
import { tmp, writeWorkflow } from './helpers.ts';

async function boot() {
  const dir = tmp();
  mkdirSync(join(dir, 'tickets'));
  writeFileSync(join(dir, 'tickets', 'DEV-1.md'), '---\nstate: To Do\ntitle: Existing\nlabels: [agent]\n---\nBody\n');
  writeFileSync(join(dir, 'tickets', 'DEV-9.md'), '---\nstate: Somewhere Else\ntitle: Off board\n---\n');
  const workflowPath = writeWorkflow(dir, [
    'tracker: { kind: local, required_labels: [agent], active_states: [To Do], terminal_states: [Done] }',
    'polling: { interval_ms: 60000 }',
    // writes trigger a refresh, which may dispatch DEV-1; `false` makes any such run fail instantly
    'claude: { command: "false" }',
  ].join('\n'));
  const orch = new Orchestrator({ workflowPath, makeTracker: (cfg) => LocalTracker.fromProvider(cfg.tracker.provider, cfg.workflowDir, cfg.tracker.terminalStates), toolCommand: 'x' });
  orch.reload();
  const server = await startServer(orch, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { dir, orch, server, base, post };
}

test('board lists tickets in configured columns with agent status', async () => {
  const { orch, server, base } = await boot();
  try {
    assert.deepEqual(orch.cfg.boardColumns, ['To Do', 'Human Review', 'Blocked', 'Done']);
    assert.equal(orch.cfg.boardTitle.startsWith('symphony-test-'), true);
    const b = await (await fetch(base + '/api/v1/board')).json();
    assert.deepEqual(b.tickets.map((t: any) => t.identifier), ['DEV-1']);
    assert.equal(b.tickets[0].agent, null);
    assert.equal(b.can_create, true);
    orch.parked.set('DEV-1', 'to do');
    assert.equal((await (await fetch(base + '/api/v1/board')).json()).tickets[0].agent.kind, 'parked');
  } finally {
    server.close();
    await orch.stop();
  }
});

test('create, move, and comment write through the tracker', async () => {
  const { dir, orch, server, post } = await boot();
  try {
    const created = await post('/api/v1/tickets', { title: 'New one', description: 'Do it', state: 'to do', priority: '2', agent: true });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { identifier: 'DEV-10' });
    const file = () => readFileSync(join(dir, 'tickets', 'DEV-10.md'), 'utf8');
    assert.match(file(), /^---\nstate: To Do\ntitle: New one\nlabels:\n  - agent\npriority: 2\ncreated: \S+Z\n---\nDo it\n$/);
    assert.equal((await post('/api/v1/tickets/DEV-10/state', { state: 'human review' })).status, 200);
    assert.match(file(), /^---\nstate: Human Review\n/);
    assert.equal((await post('/api/v1/tickets/DEV-10/comments', { text: 'Looks good' })).status, 200);
    assert.match(file(), /## Comments\n\n### .+\n\nLooks good\n$/);
  } finally {
    server.close();
    await orch.stop();
  }
});

test('validation and cross-site protection on writes', async () => {
  const { orch, server, base, post } = await boot();
  try {
    assert.equal((await post('/api/v1/tickets', { title: '' })).status, 400);
    assert.equal((await post('/api/v1/tickets', { title: 'x', state: 'Nope' })).status, 400);
    assert.equal((await post('/api/v1/tickets', { title: 'x', priority: 7 })).status, 400);
    assert.equal((await post('/api/v1/tickets/DEV-404/state', { state: 'Done' })).status, 400);
    assert.equal((await post('/api/v1/tickets/DEV-1/state', { state: 'Somewhere Else' })).status, 400);
    // A cross-site form/fetch can only send "simple" content types without a preflight.
    assert.equal((await post('/api/v1/tickets', { title: 'x' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post('/api/v1/tickets', { title: 'x' }, { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/v1/refresh', {}, { 'content-type': 'text/plain' })).status, 415);
    const huge = await post('/api/v1/tickets', { title: 'x', description: 'y'.repeat(200_000) });
    assert.equal(huge.status, 413);
    const status = await new Promise<number>((resolve) =>
      request(base + '/api/v1/board', { headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode!)).end());
    assert.equal(status, 403);
  } finally {
    server.close();
    await orch.stop();
  }
});

test('hidden columns are listed, fetched, and valid move targets; title defaults to the board dir', async () => {
  const { dir, orch, server, base, post } = await boot();
  try {
    writeFileSync(orch.o.workflowPath, readFileSync(orch.o.workflowPath, 'utf8').replace('polling:', 'board: { title: shop, columns: [Backlog, To Do], hidden_columns: [Merging, Done] }\npolling:'));
    orch.reload();
    writeFileSync(join(dir, 'tickets', 'DEV-3.md'), '---\nstate: Merging\ntitle: Merge me\n---\n');
    const b = await (await fetch(base + '/api/v1/board')).json();
    assert.equal(b.title, 'shop');
    assert.deepEqual(b.hidden_columns, ['Merging', 'Done']);
    assert.deepEqual(b.tickets.map((t: any) => t.identifier).sort(), ['DEV-1', 'DEV-3']);
    assert.equal((await post('/api/v1/tickets/DEV-3/state', { state: 'done' })).status, 200);
    assert.match(readFileSync(join(dir, 'tickets', 'DEV-3.md'), 'utf8'), /^---\nstate: Done\n/);
  } finally {
    server.close();
    await orch.stop();
  }
});
