import { compactDescription, handoffInstructions } from './handoff.ts';
import { branches, git } from './git.ts';
import { worktreeStarted } from './worktree.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, unwatchFile, watchFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, type AgentEvent } from './agent.ts';
import { errMsg, lockFile, log, norm, type AgentProvider, type Issue, type Tracker, type TrackerTools } from './core.ts';
import { buildConfig, expandPath, loadWorkflow, renderPrompt, workflowMtime, type Config, type Workflow } from './workflow.ts';
import { ensureWorkspace, hookEnv, removeWorkspace, runHook } from './workspace.ts';

type Stop = { reason: string; release: boolean; cleanup: boolean };

type Running = {
  issue: Issue;
  identifier: string;
  attempt: number | null;
  abort: AbortController;
  done?: Promise<void>;
  stop?: Stop;
  startedAt: number;
  sessionId: string;
  provider: AgentProvider;
  model: string | null;
  stallTimeoutMs: number;
  turns: number;
  lastEventAt: number | null;
  lastEvent: string | null;
  lastMessage: string | null;
  tokens: { input: number; output: number };
  workspace: string | null;
  /** Handoff checks are running; exempt from stall detection (they have their own timeout). */
  checking?: boolean;
  events: { at: number; event: string; message: string | null }[];
};

type Retry = { identifier: string; url: string | null; attempt: number; dueAt: number; timer: NodeJS.Timeout; error: string | null };

type Outcome = { events: Running['events']; workspace: string | null; identifier: string; url: string | null; provider: AgentProvider; model: string | null; outcome: string; at: number; turns: number; tokens: { input: number; output: number }; error: string | null };

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const tokens = (t: { input: number; output: number }) => ({ input_tokens: t.input, output_tokens: t.output, total_tokens: t.input + t.output });

export type OrchestratorOptions = {
  workflowPath: string;
  makeTracker: (cfg: Config) => Tracker & Partial<TrackerTools>;
  /** Executable the agent uses for tracker writes, exposed as $SYMPHONY_TRACKER. */
  toolCommand: string;
};

/** SPEC 8.2 sort: priority 1..4 first, then oldest, then identifier. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  const p = (i: Issue) => (i.priority !== null && i.priority >= 1 && i.priority <= 4 ? i.priority : 5);
  const t = (i: Issue) => (i.created_at ? Date.parse(i.created_at) : Infinity);
  return [...issues].sort(
    (a, b) => p(a) - p(b) || t(a) - t(b) || (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0),
  );
}

export function continuationPrompt(issue: Issue, turn: number, maxTurns: number): string {
  return [
    `Continue working on ${issue.identifier}. It is still in "${issue.state}", which is an active state (turn ${turn} of ${maxTurns}).`,
    'Pick up from the current workspace state; do not redo finished work.',
    'If the work is complete, move the issue to its handoff state. If you are blocked, record why on the issue and move it accordingly.',
  ].join('\n');
}

export function checksFailedPrompt(issue: Issue, failure: string, turn: number, maxTurns: number): string {
  return [
    `You moved ${issue.identifier} to its handoff state, but Symphony's checks failed, so it was moved back to "${issue.state}" (turn ${turn} of ${maxTurns}).`,
    failure,
    'Fix the cause in the workspace, then move the issue to its handoff state again. The checks run again each time.',
  ].join('\n');
}

export class Orchestrator {
  o: OrchestratorOptions;
  workflow!: Workflow;
  cfg!: Config;
  tracker!: Tracker & Partial<TrackerTools>;
  configError: string | null = null;
  lastMtime = -1;

  running = new Map<string, Running>();
  claimed = new Set<string>();
  retries = new Map<string, Retry>();
  completed = new Set<string>();
  totals = { input: 0, output: 0, seconds: 0, costUsd: 0 };
  costComplete = true;
  rateLimits: unknown = null;
  recent: Outcome[] = [];
  /** issue id → normalized state when it was blocked but couldn't be moved; skipped until the state changes. */
  parked = new Map<string, string>();

  unlock: (() => Promise<void>) | null = null;
  tickTimer: NodeJS.Timeout | null = null;
  ticking = false;
  stopped = false;

  constructor(o: OrchestratorOptions) {
    this.o = o;
  }

  /** SPEC 6.2: re-apply WORKFLOW.md on change; keep the last good config if the new one is invalid. */
  reload() {
    let mtime: number;
    try {
      mtime = workflowMtime(this.o.workflowPath);
    } catch (e) {
      this.configError = `missing_workflow_file: ${errMsg(e)}`;
      return;
    }
    if (mtime === this.lastMtime) return;
    this.lastMtime = mtime;
    try {
      const workflow = loadWorkflow(this.o.workflowPath);
      const cfg = buildConfig(workflow);
      const tracker = this.o.makeTracker(cfg);
      const first = !this.cfg;
      Object.assign(this, { workflow, cfg, tracker, configError: null });
      log('info', first ? 'workflow loaded' : 'workflow reloaded', { path: this.o.workflowPath });
    } catch (e) {
      this.configError = errMsg(e);
      log('error', 'invalid workflow; keeping last good config, dispatch paused', { error: this.configError });
    }
  }

  async start() {
    this.reload();
    if (this.configError || !this.cfg) throw new Error(`startup validation failed: ${this.configError}`);
    // Running/claimed state is in memory, so a second service on the same workspace would dispatch the same tickets.
    const target = this.cfg.workspaceShared ?? this.cfg.workspaceRoot;
    const lock = this.cfg.projectRoot ? join(this.cfg.workflowDir, 'daemon.lock') : join(tmpdir(), `symphony-${createHash('sha256').update(target).digest('hex').slice(0, 16)}.lock`);
    this.unlock = await lockFile(lock).catch((e) => {
      throw new Error(`another symphony service is already using ${target} (${errMsg(e)})`);
    });
    watchFile(this.o.workflowPath, { interval: 2000 }, () => this.reload());
    await this.startupCleanup();
    this.scheduleTick(0);
  }

  async stop() {
    this.stopped = true;
    unwatchFile(this.o.workflowPath);
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    for (const e of this.running.values()) this.stopRun(e, 'shutdown', true, false);
    await Promise.allSettled([...this.running.values()].map((e) => e.done));
    await this.unlock?.();
    this.unlock = null;
  }

  async startupCleanup() {
    if (!existsSync(this.cfg.workspaceRoot)) return;
    try {
      for (const issue of await this.tracker.fetchIssuesByStates(this.cfg.tracker.terminalStates)) {
        await removeWorkspace(this.cfg, issue.identifier).catch((e) => log('warn', 'cleanup failed', { issue: issue.identifier, error: errMsg(e) }));
      }
    } catch (e) {
      log('warn', 'startup terminal cleanup skipped', { error: errMsg(e) });
    }
  }

  scheduleTick(ms: number) {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), ms);
  }

  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.reload();
      await this.reconcile();
      if (this.configError) return log('error', 'dispatch skipped: invalid workflow', { error: this.configError });
      let candidates: Issue[];
      try {
        candidates = await this.tracker.fetchIssuesByStates(this.cfg.tracker.activeStates);
      } catch (e) {
        return log('error', 'candidate fetch failed', { error: errMsg(e) });
      }
      for (const issue of sortForDispatch(candidates)) {
        if (this.stopped || this.availableSlots() <= 0) break;
        if (this.parked.has(issue.id)) {
          if (this.parked.get(issue.id) === norm(issue.state)) continue;
          this.parked.delete(issue.id);
        }
        if (this.eligible(issue) && !this.claimed.has(issue.id) && this.availableSlots(issue.state) > 0) this.dispatch(issue, null);
      }
    } finally {
      this.ticking = false;
      this.scheduleTick(this.cfg.pollIntervalMs);
    }
  }

  isTerminal(state: string) {
    return this.cfg.tracker.terminalStates.some((s) => norm(s) === norm(state));
  }

  isActive(state: string) {
    return !this.isTerminal(state) && this.cfg.tracker.activeStates.some((s) => norm(s) === norm(state));
  }

  /** SPEC 8.2 `issue_routable`: adapter says yes and every required label is present. */
  routable(issue: Issue) {
    return issue.dispatchable && this.cfg.tracker.requiredLabels.every((l) => norm(l) !== '' && issue.labels.includes(norm(l)));
  }

  /** State/routing/running checks. Claims and slots are checked by the caller (they differ for retries). */
  eligible(issue: Issue) {
    return Boolean(issue.id && issue.identifier && issue.title && issue.state) && this.isActive(issue.state) && this.routable(issue) && !this.running.has(issue.id);
  }

  availableSlots(state?: string) {
    const global = this.cfg.agent.maxConcurrent - this.running.size;
    const limit = state === undefined ? undefined : this.cfg.agent.maxConcurrentByState[norm(state)];
    if (limit === undefined) return Math.max(global, 0);
    const inState = [...this.running.values()].filter((r) => norm(r.issue.state) === norm(state!)).length;
    return Math.max(Math.min(global, limit - inState), 0);
  }

  dispatch(issue: Issue, attempt: number | null) {
    const cfg = this.cfg;
    const provider = issue.agent_provider ?? cfg.agent.provider;
    const model = issue.agent_model ?? cfg[provider].model;
    const retry = this.retries.get(issue.id);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(issue.id);
    const entry: Running = {
      issue,
      identifier: issue.identifier,
      attempt,
      abort: new AbortController(),
      startedAt: Date.now(),
      sessionId: provider === 'claude' ? randomUUID() : '',
      provider,
      model,
      stallTimeoutMs: cfg[provider].stallTimeoutMs,
      turns: 0,
      lastEventAt: null,
      lastEvent: null,
      lastMessage: null,
      tokens: { input: 0, output: 0 },
      workspace: null,
      events: [],
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    log('info', 'dispatch', { issue: issue.identifier, state: issue.state, attempt, provider, model, session: entry.sessionId });
    entry.done = this.runWorker(entry, cfg).then(
      (exhausted) => this.onWorkerExit(entry, null, exhausted),
      (e) => this.onWorkerExit(entry, e),
    );
  }

  agentEnv(issue: Issue, path: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...hookEnv(issue.identifier, path),
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_WORKFLOW: this.o.workflowPath,
      SYMPHONY_TRACKER: this.o.toolCommand,
      SYMPHONY_NODE: process.execPath,
    };
  }

  /** SPEC 16.5 worker attempt. Uses the config snapshot from dispatch time. Resolves true if max_turns ran out while the issue was still active. */
  async runWorker(e: Running, cfg: Config): Promise<boolean> {
    const template = this.workflow.promptTemplate;
    const ws = await ensureWorkspace(cfg, e.identifier, async () => (await this.tracker.fetchIssuesByIds([e.issue.id]))[0]?.base_branch ?? null);
    e.workspace = ws.path;
    const writableRoots = cfg.projectRoot && e.provider === 'codex' ? [
      expandPath(cfg.tracker.provider.dir ?? 'tickets', cfg.workflowDir),
      await git(ws.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    ] : undefined;
    const env = hookEnv(e.identifier, ws.path);
    if (cfg.hooks.beforeRun) await runHook('before_run', cfg.hooks.beforeRun, ws.path, cfg.hooks.timeoutMs, env, e.abort.signal);
    try {
      let failure: string | null = null;
      for (let turn = 1; ; turn++) {
        const prompt = turn === 1 ? await renderPrompt(template, cfg.tracker.kind === 'local'
          ? { ...e.issue, description: compactDescription(e.issue.description) } : e.issue, e.attempt)
          + (cfg.tracker.kind === 'local' ? `\n\n${handoffInstructions}` : '')
          : failure ? checksFailedPrompt(e.issue, failure, turn, cfg.agent.maxTurns)
          : continuationPrompt(e.issue, turn, cfg.agent.maxTurns);
        failure = null;
        e.turns = turn;
        let usageReported = false;
        const previousState = e.issue.state;
        const options = {
          cwd: ws.path,
          writableRoots,
          sessionId: e.sessionId,
          resume: turn > 1,
          prompt,
          env: this.agentEnv(e.issue, ws.path),
          signal: e.abort.signal,
          onEvent: (ev: AgentEvent) => {
            usageReported ||= ev.usage !== undefined;
            this.onAgentEvent(e, ev);
          },
        };
        const beforeUsage = { ...e.tokens };
        try {
          if (e.provider === 'codex') {
            this.costComplete = false; // Codex reports tokens, not a billed USD total.
            await runTurn({ ...options, provider: 'codex', cfg: { ...cfg.codex, model: e.model! } });
          } else await runTurn({ ...options, cfg: { ...cfg.claude, model: e.model } });
        } finally {
          if (usageReported) {
            await this.tracker.recordUsage?.(e.identifier, {
              input: e.tokens.input - beforeUsage.input, output: e.tokens.output - beforeUsage.output,
            }, previousState);
          }
        }
        const [fresh] = await this.tracker.fetchIssuesByIds([e.issue.id]);
        if (!fresh) return false;
        const prev = e.issue.state;
        e.issue = fresh;
        if (cfg.checks.commands.length && norm(fresh.state) === norm(cfg.checks.handoffState) && this.routable(fresh)) {
          failure = await this.runChecks(e, ws.path, env, prev);
          if (!failure) return false;
          if (turn >= cfg.agent.maxTurns) return true;
          continue;
        }
        if (!this.isActive(fresh.state) || !this.routable(fresh)) return false;
        if (turn >= cfg.agent.maxTurns) return true;
      }
    } finally {
      if (cfg.hooks.afterRun) await runHook('after_run', cfg.hooks.afterRun, ws.path, cfg.hooks.timeoutMs, env).catch(() => {});
    }
  }

  /** Gate for an agent's move to the handoff state. Returns null if every check passed, else the failure (the ticket is moved back to `prev`). */
  async runChecks(e: Running, cwd: string, env: Record<string, string>, prev: string): Promise<string | null> {
    const { commands, timeoutMs } = this.cfg.checks;
    e.checking = true;
    e.lastMessage = 'Running checks';
    let failure: string | null = null;
    try {
      for (const cmd of commands) {
        try {
          await runHook('check', cmd, cwd, timeoutMs, env, e.abort.signal);
        } catch (x) {
          if (e.abort.signal.aborted) throw x; // stopped (shutdown/stall/terminal), not a check failure
          failure = `Check failed: ${cmd}\n${errMsg(x)}`;
          break;
        }
      }
    } finally {
      e.checking = false;
    }
    if (!failure) {
      const sha = await runHook('git head', 'git rev-parse HEAD', cwd, 10_000, env, e.abort.signal).catch(() => null);
      await this.tracker.comment?.(e.identifier, `Symphony checks passed${sha ? ` at ${sha}` : ''}:\n${commands.map((c) => `- ${c}`).join('\n')}`);
      return null;
    }
    await this.tracker.comment?.(e.identifier, `Symphony: ${failure}`);
    if (!this.tracker.transition) throw new Error('tracker has no transition tool');
    await this.tracker.transition(e.identifier, prev);
    e.issue = (await this.tracker.fetchIssuesByIds([e.issue.id]))[0] ?? e.issue;
    return failure;
  }

  onAgentEvent(e: Running, ev: AgentEvent) {
    if (ev.sessionId) e.sessionId = ev.sessionId;
    e.lastEventAt = ev.at;
    e.lastEvent = ev.type;
    if (ev.message) e.lastMessage = ev.message;
    if (ev.usage) {
      e.tokens.input += ev.usage.input;
      e.tokens.output += ev.usage.output;
      this.totals.input += ev.usage.input;
      this.totals.output += ev.usage.output;
    }
    if (ev.costUsd) this.totals.costUsd += ev.costUsd;
    if (ev.rateLimits) this.rateLimits = ev.rateLimits;
    // Hook/thinking chatter still counts for stall detection but would bury real progress.
    if (ev.message || ev.type === 'system/init' || !ev.type.startsWith('system/')) {
      e.events.push({ at: ev.at, event: ev.type, message: ev.message ?? null });
      if (e.events.length > 50) e.events.shift();
    }
    log('debug', 'agent event', { issue: e.identifier, turn: e.turns, event: ev.type, message: ev.message });
  }

  onWorkerExit(e: Running, err: unknown, exhausted = false) {
    const id = e.issue.id;
    if (this.running.get(id) !== e) return;
    this.running.delete(id);
    this.totals.seconds += (Date.now() - e.startedAt) / 1000;
    const summary = { issue: e.identifier, provider: e.provider, model: e.model, turns: e.turns, tokens: e.tokens, seconds: Math.round((Date.now() - e.startedAt) / 1000) };
    const outcome = e.stop?.release ? 'stopped' : err || e.stop ? 'failed' : exhausted ? 'blocked' : 'finished';
    this.recent.unshift({ events: e.events, workspace: e.workspace, identifier: e.identifier, url: e.issue.url, provider: e.provider, model: e.model, outcome, at: Date.now(), turns: e.turns, tokens: { ...e.tokens }, error: e.stop?.reason ?? (err ? errMsg(err) : null) });
    this.recent.length = Math.min(this.recent.length, 20);

    if (e.stop?.release) {
      log('info', 'worker stopped', { ...summary, reason: e.stop.reason });
      this.claimed.delete(id);
      if (e.stop.cleanup) void removeWorkspace(this.cfg, e.identifier).catch((x) => log('warn', 'cleanup failed', { issue: e.identifier, error: errMsg(x) }));
      return;
    }
    if (!err && !e.stop && exhausted) return void this.block(e);
    if (!err && !e.stop) {
      log('info', 'worker finished', summary);
      this.completed.add(id);
      return this.scheduleRetry(id, e.identifier, 1, 1000, null, e.issue.url);
    }
    const attempt = (e.attempt ?? 0) + 1;
    const error = e.stop?.reason ?? errMsg(err);
    log('warn', 'worker failed', { ...summary, error, retryAttempt: attempt });
    this.scheduleRetry(id, e.identifier, attempt, this.backoff(attempt), error, e.issue.url);
  }

  /**
   * Deviation from SPEC 7.1 (continuation retry): a run that used every turn without reaching a
   * handoff state would otherwise be re-dispatched about once a second, indefinitely.
   */
  async block(e: Running) {
    const id = e.issue.id;
    const target = this.cfg.agent.blockedState;
    const reason = `Symphony: used all ${e.turns} turns without reaching a handoff state, so it was moved to ${target}. Move it back to an active state to retry.`;
    log('warn', 'max turns exhausted; blocking issue', { issue: e.identifier, turns: e.turns, state: target });
    this.parked.set(id, norm(e.issue.state)); // set before releasing the claim so a tick can't race the transition
    this.claimed.delete(id);
    try {
      if (!this.tracker.transition) throw new Error('tracker has no transition tool');
      await this.tracker.comment?.(e.identifier, reason);
      await this.tracker.transition(e.identifier, target);
      this.parked.delete(id);
    } catch (x) {
      log('error', `could not move issue to ${target}; it is skipped until its state changes`, { issue: e.identifier, error: errMsg(x) });
    }
  }

  backoff(attempt: number) {
    return Math.min(10_000 * 2 ** (attempt - 1), this.cfg.agent.maxRetryBackoffMs);
  }

  scheduleRetry(issueId: string, identifier: string, attempt: number, delayMs: number, error: string | null, url: string | null = null) {
    if (this.stopped) return;
    const old = this.retries.get(issueId);
    if (old) clearTimeout(old.timer);
    this.claimed.add(issueId);
    const timer = setTimeout(() => void this.onRetry(issueId), delayMs);
    this.retries.set(issueId, { identifier, url, attempt, dueAt: Date.now() + delayMs, timer, error });
  }

  /** SPEC 16.6 on_retry_timer. */
  async onRetry(issueId: string) {
    const r = this.retries.get(issueId);
    if (!r || this.stopped) return;
    this.retries.delete(issueId);
    const requeue = (error: string) => this.scheduleRetry(issueId, r.identifier, r.attempt + 1, this.backoff(r.attempt + 1), error, r.url);
    let issues: Issue[];
    try {
      issues = await this.tracker.fetchIssuesByIds([issueId]);
    } catch {
      return requeue('retry refresh failed');
    }
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return void this.claimed.delete(issueId);
    if (this.isTerminal(issue.state)) {
      this.claimed.delete(issueId);
      return removeWorkspace(this.cfg, issue.identifier).catch((e) => log('warn', 'cleanup failed', { issue: issue.identifier, error: errMsg(e) }));
    }
    if (!this.eligible(issue)) return void this.claimed.delete(issueId);
    if (this.configError) return requeue('invalid workflow');
    if (this.availableSlots(issue.state) <= 0) return requeue('no available orchestrator slots');
    this.dispatch(issue, r.attempt);
  }

  stopRun(e: Running, reason: string, release: boolean, cleanup: boolean) {
    if (e.stop) return;
    e.stop = { reason, release, cleanup };
    log('info', 'stopping worker', { issue: e.identifier, reason });
    e.abort.abort(reason);
  }

  /** SPEC 8.5: stall detection, then tracker state refresh for running issues. */
  async reconcile() {
    const now = Date.now();
    for (const e of this.running.values()) {
      const stallMs = e.stallTimeoutMs;
      if (stallMs > 0 && !e.checking && now - (e.lastEventAt ?? e.startedAt) > stallMs) {
        this.stopRun(e, `stalled: no agent events for ${stallMs}ms`, false, false);
      }
    }
    const ids = [...this.running.values()].filter((e) => !e.stop).map((e) => e.issue.id);
    if (!ids.length) return;
    let fresh: Issue[];
    try {
      fresh = await this.tracker.fetchIssuesByIds(ids);
    } catch (err) {
      return log('warn', 'running-state refresh failed; workers keep running', { error: errMsg(err) });
    }
    const byId = new Map(fresh.map((i) => [i.id, i]));
    for (const id of ids) {
      const e = this.running.get(id);
      if (!e || e.stop) continue;
      const issue = byId.get(id);
      if (!issue) this.stopRun(e, 'issue no longer visible', true, false);
      else if (this.isTerminal(issue.state)) this.stopRun(e, `issue is terminal (${issue.state})`, true, true);
      else if (this.cfg.checks.commands.length && norm(issue.state) === norm(this.cfg.checks.handoffState)) continue; // the worker owns the gate (and e.issue, which holds the last active state)
      else if (!this.isActive(issue.state)) this.stopRun(e, `issue left active states (${issue.state})`, true, false);
      else if (!this.routable(issue)) this.stopRun(e, 'issue no longer routable', true, false);
      else e.issue = issue;
    }
  }

  // --- Observability (SPEC 13.3 / 13.7). Read-only views of orchestrator state.

  runningRow(id: string, e: Running) {
    return {
      issue_id: id,
      issue_identifier: e.identifier,
      issue_url: e.issue.url,
      title: e.issue.title,
      state: e.issue.state,
      session_id: e.sessionId,
      provider: e.provider,
      model: e.model,
      turn_count: e.turns,
      attempt: e.attempt,
      last_event: e.lastEvent,
      last_message: e.lastMessage,
      started_at: iso(e.startedAt),
      last_event_at: iso(e.lastEventAt),
      stopping: e.stop?.reason ?? null,
      tokens: tokens(e.tokens),
    };
  }

  retryRow(id: string, r: Retry) {
    return { issue_id: id, issue_identifier: r.identifier, issue_url: r.url, attempt: r.attempt, due_at: iso(r.dueAt), error: r.error };
  }

  snapshot() {
    const now = Date.now();
    const active = [...this.running.values()].reduce((s, e) => s + (now - e.startedAt) / 1000, 0);
    return {
      generated_at: iso(now),
      workflow_path: this.o.workflowPath,
      tracker_kind: this.cfg?.tracker.kind ?? null,
      config_error: this.configError,
      poll_interval_ms: this.cfg?.pollIntervalMs ?? null,
      max_concurrent_agents: this.cfg?.agent.maxConcurrent ?? null,
      counts: { running: this.running.size, retrying: this.retries.size, parked: this.parked.size },
      running: [...this.running].map(([id, e]) => this.runningRow(id, e)),
      retrying: [...this.retries].map(([id, r]) => this.retryRow(id, r)),
      recent: this.recent.map(({ events, workspace, ...o }) => ({ ...o, at: iso(o.at), tokens: tokens(o.tokens) })),
      agent_totals: { ...tokens(this.totals), seconds_running: Math.round((this.totals.seconds + active) * 10) / 10, cost_usd: this.costComplete ? Math.round(this.totals.costUsd * 10000) / 10000 : null },
      rate_limits: this.rateLimits,
    };
  }

  issueDetail(identifier: string) {
    const run = [...this.running].find(([, e]) => e.identifier === identifier);
    const retry = [...this.retries].find(([, r]) => r.identifier === identifier);
    const last = this.recent.find((o) => o.identifier === identifier);
    if (!run && !retry && !last) return null;
    const [id, e] = run ?? [];
    return {
      issue_identifier: identifier,
      issue_id: id ?? retry?.[0] ?? null,
      status: run ? 'running' : retry ? 'retrying' : 'idle',
      workspace: { path: e?.workspace ?? last?.workspace ?? null },
      attempts: { restart_count: this.recent.filter((o) => o.identifier === identifier).length, current_retry_attempt: e?.attempt ?? retry?.[1].attempt ?? null },
      running: run ? this.runningRow(id!, e!) : null,
      retry: retry ? this.retryRow(...retry) : null,
      recent_events: [...(e?.events ?? []), ...this.recent.filter((o) => o.identifier === identifier).flatMap((o) => o.events)].sort((a, b) => b.at - a.at).slice(0, 100).map((x) => ({ ...x, at: iso(x.at) })),
      last_error: retry?.[1].error ?? last?.error ?? null,
      history: this.recent.filter((o) => o.identifier === identifier).map(({ events, workspace, ...o }) => ({ ...o, at: iso(o.at), tokens: tokens(o.tokens) })),
    };
  }

  /** What the agent side is doing with an issue, for board cards. */
  agentStatus(id: string) {
    const e = this.running.get(id);
    if (e) return { kind: 'running', provider: e.provider, model: e.model, turn: e.turns, max_turns: this.cfg.agent.maxTurns, last_message: e.lastMessage, stopping: e.stop?.reason ?? null };
    const r = this.retries.get(id);
    if (r) return { kind: r.error ? 'retrying' : 'checking', attempt: r.attempt, due_at: iso(r.dueAt), error: r.error };
    if (this.parked.has(id)) return { kind: 'parked' };
    return null;
  }

  /** Board view (extension): tickets in the configured columns plus live agent status. */
  async board() {
    const tickets = await this.tracker.fetchIssuesByStates([...this.cfg.boardColumns, ...this.cfg.boardHidden]);
    return {
      title: this.cfg.boardTitle,
      columns: this.cfg.boardColumns,
      hidden_columns: this.cfg.boardHidden,
      active_states: this.cfg.tracker.activeStates,
      terminal_states: this.cfg.tracker.terminalStates,
      required_labels: this.cfg.tracker.requiredLabels,
      can_create: Boolean(this.tracker.create),
      can_set_agent: Boolean(this.tracker.setAgent),
      branches: this.cfg.projectRoot ? await branches(this.cfg.projectRoot) : null,
      default_base_branch: this.cfg.baseBranch,
      default_provider: this.cfg.agent.provider,
      default_models: { claude: this.cfg.claude.model, codex: this.cfg.codex.model },
      tickets: tickets.map((i) => {
        const provider = i.agent_provider ?? this.cfg.agent.provider;
        return { ...i, base_locked: this.cfg.projectRoot ? worktreeStarted(this.cfg, i.identifier) || this.running.has(i.id) : false, effective_provider: provider, effective_model: i.agent_model ?? this.cfg[provider].model, agent: this.agentStatus(i.id) };
      }),
    };
  }

  /** POST /api/v1/refresh: poll + reconcile now; coalesced into an in-flight tick. */
  requestRefresh() {
    const coalesced = this.ticking;
    if (!coalesced) this.scheduleTick(0);
    return { queued: true, coalesced, requested_at: iso(Date.now()), operations: ['poll', 'reconcile'] };
  }
}
