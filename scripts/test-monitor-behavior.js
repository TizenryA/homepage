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
    'listCount', 'modelList', 'quotaCount', 'quotaMessage', 'quotaList',
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
    createTextNode(text) { const node = new FakeElement('#text', ''); node.textContent = String(text); return node; },
  };

  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };

  const requests = [];
  function fetchStub(url, options) {
    return new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
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

function treeText(element) {
  return [element.textContent || '', ...(element.children || []).map(treeText)].join(' ');
}

async function main() {
  const environment = makeEnvironment();
  loadMonitor(environment);
  const { elements, requests } = environment;

  assert.strictEqual(requests.length, 2, 'setup should start status and quota requests');
  assert(requests[0].url.includes('/monitor-api/v1/public/status'));
  assert.strictEqual(requests[1].url, 'https://play.tizenry.xyz/monitor-api/v1/public/quotas');
  assert(!requests[1].options || requests[1].options.method !== 'POST', 'quota request must not POST');

  // Both the live endpoint and monitor.json fail: the page must reset, not lie.
  requests[0].resolve(response(503));
  requests[1].resolve(response(503));
  await flush();
  assert.strictEqual(requests.length, 3, 'live failure should try the historical snapshot');
  assert.strictEqual(requests[2].url, './monitor.json');
  requests[2].resolve(response(503));
  await flush();
  assertUnavailable(environment);
  assert(elements.get('quotaMessage').textContent.includes('额度接口暂不可用'));

  // A second click while a request is in flight must not create a duplicate.
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 5);
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 5, 'request coordinator must skip duplicate refreshes');
  requests[3].resolve(response(200, {
    schema: 'public-v1',
    updated_at: '2026-08-23T00:00:00Z',
    summary: { total: 1, full_ok: 1, basic_ok: 0, failed: 0, unsupported: 0, avg_latency_ms: 25 },
    models: [{ name: 'healthy', status: 'full_ok' }],
  }));
  requests[4].resolve(response(200, {
    schema: 'quota-v1',
    updated_at: '2026-08-23T00:00:00Z',
    next_check_at: '2026-08-23T00:01:00Z',
    running: false,
    summary: { providers: 3, accounts: 4, ok: 2, rate_limited: 0, unauthorized: 0, failed: 0, unknown: 2 },
    records: [
      { provider: 'OpenRouter', account_label: 'account-total', status: 'ok', used: 10, remaining: 90, limit: 100, reset_at: '2026-08-24T00:00:00Z', latency_ms: 31, accuracy: 'exact', checked_at: '2026-08-23T00:00:00Z' },
      { provider: 'OpenRouter', account_label: 'account-N', status: 'ok', used: 2, remaining: 8, limit: 10, latency_ms: 32, accuracy: 'estimated', checked_at: '2026-08-23T00:00:00Z' },
      { provider: 'NVIDIA', account_label: 'nvidia-key', status: 'unknown', used: null, remaining: null, limit: null, latency_ms: 40, accuracy: 'status_only', checked_at: '2026-08-23T00:00:00Z' },
      { provider: 'Cloudflare', account_label: '<img src=x onerror=alert(1)>', status: 'unknown', used: null, remaining: null, limit: null, latency_ms: 41, accuracy: 'unknown', error: '<script>alert(1)</script>', checked_at: '2026-08-23T00:00:00Z' },
      { provider: 'P'.repeat(100), account_label: 'A'.repeat(100), status: 'not-allowed', used: -2, remaining: 1e100, limit: Number.POSITIVE_INFINITY, accuracy: 'not-allowed', error: 'E'.repeat(400), checked_at: '2026-08-23T00:00:00Z' },
    ],
  }));
  await flush();
  const quotaText = treeText(elements.get('quotaList'));
  assert(quotaText.includes('account-total') && quotaText.includes('account-N'));
  assert(quotaText.includes('精确') && quotaText.includes('估算') && quotaText.includes('仅状态'));
  assert(quotaText.includes('暂无本地计量'), 'Cloudflare missing usage must not render zero remaining');
  assert(quotaText.includes('<img src=x onerror=alert(1)>'), 'quota labels must be text content');
  assert(quotaText.includes('<script>alert(1)</script>'), 'quota errors must be text content');
  assert(quotaText.includes('P'.repeat(80)) && !quotaText.includes('P'.repeat(81)), 'quota provider must be bounded');
  assert(quotaText.includes('A'.repeat(80)) && !quotaText.includes('A'.repeat(81)), 'quota account label must be bounded');
  assert(quotaText.includes('1000000000000000'), 'quota numbers must have a finite upper bound');
  assert(!quotaText.includes('已用 -2') && !quotaText.includes('Infinity'), 'quota numbers must be non-negative and finite');
  assert(!quotaText.includes('E'.repeat(241)), 'quota error must be bounded');

  // Numeric values from a remote payload are clamped before rendering.
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 7);
  requests[5].resolve(response(200, {
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
  // Quota failure is isolated: model data above remains live, while last quota data is stale.
  requests[6].resolve(response(503));
  await flush();
  assert.strictEqual(elements.get('totalCount').textContent, 1000000);
  assert.strictEqual(elements.get('fullOkCount').textContent, 0);
  assert.strictEqual(elements.get('basicOkCount').textContent, 1);
  assert.strictEqual(elements.get('failedCount').textContent, 1000000);
  assert.strictEqual(elements.get('avgLatency').textContent, '86400s');
  assert(elements.get('modelList').children.length > 0, 'bounded model should still render');
  assert(elements.get('quotaMessage').textContent.includes('保留最近成功数据'));
  assert(elements.get('quotaList').children.length > 0, 'quota failure must preserve last successful records');
  const modelRowText = elements.get('modelList').children.at(-1).children
    .map((child) => child.textContent).join(' ');
  assert(!modelRowText.includes('undefined'));

  // A 429 starts cooldown; while cooling down, refresh must be skipped.
  elements.get('refreshButton').dispatch('click');
  assert.strictEqual(requests.length, 9);
  requests[7].resolve(response(429, null, '60'));
  requests[8].resolve(response(503));
  await flush();
  assert.strictEqual(requests.length, 10, 'rate limit should still try the historical snapshot');
  requests[9].resolve(response(503));
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
