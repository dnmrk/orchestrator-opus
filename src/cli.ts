#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errMsg, log, TrackerError, type Tracker, type TrackerTools } from './core.ts';
import { JiraTracker, jiraProvider } from './jira.ts';
import { LocalTracker } from './local.ts';
import { Orchestrator } from './orchestrator.ts';
import { startServer } from './server.ts';
import { buildConfig, loadWorkflow, type Config } from './workflow.ts';

const USAGE = `usage:
  symphony [path/to/WORKFLOW.md] [--port N]      run the orchestrator (default ./WORKFLOW.md);
                                                 --port (or server.port) serves the dashboard on 127.0.0.1
  symphony tracker comment <KEY> [text | -]      (agent tool) comment on the issue; '-' or no text reads stdin
  symphony tracker transition <KEY> <state>      (agent tool) move the issue to <state>`;

function makeTracker(cfg: Config): Tracker & TrackerTools {
  const { kind, provider, terminalStates } = cfg.tracker;
  if (kind === 'local') return LocalTracker.fromProvider(provider, cfg.workflowDir, terminalStates);
  if (kind === 'jira') return new JiraTracker(jiraProvider(provider), terminalStates);
  throw new TrackerError('unsupported_tracker_kind', `tracker.kind "${kind}" (supported: local, jira)`);
}

async function trackerTool([op, key, ...rest]: string[]) {
  const cfg = buildConfig(loadWorkflow(process.env.SYMPHONY_WORKFLOW ?? resolve('WORKFLOW.md')));
  const current = process.env.SYMPHONY_ISSUE_IDENTIFIER;
  if (!key) throw new Error(USAGE);
  // Tools are scoped to the issue the agent was dispatched for (SPEC 11.5).
  if (current && key !== current) throw new Error(`refusing to touch ${key}: this session is scoped to ${current}`);
  const tracker = makeTracker(cfg);
  if (op === 'comment') {
    const text = rest.length && rest[0] !== '-' ? rest.join(' ') : readFileSync(0, 'utf8');
    await tracker.comment(key, text);
    console.log(`commented on ${key}`);
  } else if (op === 'transition' && rest.length) {
    console.log(`${key} → ${await tracker.transition(key, rest.join(' '))}`);
  } else throw new Error(USAGE);
}

async function main() {
  const args = process.argv.slice(2);
  const [cmd, ...rest] = args;
  if (cmd === '-h' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'tracker') return trackerTool(rest);
  const portAt = args.indexOf('--port');
  const cliPort = portAt === -1 ? null : Number(args.splice(portAt, 2)[1]);
  if (cliPort !== null && !(Number.isInteger(cliPort) && cliPort >= 0)) throw new Error(`--port must be an integer >= 0\n${USAGE}`);

  const orch = new Orchestrator({
    workflowPath: resolve(args[0] ?? 'WORKFLOW.md'),
    makeTracker,
    // A plain executable path, so `$SYMPHONY_TRACKER ...` works unquoted in the agent's shell.
    toolCommand: fileURLToPath(new URL('../bin/symphony-tracker', import.meta.url)),
  });
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  const shutdown = async (signal: string) => {
    log('info', 'shutting down', { signal });
    server?.close();
    await orch.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await orch.start();
  // Listener settings are read once; changing server.port needs a restart (allowed by SPEC 13.7).
  const port = cliPort ?? orch.cfg.serverPort;
  if (port !== null) {
    // orch.start() may already have dispatched; don't exit past it and orphan its agents.
    server = await startServer(orch, port).catch(async (e) => {
      await orch.stop();
      throw e;
    });
  }
}

main().catch((e) => {
  console.error(errMsg(e));
  process.exit(1);
});
