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
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document, localStorage: { getItem: (k: string) => stored.get(k), setItem: (k: string, v: string) => stored.set(k, v) },
    fetch: () => new Promise(() => {}), setInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  return { element, document, stored };
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
