#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

// Initialize the stripping API without its one-time notice; keep all other warnings intact.
const emitWarning = process.emitWarning;
try {
  process.emitWarning = (warning, ...args) => {
    if (warning === 'stripTypeScriptTypes is an experimental feature and might change at any time'
        && args[0] === 'ExperimentalWarning') return;
    return emitWarning.call(process, warning, ...args);
  };
  stripTypeScriptTypes('');
} finally {
  process.emitWarning = emitWarning;
}

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
