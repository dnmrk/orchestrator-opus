#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const sourceRoot = new URL('../src/', import.meta.url).href;
// Node skips native stripping in node_modules; limit this hook to our own packaged source.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
await import('../src/cli.ts');
