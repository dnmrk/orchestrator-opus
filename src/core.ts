import type { ChildProcess } from 'node:child_process';
import { mkdir, open, readFile, rm, rmdir } from 'node:fs/promises';

export type BlockerRef = { id: string | null; identifier: string | null; state: string | null };
export type AgentProvider = 'claude' | 'codex';
export type AgentSelection = { provider: AgentProvider | null; model: string | null };

/** Shared validation for workflow defaults, ticket headers, Jira labels, and board writes. */
export function parseAgentSelection(provider: unknown, model: unknown): AgentSelection {
  if (provider != null && provider !== 'claude' && provider !== 'codex') throw new Error('agent provider must be claude or codex');
  if (model != null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model))) {
    throw new Error('agent model must be a model ID of at most 200 characters');
  }
  if (model != null && provider == null) throw new Error('agent model requires an explicit provider');
  return { provider: provider ?? null, model: model ?? null };
}

/** Normalized issue (SPEC 4.1.1). Snake_case keys so WORKFLOW.md templates match the spec. */
export type Issue = {
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  base_branch?: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  created_at: string | null;
  updated_at: string | null;
  agent_provider?: AgentProvider | null;
  agent_model?: string | null;
};

export interface Tracker {
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
}

/** Adapter-owned write tools exposed to the agent as `$SYMPHONY_TRACKER` (SPEC 11.5). */
export interface TrackerTools {
  comment(identifier: string, text: string): Promise<void>;
  transition(identifier: string, state: string): Promise<string>;
  /** Board-only (local tracker): create a ticket, returns its identifier. */
  create?(ticket: NewTicket): Promise<string>;
  setBaseBranch?(identifier: string, branch: string): Promise<void>;
  setAgent?(identifier: string, selection: AgentSelection): Promise<void>;
}

export type NewTicket = { base_branch?: string | null; title: string; description: string; state: string; labels: string[]; priority: number | null; agent_provider?: AgentProvider | null; agent_model?: string | null };

export class TrackerError extends Error {
  category: string;
  constructor(category: string, message: string) {
    super(`${category}: ${message}`);
    this.category = category;
  }
}

export const norm = (s: string) => s.trim().toLowerCase();

/** `$NAME` → env value ('' when unset); anything else passes through. */
export function envRef(v: unknown): unknown {
  return typeof v === 'string' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? (process.env[v.slice(1)] ?? '') : v;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** POSIX single-quote for building `bash -lc` command strings. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Children are spawned detached, so -pid kills bash plus everything it started. */
export function killTree(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {}
}

/**
 * Shell prefix for detached commands: SIGKILLs the command's process group (bash is its leader) once this
 * process is gone, so a crashed service can't leave agents or hooks running. Exits quietly when the command ends.
 */
export const orphanGuard = () =>
  `(while kill -0 ${process.pid} && kill -0 $$; do sleep 1; done; kill -0 ${process.pid} || kill -KILL -- -$$) </dev/null >/dev/null 2>&1 &\n`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
};

/**
 * Exclusive lock file holding our pid; resolves to its release function. A holder pid that is gone (or garbage)
 * is stale and taken over; a live holder is waited on for up to `waitMs`, then the call throws.
 */
export async function lockFile(path: string, waitMs = 0): Promise<() => Promise<void>> {
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      const fh = await open(path, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => rm(path, { force: true });
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
    const holder = await readFile(path, 'utf8').catch(() => ''); // '' = just created or just released: wait
    if (holder && !alive(Number(holder))) {
      const recovery = `${path}.reclaim`;
      try { await mkdir(recovery); }
      catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        if (Date.now() >= end) throw new Error(`lock recovery is in progress at ${recovery}; inspect it if a previous recovery was interrupted`);
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      try {
        // Recheck under the recovery guard: another contender may already hold a new lock.
        const current = await readFile(path, 'utf8').catch(() => '');
        if (current && !alive(Number(current))) await rm(path, { force: true });
      } finally { await rmdir(recovery); }
      continue;
    }
    if (Date.now() >= end) throw new Error(`${path} is held by pid ${holder || '?'}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const minLevel = LEVELS[process.env.SYMPHONY_LOG_LEVEL as Level] ?? LEVELS.info;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < minLevel) return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}
