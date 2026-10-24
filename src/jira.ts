import { envRef, log, norm, TrackerError, type BlockerRef, type Issue, type Tracker, type TrackerTools } from './core.ts';

const FIELDS = ['summary', 'description', 'status', 'priority', 'labels', 'assignee', 'issuelinks', 'created', 'updated', 'project'];
const PRIORITY: Record<string, number> = { highest: 1, high: 2, medium: 3, low: 4 };
const PAGE = 100;
const MAX_PAGES = 100;

export type JiraProvider = { baseUrl: string; email: string; apiToken: string; project: string; jql: string | null };

/** Validates `tracker.provider` for kind `jira`. See README "Jira adapter profile". */
export function jiraProvider(raw: Record<string, unknown>): JiraProvider {
  const get = (key: string, fallbackEnv?: string) => {
    const v = raw[key] === undefined && fallbackEnv ? (process.env[fallbackEnv] ?? '') : envRef(raw[key]);
    return v === undefined || v === null ? '' : String(v).trim();
  };
  const p = {
    baseUrl: get('base_url', 'JIRA_BASE_URL').replace(/\/+$/, ''),
    email: get('email', 'JIRA_EMAIL'),
    apiToken: get('api_token', 'JIRA_API_TOKEN'),
    project: get('project'),
    jql: get('jql') || null,
  };
  if (!/^https?:\/\//.test(p.baseUrl)) throw new TrackerError('invalid_tracker_config', 'tracker.provider.base_url must be an http(s) URL');
  if (!p.project) throw new TrackerError('invalid_tracker_config', 'tracker.provider.project is required');
  if (!p.email || !p.apiToken) {
    throw new TrackerError('missing_tracker_secret', 'tracker.provider.email/api_token (or JIRA_EMAIL/JIRA_API_TOKEN) are required');
  }
  return p;
}

const jqlQuote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : v == null ? null : String(v));
const isoOrNull = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Atlassian Document Format → plain text, good enough for an agent prompt. */
export function adfToText(doc: unknown): string | null {
  if (doc == null) return null;
  if (typeof doc === 'string') return doc.trim() || null;
  const walk = (n: any): string => {
    if (!n || typeof n !== 'object') return '';
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention' || n.type === 'emoji') return n.attrs?.text ?? '';
    if (n.type === 'inlineCard') return n.attrs?.url ?? '';
    const inner = (Array.isArray(n.content) ? n.content : []).map(walk).join('');
    switch (n.type) {
      case 'paragraph':
      case 'heading':
      case 'blockquote':
        return inner + '\n\n';
      case 'listItem':
        return '- ' + inner.trim() + '\n';
      case 'bulletList':
      case 'orderedList':
        return inner + '\n';
      case 'codeBlock':
        return '```\n' + inner + '\n```\n\n';
      default:
        return inner;
    }
  };
  return walk(doc).replace(/\n{3,}/g, '\n\n').trim() || null;
}

/** Plain text → ADF paragraphs (single newlines become hard breaks). */
function textToAdf(text: string) {
  const paragraphs = text.trim().split(/\n{2,}/).map((p) => ({
    type: 'paragraph',
    content: p.split('\n').flatMap((line, i) => [
      ...(i ? [{ type: 'hardBreak' }] : []),
      ...(line ? [{ type: 'text', text: line }] : []),
    ]),
  }));
  return { type: 'doc', version: 1, content: paragraphs };
}

/**
 * Provider-specific eligibility the generic scheduler can't infer (SPEC 4.1.1 `dispatchable`).
 * Blocked issues wait until every "is blocked by" link points at a terminal-state issue.
 */
export function isDispatchable(fields: any, blockers: BlockerRef[], terminal: Set<string>): boolean {
  const unblocked = blockers.every((b) => b.state !== null && terminal.has(norm(b.state)));
  // TODO(Chief): assignee policy — see the note in the session; currently any assignee is picked up.
  return unblocked;
}

export class JiraTracker implements Tracker, TrackerTools {
  p: JiraProvider;
  terminal: Set<string>;

  constructor(p: JiraProvider, terminalStates: string[]) {
    this.p = p;
    this.terminal = new Set(terminalStates.map(norm));
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.p.baseUrl + path, {
        method,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${this.p.email}:${this.p.apiToken}`).toString('base64'),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new TrackerError('tracker_request', `${method} ${path}: ${(e as Error).message}`);
    }
    if (res.status === 429) throw new TrackerError('tracker_rate_limited', `${method} ${path}: retry-after ${res.headers.get('retry-after')}`);
    if (!res.ok) throw new TrackerError('tracker_status', `${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new TrackerError('tracker_response', `${method} ${path}: invalid JSON`);
    }
  }

  normalize(raw: any): Issue | null {
    const f = raw?.fields ?? {};
    const id = raw?.id != null ? String(raw.id) : '';
    const key = typeof raw?.key === 'string' ? raw.key : '';
    const title = typeof f.summary === 'string' ? f.summary : '';
    const state = typeof f.status?.name === 'string' ? f.status.name : '';
    if (!id || !key || !title.trim() || !state.trim()) return null;

    // On issue A, a link whose `inwardIssue` is B reads "A is blocked by B".
    const blocked_by: BlockerRef[] = (Array.isArray(f.issuelinks) ? f.issuelinks : [])
      .filter((l: any) => l?.inwardIssue && /blocked by/i.test(l?.type?.inward ?? ''))
      .map((l: any) => ({
        id: strOrNull(l.inwardIssue.id),
        identifier: strOrNull(l.inwardIssue.key),
        state: strOrNull(l.inwardIssue.fields?.status?.name),
      }));

    return {
      id,
      native_ref: { key, project: strOrNull(f.project?.key) },
      identifier: key,
      title,
      description: adfToText(f.description),
      priority: PRIORITY[norm(String(f.priority?.name ?? ''))] ?? null,
      state,
      branch_name: null,
      url: `${this.p.baseUrl}/browse/${key}`,
      assignee_id: strOrNull(f.assignee?.accountId),
      labels: [...new Set<string>((Array.isArray(f.labels) ? f.labels : []).map((l: unknown) => norm(String(l))).filter(Boolean))],
      blocked_by,
      dispatchable: isDispatchable(f, blocked_by, this.terminal),
      created_at: isoOrNull(f.created),
      updated_at: isoOrNull(f.updated),
    };
  }

  /** `strict`: a malformed record fails the call instead of being skipped (required for ID refresh). */
  async search(jql: string, strict: boolean): Promise<Issue[]> {
    const out: Issue[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.request('POST', '/rest/api/3/search/jql', { jql, fields: FIELDS, maxResults: PAGE, nextPageToken });
      if (!r || !Array.isArray(r.issues)) throw new TrackerError('tracker_response', 'search response has no issues array');
      for (const raw of r.issues) {
        const issue = this.normalize(raw);
        if (issue) out.push(issue);
        else if (strict) throw new TrackerError('tracker_response', `malformed issue ${raw?.key ?? raw?.id}`);
        else log('warn', 'skipping malformed jira issue', { key: raw?.key ?? raw?.id });
      }
      if (r.isLast === true || !r.nextPageToken) return out;
      nextPageToken = r.nextPageToken;
    }
    throw new TrackerError('tracker_pagination', `more than ${MAX_PAGES} pages for: ${jql}`);
  }

  scope(): string {
    const project = `project = ${jqlQuote(this.p.project)}`;
    return this.p.jql ? `${project} AND (${this.p.jql})` : project;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (!states.length) return [];
    return this.search(`${this.scope()} AND status in (${states.map(jqlQuote).join(', ')}) ORDER BY created ASC`, false);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const unique = [...new Set(ids)].filter((id) => /^\d+$/.test(id));
    const byId = new Map<string, Issue>();
    for (let i = 0; i < unique.length; i += PAGE) {
      const chunk = unique.slice(i, i + PAGE);
      let found: Issue[];
      try {
        found = await this.search(`${this.scope()} AND id in (${chunk.join(', ')})`, true);
      } catch (e) {
        // Jira rejects the whole JQL if any id no longer exists; fall back to one query per id.
        if (!(e instanceof TrackerError && e.category === 'tracker_status' && / 400 /.test(e.message))) throw e;
        found = [];
        for (const id of chunk) {
          try {
            found.push(...(await this.search(`${this.scope()} AND id = ${id}`, true)));
          } catch (inner) {
            if (!(inner instanceof TrackerError && / 400 /.test(inner.message))) throw inner;
          }
        }
      }
      for (const issue of found) byId.set(issue.id, issue);
    }
    return [...byId.values()];
  }

  // Agent tools (SPEC 11.5): writes run here with the configured credential.

  async comment(key: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('comment text is empty');
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) });
  }

  async transition(key: string, target: string): Promise<string> {
    const r = await this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const transitions: any[] = r?.transitions ?? [];
    const t = transitions.find((t) => norm(String(t.to?.name ?? '')) === norm(target)) ?? transitions.find((t) => norm(String(t.name ?? '')) === norm(target));
    if (!t) {
      const options = transitions.map((t) => `${t.name} → ${t.to?.name}`).join('; ');
      throw new Error(`no transition to "${target}" from current state. Available: ${options || 'none'}`);
    }
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return String(t.to?.name ?? target);
  }
}
