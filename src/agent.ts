import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree, orphanGuard, shq } from './core.ts';
import type { Config } from './workflow.ts';

export type AgentEvent = {
  type: string;
  at: number;
  message?: string;
  usage?: { input: number; output: number };
  costUsd?: number;
  rateLimits?: unknown;
  sessionId?: string;
};

export type TurnOptions = {
  cwd: string;
  writableRoots?: string[];
  sessionId: string;
  resume: boolean;
  prompt: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
} & ({ provider?: 'claude'; cfg: Config['claude'] } | { provider: 'codex'; cfg: Config['codex'] });

export function claudeCommand(cfg: Config['claude'], sessionId: string, resume: boolean): string {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', cfg.permissionMode];
  args.push(resume ? '--resume' : '--session-id', sessionId);
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.allowedTools.length) args.push('--allowedTools', ...cfg.allowedTools); // variadic, keep last
  return `${cfg.command} ${args.map(shq).join(' ')}`;
}

export function codexCommand(cfg: Config['codex'], sessionId: string, resume: boolean, writableRoots: string[] = []): string {
  if (resume && !sessionId) throw new Error('cannot resume Codex without a thread ID');
  const args = ['-c', 'approval_policy="never"', '-c', `sandbox_mode="${cfg.sandbox}"`, 'exec'];
  if (writableRoots.length && cfg.sandbox === 'workspace-write') args.splice(0, 0, '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`);
  if (resume) args.push('resume');
  args.push('--json', '--model', cfg.model);
  if (resume) args.push(sessionId);
  args.push('-');
  return `${cfg.command} ${args.map(shq).join(' ')}`;
}

export function summarizeCodex(ev: any, at = Date.now()): AgentEvent {
  const event: AgentEvent = { type: ev.type, at };
  if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') event.sessionId = ev.thread_id;
  if (ev.type === 'turn.completed') {
    // Codex input_tokens already includes cached_input_tokens.
    event.usage = { input: ev.usage?.input_tokens ?? 0, output: ev.usage?.output_tokens ?? 0 };
  }
  const message = ev.item?.text ?? ev.item?.command ?? ev.error?.message ?? ev.message;
  if (typeof message === 'string') event.message = message;
  if (ev.item?.type === 'file_change' && Array.isArray(ev.item.changes)) {
    event.message = 'Updating files: ' + ev.item.changes.map((c: any) => c?.path).filter(Boolean).join(', ').slice(0, 500);
  }
  return event;
}

function toolSummary(part: any): string {
  const input = part.input ?? {};
  const target = input.file_path ?? input.path;
  switch (String(part.name).toLowerCase()) {
    case 'edit': case 'multiedit': return target ? `Editing ${target}` : 'Editing a file';
    case 'write': return target ? `Writing ${target}` : 'Writing a file';
    case 'read': return target ? `Reading ${target}` : 'Reading a file';
    case 'bash': {
      const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : 'Running a shell command';
      return typeof input.command === 'string' && input.command.trim() ? `${description}:\n${input.command.trim()}` : description;
    }
    case 'grep': return typeof input.pattern === 'string' ? `Searching for ${input.pattern}` : 'Searching file contents';
    case 'glob': return typeof input.pattern === 'string' ? `Finding files matching ${input.pattern}` : 'Finding files';
    default: return `Using ${part.name ?? 'a tool'}`;
  }
}

/** Condenses one stream-json line into what the orchestrator tracks. */
export function summarize(ev: any, at = Date.now()): AgentEvent {
  const type = ev.subtype ? `${ev.type}/${ev.subtype}` : String(ev.type);
  if (ev.type === 'result') {
    return {
      type,
      at,
      message: String(ev.result ?? ''),
      usage: {
        input: (ev.usage?.input_tokens ?? 0) + (ev.usage?.cache_read_input_tokens ?? 0) + (ev.usage?.cache_creation_input_tokens ?? 0),
        output: ev.usage?.output_tokens ?? 0,
      },
      costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
    };
  }
  if (ev.type === 'rate_limit_event') return { type, at, rateLimits: ev.rate_limit_info ?? ev };
  const parts = Array.isArray(ev.message?.content) ? ev.message.content : [];
  const message = parts
    .map((p: any) => (p.type === 'text' ? p.text : p.type === 'tool_use' ? toolSummary(p).slice(0, 500) : ''))
    .filter(Boolean)
    .join(' ');
  return { type, at, message: message || undefined };
}

/** One CLI invocation = one turn. Require a terminal success event and a clean process exit. */
export function runTurn(o: TurnOptions): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (o.signal.aborted) return reject(new Error(String(o.signal.reason ?? 'aborted')));
    const codex = o.provider === 'codex';
    const command = o.provider === 'codex' ? codexCommand(o.cfg, o.sessionId, o.resume, o.writableRoots) : claudeCommand(o.cfg, o.sessionId, o.resume);
    const child = spawn('bash', ['-lc', orphanGuard() + command], {
      cwd: o.cwd,
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdin.on('error', () => {}); // child may exit before reading the prompt
    child.stdin.end(o.prompt);

    let result: any = null;
    let stderr = '';
    let timedOut = false;
    let sessionId = o.resume ? o.sessionId : '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
        if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') throw new Error('invalid event');
      } catch {
        return o.onEvent({ type: 'malformed', at: Date.now(), message: line.slice(0, 200) });
      }
      if (codex ? ev.type === 'turn.completed' || ev.type === 'turn.failed' : ev.type === 'result') result = ev;
      const event = codex ? summarizeCodex(ev) : summarize(ev);
      if (event.sessionId) sessionId = event.sessionId;
      o.onEvent(event);
    });

    const onAbort = () => killTree(child);
    o.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, o.cfg.turnTimeoutMs);

    child.on('error', (e) => reject(new Error(`failed to launch agent: ${e.message}`)));
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      if (timedOut) reject(new Error(`turn_timeout after ${o.cfg.turnTimeoutMs}ms`));
      else if (o.signal.aborted) reject(new Error(String(o.signal.reason ?? 'aborted')));
      else if (!result) reject(new Error(`agent exited ${code ?? sig} without a result: ${stderr.trim().slice(-500)}`));
      else if (codex && result.type === 'turn.failed') reject(new Error(`turn failed: ${String(result.error?.message ?? 'Codex turn failed').slice(0, 300)}`));
      else if (!codex && (result.is_error || result.subtype !== 'success')) {
        reject(new Error(`turn failed (${result.subtype}): ${String(result.result ?? '').slice(0, 300)}`));
      } else if (code !== 0) reject(new Error(`agent exited ${code ?? sig}: ${stderr.trim().slice(-500)}`));
      else if (codex && !sessionId) reject(new Error('Codex completed without a thread ID'));
      else resolvePromise();
    });
  });
}
