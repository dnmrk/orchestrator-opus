import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Document, parseDocument } from 'yaml';
import { errMsg, lockFile, log, norm, parseAgentSelection, TrackerError, type AgentSelection, type BlockerRef, type Issue, type NewTicket, type Tracker, type TrackerTools } from './core.ts';
import { expandPath } from './workflow.ts';

// Optional `---` YAML header, then the markdown body.
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
// Ticket ids become filenames, so they must not be able to walk out of the tickets dir.
const SAFE_ID = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

type Ticket = { path: string; doc: Document; meta: Record<string, any>; body: string; created: Date; updated: Date };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const list = (v: unknown) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * `tracker.kind: local` — one markdown file per ticket in `tracker.provider.dir`.
 * The filename (minus .md) is the identifier; state/title/labels/etc. live in the YAML header.
 */
export class LocalTracker implements Tracker, TrackerTools {
  dir: string;
  terminal: Set<string>;
  prefix: string;

  constructor(dir: string, terminalStates: string[], prefix = 'DEV') {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(prefix)) throw new TrackerError('invalid_tracker_config', 'tracker.provider.prefix must be letters/digits, e.g. DEV');
    this.dir = dir;
    this.terminal = new Set(terminalStates.map(norm));
    this.prefix = prefix;
  }

  static fromProvider(raw: Record<string, unknown>, baseDir: string, terminalStates: string[]) {
    return new LocalTracker(expandPath(raw.dir ?? 'tickets', baseDir), terminalStates, raw.prefix === undefined ? 'DEV' : String(raw.prefix));
  }

  async read(identifier: string): Promise<Ticket | null> {
    if (!SAFE_ID.test(identifier)) return null;
    const path = join(this.dir, `${identifier}.md`);
    let text: string;
    let info;
    try {
      [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw new TrackerError('tracker_request', `${path}: ${errMsg(e)}`);
    }
    const m = FRONT.exec(text);
    const doc = parseDocument(m ? m[1] : '');
    if (doc.errors.length) throw new TrackerError('tracker_response', `${identifier}: ${doc.errors[0].message}`);
    const meta = doc.toJS() ?? {};
    if (typeof meta !== 'object' || Array.isArray(meta)) throw new TrackerError('tracker_response', `${identifier}: header must be a map`);
    return { path, doc, meta, body: m ? m[2] : text, created: info.birthtime, updated: info.mtime };
  }

  async normalize(identifier: string, t: Ticket): Promise<Issue> {
    const selection = parseAgentSelection(t.meta.agent_provider, t.meta.agent_model);
    const body = t.body.trim();
    const title = str(t.meta.title) ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null;
    const state = str(t.meta.state);
    if (!title || !state) throw new TrackerError('tracker_response', `${identifier}: needs "state:" and a title ("title:" or a "# heading")`);
    const blocked_by: BlockerRef[] = await Promise.all(
      list(t.meta.blocked_by).map(async (b) => {
        const blocker = await this.read(b).catch(() => null);
        return { id: b, identifier: b, state: str(blocker?.meta.state) };
      }),
    );
    return {
      id: identifier,
      agent_provider: selection.provider,
      agent_model: selection.model,
      native_ref: { path: t.path },
      identifier,
      title,
      description: body || null,
      priority: Number.isInteger(t.meta.priority) ? t.meta.priority : null,
      state,
      branch_name: str(t.meta.branch),
      base_branch: str(t.meta.base_branch),
      url: pathToFileURL(t.path).href,
      assignee_id: str(t.meta.assignee),
      labels: [...new Set(list(t.meta.labels).map(norm).filter(Boolean))],
      blocked_by,
      // Missing blocker files have state null and keep the ticket waiting.
      dispatchable: blocked_by.every((b) => b.state !== null && this.terminal.has(norm(b.state))),
      created_at: iso(t.meta.created) ?? t.created.toISOString(),
      updated_at: t.updated.toISOString(),
    };
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (!states.length) return [];
    const want = new Set(states.map(norm));
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (e) {
      throw new TrackerError('tracker_request', `cannot read tickets dir ${this.dir}: ${errMsg(e)}`);
    }
    const out: Issue[] = [];
    for (const file of files.filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').sort()) {
      const id = file.slice(0, -3);
      try {
        const t = await this.read(id);
        if (!t || !want.has(norm(str(t.meta.state) ?? ''))) continue;
        out.push(await this.normalize(id, t));
      } catch (e) {
        log('warn', 'skipping malformed ticket', { file, error: errMsg(e) });
      }
    }
    return out;
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const id of new Set(ids)) {
      const t = await this.read(id);
      if (t) out.push(await this.normalize(id, t)); // malformed throws: omission would mean "gone"
    }
    return out;
  }

  async mustRead(identifier: string): Promise<Ticket> {
    const t = await this.read(identifier);
    if (!t) throw new Error(`no ticket ${identifier} in ${this.dir}`);
    return t;
  }

  /** Write via rename so a concurrent poll never sees a half-written file. */
  async save(path: string, text: string) {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, path);
  }

  /** Next free `<prefix>-<n>`; `wx` makes a concurrent create fail instead of overwriting. */
  async create(t: NewTicket): Promise<string> {
    const selection = parseAgentSelection(t.agent_provider, t.agent_model);
    await mkdir(this.dir, { recursive: true });
    const pattern = new RegExp(`^${this.prefix}-(\\d+)\\.md$`);
    const max = Math.max(0, ...(await readdir(this.dir)).map((f) => Number(pattern.exec(f)?.[1] ?? 0)));
    const identifier = `${this.prefix}-${max + 1}`;
    const header = new Document({
      state: t.state,
      title: t.title,
      ...(t.labels.length ? { labels: t.labels } : {}),
      ...(t.priority ? { priority: t.priority } : {}),
      created: new Date().toISOString(),
      ...(t.base_branch ? { base_branch: t.base_branch } : {}),
      ...(selection.provider ? { agent_provider: selection.provider } : {}),
      ...(selection.model ? { agent_model: selection.model } : {}),
    });
    await writeFile(join(this.dir, `${identifier}.md`), `---\n${String(header)}---\n${t.description.trim()}\n`, { flag: 'wx' });
    return identifier;
  }

  /**
   * Header + body back to file text. `save` replaces the file, which resets its birth time, so the
   * first rewrite records the original birth time as `created` before it is lost.
   */
  serialize(t: Ticket, body = t.body): string {
    if (t.meta.created == null) t.doc.set('created', t.created.toISOString());
    return `---\n${String(t.doc)}---\n${body}`;
  }

  /** Read-modify-write under a per-ticket lock, so the board and the agent's tracker tool can't drop each other's edits. */
  async update(identifier: string, change: (t: Ticket) => string): Promise<void> {
    if (!SAFE_ID.test(identifier)) throw new Error(`no ticket ${identifier} in ${this.dir}`);
    const release = await lockFile(join(this.dir, `${identifier}.md.lock`), 5000);
    try {
      const t = await this.mustRead(identifier);
      await this.save(t.path, change(t));
    } finally {
      await release();
    }
  }

  async comment(identifier: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('comment text is empty');
    await this.update(identifier, (t) => {
      return this.serialize(t, this.appendComment(t.body, text));
    });
  }

  appendComment(body: string, text: string): string {
    const heading = /^## Comments[ \t]*\r?$/m.test(body) ? '' : '\n\n## Comments';
    return `${body.trimEnd()}${heading}\n\n### ${new Date().toISOString()}\n\n${text.trim()}\n`;
  }

  async transition(identifier: string, state: string): Promise<string> {
    await this.update(identifier, (t) => {
      const previous = str(t.meta.state);
      t.doc.set('state', state); // Document API keeps the user's comments and key order
      return this.serialize(t, previous && norm(previous) !== norm(state)
        ? this.appendComment(t.body, `Status changed from ${previous} to ${state}.`) : t.body);
    });
    return state;
  }

  async setBaseBranch(identifier: string, branch: string): Promise<void> {
    await this.update(identifier, (t) => {
      t.doc.set('base_branch', branch);
      return this.serialize(t);
    });
  }

  async setAgent(identifier: string, selection: AgentSelection): Promise<void> {
    const { provider, model } = parseAgentSelection(selection.provider, selection.model);
    await this.update(identifier, (t) => {
      if (provider) t.doc.set('agent_provider', provider);
      else t.doc.delete('agent_provider');
      if (model) t.doc.set('agent_model', model);
      else t.doc.delete('agent_model');
      return this.serialize(t);
    });
  }
}
