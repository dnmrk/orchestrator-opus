import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the shipped script with a tiny DOM so navigation is checked without a browser dependency.
function dashboard(savedTab = 'board') {
  const elements = new Map<string, any>();
  const stored = new Map([['symphony-tab', JSON.stringify(savedTab)]]);
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, attributes: {}, listeners: {}, classList: { contains: () => false },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, callback: Function) { this.listeners[name] = callback; },
      focus() { document.activeElement = this; },
    });
    return elements.get(id);
  };
  const document = {
    documentElement: { dataset: {} }, activeElement: null as any,
    getElementById: element, querySelector: element, addEventListener() {},
  };
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const context: any = {
    document, localStorage: { getItem: (k: string) => stored.get(k), setItem: (k: string, v: string) => stored.set(k, v) },
    fetch: () => new Promise(() => {}), setInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  return { element, document, stored, splitComments: context.splitComments, context };
}

test('dashboard switches views, updates headings and restores the saved activity tab', () => {
  const { element, stored } = dashboard('activity');
  assert.equal(element('board').hidden, true);
  assert.equal(element('board-tools').hidden, true);
  assert.equal(element('view-title').textContent, 'Activity');
  assert.equal(element('tab-activity').tabIndex, 0);
  assert.equal(element('tab-board').tabIndex, -1);
  element('tab-board').listeners.click();
  assert.equal(element('activity').hidden, true);
  assert.equal(element('board-tools').hidden, false);
  assert.equal(element('view-title').textContent, 'Issues');
  assert.equal(element('tab-board').attributes['aria-selected'], 'true');
  assert.equal(stored.get('symphony-tab'), '"board"');
});

test('dashboard keyboard navigation selects and focuses tabs without intercepting other keys', () => {
  const { element, document } = dashboard();
  let prevented = 0;
  const key = (key: string) => element('.navigation').listeners.keydown({ key, preventDefault() { prevented++; } });
  key('ArrowDown');
  assert.equal(document.activeElement, element('tab-activity'));
  assert.equal(element('activity').hidden, false);
  key('Home');
  assert.equal(document.activeElement, element('tab-board'));
  key('End');
  assert.equal(document.activeElement, element('tab-activity'));
  key('Tab');
  assert.equal(prevented, 3);
});

test('all comment sections survive parsing when older ticket updates repeated the heading', () => {
  const { splitComments } = dashboard();
  const parsed = splitComments('Request\n\n## Comments\n\n### 2026-10-26\n\nOld feedback\n\n## Comments\n\n### 2026-10-27\n\nNew feedback');
  assert.equal(parsed.body, 'Request');
  assert.equal(parsed.comments.length, 2);
  assert.equal(parsed.comments[0].text, 'Old feedback');
  assert.equal(parsed.comments[1].text, 'New feedback');
});


test('ticket comments render newest first and preserve decision answer matching and form indices', () => {
  const { context, document, element } = dashboard();
  (document as any).querySelectorAll = () => [];
  runInNewContext(`
    selected = 'DEV-1';
    detail = { recent_events: [{ at: '2026-10-29T12:00:00Z', message: 'Working on the ticket' }] };
    board = { title: 'Board', columns: ['Todo'], hidden_columns: [], terminal_states: [], active_states: ['Todo'], tickets: [{
      identifier: 'DEV-1', title: 'Ticket', state: 'Todo', labels: [], blocked_by: [],
      description: 'Request\\n\\n## Comments\\n\\n### 2026-10-27\\n\\n## Decisions\\nOlder question?\\n- Small\\n- Large\\n\\n### 2026-10-28\\n\\n## Decision answers\\n\\nDecision request: 2026-10-27\\n\\nAnswer: Small\\n\\n### 2026-10-29\\n\\n## Decisions\\nNewest question?\\n- Today\\n- Tomorrow'
    }] };
    renderPanel();
  `, context);
  const html = element('p-body').innerHTML;
  assert.ok(html.includes('Agent activity'));
  assert.ok(html.indexOf('Description</p>') < html.indexOf('id="p-comment-form"'));
  assert.ok(html.indexOf('id="p-comment-form"') < html.indexOf('Agent activity'));
  assert.ok(html.indexOf('id="p-comment-form"') < html.indexOf('class="comment"'));
  assert.ok(html.indexOf('Newest question?') < html.indexOf('Answer: Small'));
  assert.ok(html.indexOf('Answer: Small') < html.indexOf('Older question?'));
  assert.match(html, /data-comment="2"/);
  assert.doesNotMatch(html, /data-comment="0"/);
  assert.match(html, /Answers submitted in comments/);
  assert.match(html, /<details id="p-agent-activity"><summary class="label">Agent activity<\/summary>/);
  (document as any).querySelector = () => null;
  element('p-agent-activity').open = true;
  runInNewContext('renderPanel(true, true)', context);
  assert.match(element('p-body').innerHTML, /<details id="p-agent-activity" open>/);
  element('p-agent-activity').open = false;
  runInNewContext('renderPanel(true, true)', context);
  assert.match(element('p-body').innerHTML, /<details id="p-agent-activity">/);
  element('p-agent-activity').open = true;
  runInNewContext('renderPanel()', context);
  assert.match(element('p-body').innerHTML, /<details id="p-agent-activity">/);
});

test('decision requests parse multiple questions, stop at the next section, and escape option markup', () => {
  const { context } = dashboard();
  const text = '## Decisions\nWhich approach?\n- Small\n- <script>bad()</script>\nWhen?\n1. Today\n2. Tomorrow\n## Notes\nNot a question';
  assert.deepEqual(JSON.parse(JSON.stringify(context.decisionQuestions(text))), [
    { question: 'Which approach?', options: ['Small', '<script>bad()</script>'] },
    { question: 'When?', options: ['Today', 'Tomorrow'] },
  ]);
  assert.equal(context.decisionQuestions('No decisions').length, 0);
  assert.equal(context.decisionQuestions('## Decisions\r\nFree answer?').length, 1);
  const request = { at: '2026-10-28T10:00:00Z', text };
  const html = context.decisionForm(request, 0, [request]);
  assert.match(html, /Submit answers/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.match(context.decisionForm(request, 0, [request, { text: `## Decision answers\n\nDecision request: ${request.at}\n\nAnswer: Small` }]), /Answers submitted/);
});

function decisionHarness(questionCount = 1) {
  const { context, document } = dashboard();
  const node = (initial = {}) => ({
    value: '', textContent: '', hidden: true, disabled: false, attributes: {} as Record<string, string>,
    focus() { document.activeElement = this; },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    ...initial,
  });
  const fields = Array.from({ length: questionCount }, () => node());
  const feedback = node(), budget = node(), submit = node();
  const option: any = { dataset: { answer: '0', value: 'Small' }, disabled: false, addEventListener(_name: string, callback: Function) { this.click = callback; } };
  const comment = { at: '2026-10-28', text: '## Decisions\n' + Array.from({ length: questionCount }, (_, i) => `Question ${i + 1}?\n- Small\n- Large`).join('\n') };
  let active = true;
  const form: any = {
    ...node(), dataset: { comment: '0', request: JSON.stringify([comment.at, comment.text]) }, listeners: {},
    classList: { remove() { active = false; } },
    addEventListener(name: string, callback: Function) { this.listeners[name] = callback; },
    querySelector: (selector: string) => selector === '.decision-error' ? feedback : selector === '.decision-budget' ? budget : submit,
    querySelectorAll: (selector: string) => selector === 'textarea' ? fields : [option],
  };
  (document as any).querySelectorAll = () => active ? [form] : [];
  context.refresh = async () => {};
  const writes: any[] = [];
  const failure = { message: '' };
  context.api = async (path: string, body: unknown) => {
    writes.push({ path, body });
    assert.equal(form.dataset.saving, 'true');
    assert.equal(fields[0].disabled, true);
    assert.equal(option.disabled, true);
    if (failure.message) throw new Error(failure.message);
  };
  return { context, document, fields, feedback, budget, submit, option, form, comment, writes, failure,
    wire: (drafts?: Map<string, unknown>) => context.wireDecisions([comment], 'DEV-1', drafts),
    send: () => form.listeners.submit({ preventDefault() {} }),
  };
}

test('decision choices can be edited, submitted once as comments, and retried after failure', async () => {
  const h = decisionHarness();
  h.wire();
  h.option.click();
  assert.equal(h.fields[0].value, 'Small');
  assert.equal(h.form.dataset.dirty, 'true');
  h.fields[0].value = 'Small with a custom change';
  h.failure.message = 'offline';
  await h.send();
  assert.equal(h.submit.disabled, false);
  assert.equal(h.fields[0].disabled, false);
  assert.equal(h.form.dataset.dirty, 'true');
  assert.equal(h.fields[0].value, 'Small with a custom change');
  assert.match(h.feedback.textContent, /offline.*answers are kept/);
  assert.equal(h.feedback.hidden, false);
  assert.equal(h.document.activeElement, h.feedback);
  h.failure.message = '';
  await Promise.all([h.send(), h.send()]);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].path, '/api/v1/tickets/DEV-1/comments');
  assert.equal(h.writes[1].body.text, '## Decision answers\n\nDecision request: 2026-10-28\n\nQuestion 1?\nAnswer: Small with a custom change');
  assert.equal(h.form.dataset.dirty, 'false');
  assert.equal(h.form.dataset.saving, 'false');
  assert.match(h.form.innerHTML, /role="status"/);
  assert.equal(h.context.captureDecisionDrafts().size, 0, 'successful form is not recaptured as an unanswered draft');
});

test('empty and whitespace-only answers show inline errors, focus the missing field and never post', async () => {
  const h = decisionHarness(2);
  h.wire();
  h.fields[0].value = 'Valid';
  h.fields[1].value = '   ';
  await h.send();
  assert.equal(h.writes.length, 0);
  assert.equal(h.feedback.hidden, false);
  assert.match(h.feedback.textContent, /required question/);
  assert.equal(h.fields[1].attributes['aria-invalid'], 'true');
  assert.equal(h.document.activeElement, h.fields[1]);
  h.fields[1].value = 'Fixed';
  h.form.listeners.input();
  assert.equal(h.feedback.hidden, true);
  assert.equal(h.fields[1].attributes['aria-invalid'], undefined);
});

test('combined reply limit includes every question and metadata, rejects overflow, and accepts exactly 20000 characters', async () => {
  const h = decisionHarness(6);
  h.wire();
  h.fields.forEach((field) => { field.value = 'x'.repeat(4000); });
  h.form.listeners.input();
  await h.send();
  assert.equal(h.writes.length, 0);
  assert.match(h.budget.textContent, /over the reply limit/);
  assert.match(h.feedback.textContent, /over the limit/);
  assert.equal(h.document.activeElement, h.feedback);
  let remaining = 20_000 - h.context.decisionAnswerText(h.comment, Array(6).fill('x')).length;
  h.fields.forEach((field) => { const extra = Math.min(3999, remaining); field.value = 'x'.repeat(1 + extra); remaining -= extra; });
  h.form.listeners.input();
  assert.match(h.budget.textContent, /^0 characters remaining/);
  await h.send();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].body.text.length, 20_000);
});

test('decision drafts and errors restore by request identity across forced panel renders', async () => {
  const original = decisionHarness(2);
  original.wire();
  original.fields[0].value = 'Keep this draft 🚀';
  original.fields[1].value = 'Second answer';
  original.form.listeners.input();
  original.failure.message = 'offline';
  await original.send();
  const drafts = original.context.captureDecisionDrafts();
  const rebuilt = decisionHarness(2);
  rebuilt.wire(drafts);
  assert.deepEqual(rebuilt.fields.map((field) => field.value), ['Keep this draft 🚀', 'Second answer']);
  assert.equal(rebuilt.form.dataset.dirty, 'true');
  assert.equal(rebuilt.feedback.textContent, original.feedback.textContent);
  assert.equal(rebuilt.feedback.hidden, false);
  const other = decisionHarness(2);
  other.form.dataset.request = 'different ticket request';
  other.wire(drafts);
  assert.deepEqual(other.fields.map((field) => field.value), ['', '']);
});

test('DEV-8 handoff decision topics become separate answer fields without invented choices', () => {
  const { context, splitComments } = dashboard();
  const handoff = '## Handoff\n**Done:** Reviewed the UI.\n\n**Decisions needed (see the report):**\n- Tab and screen naming.\n- Whether to change the DESIGN.md Today order.\n- Follow-up scope: P1 fixes only (clarify, harden, adapt), or also a native-stack migration (shape).';
  const description = `Requirements\n\n## Comments\n\n### 2026-10-28T16:38:51.445Z\n\n${handoff}\n\n### 2026-10-28T16:38:52.122Z\n\nStatus changed.`;
  const comments = splitComments(description).comments;
  assert.equal(comments.length, 2);
  const questions = JSON.parse(JSON.stringify(context.decisionQuestions(comments[0].text)));
  assert.deepEqual(questions, [
    { question: 'Tab and screen naming.', options: [] },
    { question: 'Whether to change the DESIGN.md Today order.', options: [] },
    { question: 'Follow-up scope: P1 fixes only (clarify, harden, adapt), or also a native-stack migration (shape).', options: [] },
  ]);
  const html = context.decisionForm(comments[0], 0, comments);
  assert.equal((html.match(/<textarea /g) ?? []).length, 3);
  assert.match(html, /Submit answers/);
  assert.ok(!html.includes('decision-option'));
  assert.match(html, /placeholder="Type your answer…"/);
});

test('decision heading variants support bullet questions with nested choices and stop before the next section', () => {
  const { context } = dashboard();
  for (const heading of ['## Decisions', '### Decisions needed', '**Decisions needed:**', '**Decisions needed**:', 'Decisions needed (see the report):']) {
    const text = `${heading}\n- Which scope?\n  - P1 fixes only\n  - Include migration\n- Naming preference?\n  A. Keep names\n  B. Rename tabs\n\n**Next steps:**\n- This is not a decision`;
    assert.deepEqual(JSON.parse(JSON.stringify(context.decisionQuestions(text.replaceAll('\n', '\r\n')))), [
      { question: 'Which scope?', options: ['P1 fixes only', 'Include migration'] },
      { question: 'Naming preference?', options: ['Keep names', 'Rename tabs'] },
    ], heading);
  }
  assert.equal(context.decisionQuestions('**Decision answers:**\n- Not a request').length, 0);
  assert.equal(context.decisionQuestions('We have decisions needed later.\n- Not a request').length, 0);
});

test('markdown subheadings stay inside timestamped comments, including a Decisions heading', () => {
  const { splitComments, context } = dashboard();
  const parsed = splitComments('Requirements\n\n## Comments\n\n### 2026-10-29T00:00:00Z\n\n### Decisions needed\n- Choose scope\n  - Minimal\n  - Broad\n\n### Notes\nKeep this with the same comment.');
  assert.equal(parsed.comments.length, 1);
  assert.match(parsed.comments[0].text, /### Notes/);
  assert.equal(context.decisionQuestions(parsed.comments[0].text)[0].options.length, 2);
});
