import type { ChildProcess } from 'node:child_process';

export type BlockerRef = { id: string | null; identifier: string | null; state: string | null };

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
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  created_at: string | null;
  updated_at: string | null;
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
}

export type NewTicket = { title: string; description: string; state: string; labels: string[]; priority: number | null };

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

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const minLevel = LEVELS[process.env.SYMPHONY_LOG_LEVEL as Level] ?? LEVELS.info;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < minLevel) return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}
