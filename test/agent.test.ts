import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, waitFor } from './helpers.ts';

const PARENT = fileURLToPath(new URL('./fixtures/orphan-parent.mjs', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a killed service takes its running agent down with it', async () => {
  const beat = join(tmp(), 'beat');
  const parent = spawn(process.execPath, [PARENT, beat], { stdio: 'ignore' });
  await waitFor(() => existsSync(beat));
  parent.kill('SIGKILL');
  await sleep(2500); // the guard polls once a second
  const last = statSync(beat).mtimeMs;
  await sleep(500);
  assert.equal(statSync(beat).mtimeMs, last, 'agent still running after its service died');
});
