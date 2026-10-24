import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errMsg, log, norm } from './core.ts';
import type { Orchestrator } from './orchestrator.ts';

// Read per request so UI edits don't need a restart (a ~40 KB local file).
const dashboard = () => readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
// Loopback only, and reject foreign Host headers so a web page can't read state via DNS rebinding.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const MAX_BODY = 100_000;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Writes create work an unattended agent will execute, so a cross-site page must not be able to
 * trigger them: require a JSON content type (forces a CORS preflight we never answer) and, when the
 * browser sends one, an Origin matching this server.
 */
function assertSameOriginJson(req: IncomingMessage) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'json_required', 'send Content-Type: application/json');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'cross_origin', 'writes are only accepted from the dashboard itself');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new HttpError(413, 'body_too_large', `max ${MAX_BODY} bytes`);
  }
  if (!body.trim()) return {};
  try {
    const v = JSON.parse(body);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, 'invalid_json', 'body must be a JSON object');
}

const text = (v: unknown, name: string, max: number, required: boolean) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : null;
  if (s === null || s.length > max || (required && !s)) throw new HttpError(400, 'invalid_field', `${name} must be ${required ? 'a non-empty' : 'a'} string of at most ${max} characters`);
  return s;
};

/** Map a requested state onto the configured spelling; only board columns are valid targets. */
function columnState(orch: Orchestrator, v: unknown): string {
  const want = text(v, 'state', 100, true);
  const all = [...orch.cfg.boardColumns, ...orch.cfg.boardHidden];
  const match = all.find((c) => norm(c) === norm(want));
  if (!match) throw new HttpError(400, 'invalid_state', `state must be one of: ${all.join(', ')}`);
  return match;
}

/** SPEC 13.7 HTTP extension (dashboard at `/`, JSON under `/api/v1/*`) plus the board's ticket endpoints. */
export function startServer(orch: Orchestrator, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    };
    const allow = (method: string) => {
      if (req.method !== method) throw new HttpError(405, 'method_not_allowed', `use ${method}`);
      if (method === 'POST') assertSameOriginJson(req);
    };

    try {
      if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'forbidden_host', 'dashboard is local-only');
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const tracker = orch.tracker;

      if (path === '/') return allow('GET'), send(200, dashboard(), 'text/html; charset=utf-8');
      if (path === '/api/v1/state') return allow('GET'), send(200, orch.snapshot());
      if (path === '/api/v1/refresh') return allow('POST'), send(202, orch.requestRefresh());
      if (path === '/api/v1/board') {
        allow('GET');
        try {
          return send(200, await orch.board());
        } catch (e) {
          throw new HttpError(502, 'tracker_error', errMsg(e));
        }
      }

      if (path === '/api/v1/tickets') {
        allow('POST');
        if (!tracker.create) throw new HttpError(501, 'not_supported', `the ${orch.cfg.tracker.kind} tracker does not support creating tickets here`);
        const b = await readJson(req);
        const priority = b.priority == null || b.priority === '' ? null : Number(b.priority);
        if (priority !== null && !(Number.isInteger(priority) && priority >= 1 && priority <= 4)) throw new HttpError(400, 'invalid_field', 'priority must be 1-4');
        const identifier = await tracker.create({
          title: text(b.title, 'title', 200, true),
          description: text(b.description, 'description', 20_000, false),
          state: b.state === undefined ? orch.cfg.boardColumns[0] : columnState(orch, b.state),
          labels: b.agent ? orch.cfg.tracker.requiredLabels.map(norm).filter(Boolean) : [],
          priority,
        });
        log('info', 'ticket created from board', { issue: identifier });
        orch.requestRefresh();
        return send(201, { identifier });
      }

      const m = /^\/api\/v1\/tickets\/([^/]+)\/(state|comments)$/.exec(path);
      if (m) {
        allow('POST');
        const identifier = decodeURIComponent(m[1]);
        const b = await readJson(req);
        if (!tracker.transition || !tracker.comment) throw new HttpError(501, 'not_supported', 'tracker has no write tools');
        try {
          if (m[2] === 'state') await tracker.transition(identifier, columnState(orch, b.state));
          else await tracker.comment(identifier, text(b.text, 'text', 20_000, true));
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, 'tracker_rejected', errMsg(e));
        }
        log('info', m[2] === 'state' ? 'ticket moved from board' : 'comment added from board', { issue: identifier, state: b.state });
        orch.requestRefresh(); // reconcile promptly, e.g. stop an agent whose ticket was dragged out of an active column
        return send(200, { ok: true });
      }

      const issue = /^\/api\/v1\/([^/]+)$/.exec(path);
      if (issue) {
        allow('GET');
        const identifier = decodeURIComponent(issue[1]);
        const detail = orch.issueDetail(identifier);
        if (!detail) throw new HttpError(404, 'issue_not_found', `${identifier} is not running, retrying, or recently finished`);
        return send(200, detail);
      }
      throw new HttpError(404, 'not_found', path);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal_error', errMsg(e));
      if (err.status >= 500) log('error', 'dashboard request failed', { url: req.url, error: err.message });
      if (!res.headersSent) send(err.status, { error: { code: err.code, message: err.message } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log('info', 'dashboard listening', { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
      resolve(server);
    });
  });
}
