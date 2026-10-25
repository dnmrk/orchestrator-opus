import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { Liquid } from 'liquidjs';
import { envRef, errMsg, norm, type Issue } from './core.ts';

export class WorkflowError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export type Workflow = { path: string; config: Record<string, any>; promptTemplate: string };

export type Config = {
  /** Directory containing WORKFLOW.md; adapters resolve relative paths against it. */
  workflowDir: string;
  tracker: {
    kind: string;
    provider: Record<string, unknown>;
    requiredLabels: string[];
    activeStates: string[];
    terminalStates: string[];
  };
  pollIntervalMs: number;
  /** SPEC 13.7 extension: HTTP dashboard port (0 = ephemeral), null = disabled. */
  serverPort: number | null;
  /** Board view columns, in order (states outside these lists don't appear on the board). */
  boardColumns: string[];
  /** Listed under "Hidden columns" with counts; still valid move targets. */
  boardHidden: string[];
  boardTitle: string;
  workspaceRoot: string;
  /** Deviation from SPEC 9: every issue runs in this one existing directory (never created or deleted). */
  workspaceShared: string | null;
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrent: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentByState: Record<string, number>;
    /** Where a ticket goes when a worker exhausts max_turns while it is still active. */
    blockedState: string;
  };
  claude: {
    command: string;
    model: string | null;
    permissionMode: string;
    allowedTools: string[];
    turnTimeoutMs: number;
    stallTimeoutMs: number;
  };
  /** Extension: commands Symphony runs when an agent moves a ticket to handoffState; none = no gate. */
  checks: { commands: string[]; handoffState: string; timeoutMs: number };
};

export function loadWorkflow(path: string): Workflow {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new WorkflowError('missing_workflow_file', `cannot read ${path}: ${errMsg(e)}`);
  }
  const lines = text.split(/\r?\n/);
  let config: unknown = {};
  let body = text;
  if (lines[0].trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end === -1) throw new WorkflowError('workflow_parse_error', 'front matter is not closed with ---');
    try {
      config = parseYaml(lines.slice(1, end).join('\n')) ?? {};
    } catch (e) {
      throw new WorkflowError('workflow_parse_error', errMsg(e));
    }
    body = lines.slice(end + 1).join('\n');
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new WorkflowError('workflow_front_matter_not_a_map', 'YAML front matter must be a map');
  }
  return { path, config: config as Record<string, any>, promptTemplate: body.trim() };
}

export const workflowMtime = (path: string) => statSync(path).mtimeMs;

function int(v: unknown, def: number, name: string, min: number): number {
  if (v === undefined || v === null) return def;
  const n = typeof v === 'string' ? Number(envRef(v)) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min) {
    throw new WorkflowError('invalid_config', `${name} must be an integer >= ${min}`);
  }
  return n;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const strList = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new WorkflowError('invalid_config', `${name} must be a list`);
  return v.map(String);
};

const dedupe = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => norm(y) === norm(x)) === i);

/** `~` and `$VAR` expansion, relative to baseDir (SPEC 6.1). */
export function expandPath(v: unknown, baseDir: string): string {
  let p = String(envRef(v));
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  return resolve(baseDir, p);
}

// Adapter profile defaults for tracker.active_states / terminal_states.
const DEFAULT_STATES: Record<string, { active: string[]; terminal: string[] }> = {
  jira: { active: ['To Do', 'In Progress'], terminal: ['Done'] },
  local: { active: ['To Do', 'In Progress'], terminal: ['Done'] },
};

/** Typed view of the front matter with defaults (SPEC 6.4). Throws WorkflowError on invalid config. */
export function buildConfig(wf: Workflow): Config {
  const c = wf.config;
  const t = c.tracker ?? {};
  const kind = str(t.kind);
  if (!kind) throw new WorkflowError('invalid_config', 'tracker.kind is required');
  const defaults = DEFAULT_STATES[kind] ?? { active: undefined, terminal: undefined };
  const activeStates = strList(t.active_states, 'tracker.active_states') ?? defaults.active;
  const terminalStates = strList(t.terminal_states, 'tracker.terminal_states') ?? defaults.terminal;
  if (!activeStates || !terminalStates) {
    throw new WorkflowError('invalid_config', 'tracker.active_states and tracker.terminal_states are required');
  }

  const byState: Record<string, number> = {};
  for (const [state, n] of Object.entries(c.agent?.max_concurrent_agents_by_state ?? {})) {
    if (Number.isInteger(n) && (n as number) > 0) byState[norm(state)] = n as number;
  }

  const handoffState = str(c.checks?.handoff_state)?.trim() ?? 'Human Review';
  if ([...activeStates, ...terminalStates].some((s) => norm(s) === norm(handoffState))) {
    throw new WorkflowError('invalid_config', 'checks.handoff_state must not be an active or terminal state');
  }

  const claude = c.claude ?? {};
  const command = str(claude.command) ?? 'claude';
  const workflowDir = dirname(resolve(wf.path));
  const shared = c.workspace?.shared ? expandPath(c.workspace.shared, workflowDir) : null;
  if (shared && !(existsSync(shared) && statSync(shared).isDirectory())) {
    throw new WorkflowError('invalid_config', `workspace.shared ${shared} is not an existing directory`);
  }
  return {
    workflowDir,
    tracker: {
      kind,
      provider: t.provider ?? {},
      requiredLabels: strList(t.required_labels, 'tracker.required_labels') ?? [],
      activeStates,
      terminalStates,
    },
    pollIntervalMs: int(c.polling?.interval_ms, 30_000, 'polling.interval_ms', 1000),
    serverPort: c.server?.port === undefined ? null : int(c.server.port, 0, 'server.port', 0),
    boardColumns: strList(c.board?.columns, 'board.columns') ?? dedupe([...activeStates, 'Human Review', str(c.agent?.blocked_state)?.trim() ?? 'Blocked', ...terminalStates]),
    boardHidden: strList(c.board?.hidden_columns, 'board.hidden_columns') ?? [],
    boardTitle: str(c.board?.title)?.trim() ?? basename(workflowDir),
    workspaceRoot: c.workspace?.root
      ? expandPath(c.workspace.root, workflowDir)
      : resolve(tmpdir(), 'symphony_workspaces'),
    workspaceShared: shared,
    hooks: {
      afterCreate: str(c.hooks?.after_create),
      beforeRun: str(c.hooks?.before_run),
      afterRun: str(c.hooks?.after_run),
      beforeRemove: str(c.hooks?.before_remove),
      timeoutMs: int(c.hooks?.timeout_ms, 60_000, 'hooks.timeout_ms', 1),
    },
    agent: {
      // One working tree can only host one agent at a time.
      maxConcurrent: shared ? 1 : int(c.agent?.max_concurrent_agents, 10, 'agent.max_concurrent_agents', 1),
      maxTurns: int(c.agent?.max_turns, 20, 'agent.max_turns', 1),
      maxRetryBackoffMs: int(c.agent?.max_retry_backoff_ms, 300_000, 'agent.max_retry_backoff_ms', 1000),
      maxConcurrentByState: byState,
      blockedState: str(c.agent?.blocked_state)?.trim() ?? 'Blocked',
    },
    claude: {
      command,
      model: str(claude.model),
      // Unattended runs can't answer permission prompts; see README "Trust posture".
      permissionMode: str(claude.permission_mode) ?? 'bypassPermissions',
      allowedTools: strList(claude.allowed_tools, 'claude.allowed_tools') ?? [],
      turnTimeoutMs: int(claude.turn_timeout_ms, 3_600_000, 'claude.turn_timeout_ms', 1000),
      stallTimeoutMs: int(claude.stall_timeout_ms, 300_000, 'claude.stall_timeout_ms', -Infinity),
    },
    checks: {
      commands: strList(c.checks?.commands, 'checks.commands') ?? [],
      handoffState,
      timeoutMs: int(c.checks?.timeout_ms, 600_000, 'checks.timeout_ms', 1),
    },
  };
}

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export async function renderPrompt(template: string, issue: Issue, attempt: number | null): Promise<string> {
  const source = template || 'You are working on an issue from the configured tracker.';
  try {
    return (await liquid.parseAndRender(source, { issue, attempt })).trim();
  } catch (e) {
    const parse = e instanceof Error && /Parse|Tokenization/.test(e.name);
    throw new WorkflowError(parse ? 'template_parse_error' : 'template_render_error', errMsg(e));
  }
}
