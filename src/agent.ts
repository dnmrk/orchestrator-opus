import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killTree, shq } from './core.ts';
import type { Config } from './workflow.ts';

export type AgentEvent = {
  type: string;
  at: number;
  message?: string;
  usage?: { input: number; output: number };
  costUsd?: number;
  rateLimits?: unknown;
};

export type TurnOptions = {
  cfg: Config['claude'];
  cwd: string;
  sessionId: string;
  resume: boolean;
  prompt: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
};

export function claudeCommand(cfg: Config['claude'], sessionId: string, resume: boolean): string {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', cfg.permissionMode];
  args.push(resume ? '--resume' : '--session-id', sessionId);
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.allowedTools.length) args.push('--allowedTools', ...cfg.allowedTools); // variadic, keep last
  return `${cfg.command} ${args.map(shq).join(' ')}`;
}

/** Condenses one stream-json line into what the orchestrator tracks. */
export function summarize(ev: any, at = Date.now()): AgentEvent {
  const type = ev.subtype ? `${ev.type}/${ev.subtype}` : String(ev.type);
  if (ev.type === 'result') {
    return {
      type,
      at,
      message: String(ev.result ?? '').slice(0, 500),
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
    .map((p: any) => (p.type === 'text' ? p.text : p.type === 'tool_use' ? `[${p.name}]` : ''))
    .filter(Boolean)
    .join(' ')
    .slice(0, 500);
  return { type, at, message: message || undefined };
}

/** One Claude Code invocation = one SPEC "turn". Resolves on a successful `result`, rejects otherwise. */
export function runTurn(o: TurnOptions): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (o.signal.aborted) return reject(new Error(String(o.signal.reason ?? 'aborted')));
    const child = spawn('bash', ['-lc', claudeCommand(o.cfg, o.sessionId, o.resume)], {
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
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return o.onEvent({ type: 'malformed', at: Date.now(), message: line.slice(0, 200) });
      }
      if (ev.type === 'result') result = ev;
      o.onEvent(summarize(ev));
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
      else if (result.is_error || result.subtype !== 'success') {
        reject(new Error(`turn failed (${result.subtype}): ${String(result.result ?? '').slice(0, 300)}`));
      } else resolvePromise();
    });
  });
}
