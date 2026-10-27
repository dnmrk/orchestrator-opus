import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmp } from './helpers.ts';

const exec = promisify(execFile);

test('source and installed launchers omit the stripping notice and preserve other warnings', async () => {
  const installed = join(tmp(), 'node_modules', 'symphony');
  await mkdir(installed, { recursive: true });
  for (const entry of ['bin', 'src', 'package.json']) {
    await cp(resolve(entry), join(installed, entry), { recursive: true });
  }
  await symlink(resolve('node_modules'), join(installed, 'node_modules'));
  for (const launcher of [resolve('bin/symphony.mjs'), join(installed, 'bin/symphony.mjs')]) {
    const help = await exec(process.execPath, [launcher, '--help']);
    assert.match(help.stdout, /^usage:/);
    assert.equal(help.stderr, '');
    const probe = `
      import assert from 'node:assert/strict';
      const original = process.emitWarning;
      process.argv = [process.execPath, ${JSON.stringify(launcher)}, '--help'];
      await import(${JSON.stringify(pathToFileURL(launcher).href)});
      assert.equal(process.emitWarning, original);
      process.emitWarning('unrelated experimental feature', 'ExperimentalWarning');
      process.emitWarning('unrelated deprecation', 'DeprecationWarning');
    `;
    const warnings = await exec(process.execPath, ['--input-type=module', '-e', probe]);
    assert.doesNotMatch(warnings.stderr, /stripTypeScriptTypes/);
    assert.match(warnings.stderr, /ExperimentalWarning: unrelated experimental feature/);
    assert.match(warnings.stderr, /DeprecationWarning: unrelated deprecation/);
  }
});
