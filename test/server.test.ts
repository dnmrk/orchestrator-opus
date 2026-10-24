import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Tracker } from '../src/core.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { startServer } from '../src/server.ts';
import { tmp, writeWorkflow } from './helpers.ts';

test('dashboard + JSON API: state, issue detail, refresh, 404/405, foreign Host rejected', async () => {
  const tracker: Tracker = { fetchIssuesByStates: async () => [], fetchIssuesByIds: async () => [] };
  const workflowPath = writeWorkflow(tmp(), 'tracker: { kind: local }\npolling: { interval_ms: 60000 }\nserver: { port: 0 }');
  const orch = new Orchestrator({ workflowPath, makeTracker: () => tracker, toolCommand: 'x' });
  await orch.start();
  assert.equal(orch.cfg.serverPort, 0);
  orch.scheduleRetry('1', 'DEV-1', 2, 60_000, 'boom', 'file:///t/DEV-1.md');
  const server = await startServer(orch, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const html = await fetch(base + '/');
    assert.match(await html.text(), /<title>Symphony<\/title>/);
    const state = await (await fetch(base + '/api/v1/state')).json();
    assert.deepEqual(state.counts, { running: 0, retrying: 1, parked: 0 });
    assert.equal(state.retrying[0].issue_url, 'file:///t/DEV-1.md');
    assert.equal(state.tracker_kind, 'local');
    const detail = await (await fetch(base + '/api/v1/DEV-1')).json();
    assert.equal(detail.status, 'retrying');
    assert.equal(detail.last_error, 'boom');
    assert.equal((await fetch(base + '/api/v1/NOPE')).status, 404);
    assert.equal((await fetch(base + '/api/v1/state', { method: 'POST' })).status, 405);
    const refresh = await fetch(base + '/api/v1/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(refresh.status, 202);
    assert.equal((await refresh.json()).queued, true);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) =>
      request(base + '/api/v1/state', { headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode!)).end());
    assert.equal(status, 403);
  } finally {
    server.close();
    await orch.stop();
  }
});
