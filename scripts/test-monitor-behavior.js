#!/usr/bin/env node
'use strict';

/**
 * Dependency-free behavior checks for the monitor page's inline JavaScript.
 * The page is executed in a small fake DOM so these checks do not call the
 * public monitor service or require a browser/runtime package.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MONITOR = path.join(ROOT, 'monitor.html');

class FakeElement {
  constructor(tagName, id = '') {
    this.tagName = tagName;
    this.id = id;
    this.textContent = '';
    this.className = '';
    this.disabled = false;
    this.value = '';
    this.children = [];
    this.attributes = {};
    this.listeners = {};
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }

  dispatch(name, event = {}) {
    const handler = this.listeners[name];
    if (handler) return handler({ target: this, ...event });
    return undefined;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

function makeEnvironment() {
  const ids = [
    'themeToggle', 'sourceMessage', 'sourceBadge', 'totalCount', 'fullOkCount',
    'basicOkCount', 'failedCount', 'avgLatency', 'checkedAt', 'nextCheckAt',
    'schemaInfo', 'searchInput', 'statusFilter', 'refreshButton', 'refreshNote',
    'listCount', 'modelList',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement('div', id)]));
  elements.get('themeToggle').tagName = 'button';
  elements.get('searchInput').tagName = 'input';
  elements.get('statusFilter').tagName = 'select';
  elements.get('refreshButton').tagName = 'button';
  elements.get('modelList').tagName = 'div';

  const timers = new Map();
  let nextTimerId = 1;
  const window = {
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
  };

  const document = {
    documentElement: {
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      getAttribute(name) { return this.attributes[name] || null; },
    },
    getElementById(id) { return elements.get(id) || null; },
    createElement(tagName) { return new FakeElement(tagName); },
    createTextNode(text) { return new FakeElement('#text', ''); },
  };

  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };

  const requests = [];
  function fetchStub(url) {
    return new Promise((resolve, reject) => {
      requests.push({ url, resolve, reject });
    });
  }

  class FakeAbortController {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; }
  }

  const context = {
    AbortController: FakeAbortController,
    console,
    document,
    fetch: fetchStub,
    localStorage,
    window,
  };
  vm.createContext(context);
  return { context, elements, requests };
}

function loadMonitor(environment) {
  const html = fs.readFileSync(MONITOR, 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  assert(match, 'monitor.html must contain an inline script');
  vm.runInContext(match[1], environment.context, { filename: MONITOR });
}

function response(status, body, retryAfter = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) { return name === 'Retry-After' ? retryAfter : null; },
    },
    text: async () => body == null ? '' : JSON.stringify(body),
  };
}

async function flush() {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

function assertUnavailable(environment) {
  const { elements } = environment;
  for (const id of ['totalCount', 'fullOkCount', 'basicOkCount', 'failedCount', 'avgLatency', 'checkedAt']) {
    assert.strictEqual(elements.get(id).textContent, '—', `${id} should reset after dual failure`);
  }
  assert.strictEqual(elements.get('nextCheckAt').textContent, '下次检查：—');
  assert.strictEqual(elements.get('schemaInfo').textContent, 'schema —');
  assert.strictEqual(elements.get('sourceBadge').textContent, '不可用');
  assert(elements.get('sourceMessage').textContent.includes('实时接口与历史快照均暂不可用'));
}

async function main() {
  const environment = makeEnvironment();
  loadMonitor(environment);
  const { elements, requests } = environment;

  assert.strictEqual(requests.length, 1, 'setup should start one status request');
  assert(requests[0].url.includes('/monitor-api/v1/public/status'));

  // Both the live endpoint and monitor.json fail: the page must reset, not lie.
  requests[0].resolve(response(503));
  await flush();
  assert.strictEqual(requests.length, 2, 'live failure should try the historical snapshot');
  assert.strictEqual(requests[1].url, './monitor.json');
  requests[1].resolve(response(503));
  await flush();
  assertUnavailable(environment);

  // A second click while a request is in flight must not create a duplicate.
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 3);
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 3, 'request coordinator must skip duplicate refreshes');
  requests[2].resolve(response(200, {
    schema: 'public-v1',
    updated_at: '2026-08-23T00:00:00Z',
    summary: { total: 1, full_ok: 1, basic_ok: 0, failed: 0, unsupported: 0, avg_latency_ms: 25 },
    models: [{ name: 'healthy', status: 'full_ok' }],
  }));
  await flush();

  // Numeric values from a remote payload are clamped before rendering.
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 4);
  requests[3].resolve(response(200, {
    schema: 'bounded',
    summary: {
      total: 999999999,
      full_ok: -4,
      basic_ok: 1.9,
      failed: 999999999,
      unsupported: -1,
      avg_latency_ms: 999999999999,
    },
    models: [{
      name: 'x'.repeat(400),
      status: 'full_ok',
      latency_ms: -10,
      http_status: 700,
      error: 'e'.repeat(400),
    }],
  }));
  await flush();
  assert.strictEqual(elements.get('totalCount').textContent, 1000000);
  assert.strictEqual(elements.get('fullOkCount').textContent, 0);
  assert.strictEqual(elements.get('basicOkCount').textContent, 1);
  assert.strictEqual(elements.get('failedCount').textContent, 1000000);
  assert.strictEqual(elements.get('avgLatency').textContent, '86400s');
  assert(elements.get('modelList').children.length > 0, 'bounded model should still render');
  const modelRowText = elements.get('modelList').children.at(-1).children
    .map((child) => child.textContent).join(' ');
  assert(!modelRowText.includes('undefined'));

  // A 429 starts cooldown; while cooling down, refresh must be skipped.
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 5);
  requests[4].resolve(response(429, null, '60'));
  await flush();
  assert.strictEqual(requests.length, 6, 'rate limit should still try the historical snapshot');
  requests[5].resolve(response(503));
  await flush();
  const requestCountDuringCooldown = requests.length;
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, requestCountDuringCooldown, 'cooldown must skip refresh');
  assert(elements.get('refreshButton').disabled, 'refresh button should be disabled during cooldown');

  console.log('monitor behavior: PASS');
}

main().catch((error) => {
  console.error(`monitor behavior: FAIL: ${error.message}`);
  process.exitCode = 1;
});
