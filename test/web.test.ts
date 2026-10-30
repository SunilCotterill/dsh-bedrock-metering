import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, describe, it } from 'node:test';
import { evaluate, summarize } from '../src/budget.ts';
import type { BudgetConfig } from '../src/budget.ts';
import type { HeldRow, LedgerRow } from '../src/ledger.ts';
import { loadBundledTable } from '../src/pricing.ts';
import { MeteringRuntime } from '../src/runtime.ts';
import { budgetStatus, handleStatus, statusLevel } from '../src/web.ts';

const daily: BudgetConfig = { window: 'day', limitUsd: 50, warnAt: [0.8, 0.95], stopAt: 1 };
const now = new Date(2026, 9, 30, 12, 0).getTime();

function held(usd: number, extra: Partial<LedgerRow> = {}): HeldRow {
  return {
    at: now - 1000,
    row: {
      v: 1, kind: 'usage', ts: new Date(now - 1000).toISOString(), home: '/h', profile: 'web', attempt: `a${usd}`,
      provider: 'amazon-bedrock', model: 'global.moonshotai.kimi-k3', in: 1, out: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      usd, metered: true, priced: true, ...extra,
    } as LedgerRow,
  };
}

function statusFor(usd: number, config = daily, rows: HeldRow[] = []) {
  const summary = summarize([held(usd), ...rows], config.window, now);
  return budgetStatus(summary, evaluate(summary, config, now), config);
}

describe('status colour bands', () => {
  it('is neutral below the first threshold, amber from it, red from the last one and over the limit', () => {
    assert.equal(statusFor(39.99).level, 'ok');
    assert.equal(statusFor(40).level, 'warn');
    assert.equal(statusFor(47.5).level, 'critical');
    assert.equal(statusFor(50).level, 'stopped');
  });

  it('with a single threshold, turns red only when the limit is reached', () => {
    const single = { ...daily, warnAt: [0.8] };
    assert.equal(statusFor(49, single).level, 'warn');
    assert.equal(statusFor(50, single).level, 'stopped');
  });

  it('shows an override that lifts a stop as amber', () => {
    const override: HeldRow = {
      at: now - 500,
      row: { v: 1, kind: 'override', ts: new Date(now - 500).toISOString(), home: '/h', profile: 'web', until: new Date(now + 600_000).toISOString(), minutes: 10 },
    };
    const status = statusFor(60, daily, [override]);
    assert.equal(status.level, 'overridden');
    assert.match(status.tooltip, /Override active until 2026-10-30 12:10/);
  });

  it('accepts a verdict directly', () => {
    const summary = summarize([held(10)], 'day', now);
    assert.equal(statusLevel(evaluate(summary, daily, now), daily), 'ok');
  });
});

describe('status body', () => {
  it('carries the pill label, a clamped bar and a tooltip', () => {
    const status = statusFor(12.3);
    assert.equal(status.label, 'Bedrock 24%');
    assert.equal(status.bar, 0.246);
    assert.equal(status.tooltip.split('\n')[0], '$12.30 of $50.00 daily Bedrock budget (24%)');
    assert.match(status.tooltip, /Resets 2026-10-31 00:00/);
    assert.match(status.tooltip, /Warns at 80%, 95%; stops at 100%/);
    assert.equal(status.resetsAt, new Date(2026, 9, 31).toISOString());
    assert.equal(statusFor(80).bar, 1);
  });

  it('says stopped and how to continue', () => {
    const status = statusFor(51);
    assert.equal(status.label, 'Bedrock stopped');
    assert.match(status.tooltip, /\/budget override <minutes>/);
  });
});

describe('status route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bedrock-metering-web-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new MeteringRuntime({
    ledgerPath: join(dir, 'ledger.jsonl'),
    budget: daily,
    meter: { providers: ['amazon-bedrock'], region: 'us', unpricedModel: 'warn-zero', cacheFallback: 'input-rate', notifyModel: false },
    override: { allow: true, maxMinutes: 120 },
    prices: {},
  }, {
    now: () => now, newId: () => 'id', warn: () => {}, error: () => {}, stderr: () => undefined,
    session: () => undefined, agent: () => undefined, home: '/h', profile: 'web',
  }, loadBundledTable());

  function call(method: string, rejection?: number) {
    const headers: Record<string, string> = {};
    const res = { statusCode: 0, body: '', setHeader: (k: string, v: string) => { headers[k] = v; }, end: (body = '') => { res.body = body; } };
    handleStatus(runtime, { requestRejection: () => rejection }, { method, url: '/bedrock-metering/status?session=s1' } as IncomingMessage, res as unknown as ServerResponse);
    return { ...res, headers };
  }

  it('returns the status as uncached JSON', () => {
    const res = call('GET');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(res.body).label, 'Bedrock 0%');
  });

  it('answers untrusted requests with the fence status and no body', () => {
    const res = call('GET', 403);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, '');
  });

  it('refuses other methods', () => {
    assert.equal(call('POST').statusCode, 405);
  });
});

describe('client bundle', () => {
  type Element = { type: string; props: Record<string, unknown> | null; children: unknown[] };
  const react = {
    createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props, children }),
    useEffect: () => {},
    useState: (initial: unknown) => [initial, () => {}],
  };
  let loaded: { id: string; factory: (require: (name: string) => unknown) => Record<string, any> } | undefined;
  runInNewContext(readFileSync(new URL('../client/budget-pill.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (spec: typeof loaded) => { loaded = spec; } } },
  });
  const exports = loaded!.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require ${name}`);
  });

  it('registers as the package id and requires only react', () => {
    assert.equal(loaded?.id, 'dsh-bedrock-metering');
    // Objects from the VM realm compare by value, not prototype.
    assert.equal(JSON.stringify(exports['inject']), '["slots"]');
  });

  it('registers the pill in the composer slot', () => {
    const registered: unknown[] = [];
    const ctx = { slots: { inject: (_key: string, callback: () => void) => callback(), register: (options: unknown, component: unknown) => registered.push(options, component) } };
    exports['apply'](ctx);
    assert.equal(JSON.stringify(registered[0]), JSON.stringify({ name: 'conversation.input.right', id: 'bedrock-metering-budget', order: -10 }));
    assert.equal(registered[1], exports['BudgetPill']);
  });

  it('renders the label, colour band and bar width from the status body', () => {
    const pill = exports['pillElement'](statusFor(47.5)) as Element;
    const style = pill.props?.['style'] as Record<string, unknown>;
    assert.equal(pill.props?.['data-level'], 'critical');
    assert.equal(style['color'], '#dc2626');
    assert.equal((pill.children[0] as Element).children[0], 'Bedrock 95%');
    const bar = (pill.children[1] as Element).children[0] as Element;
    assert.equal((bar.props?.['style'] as Record<string, unknown>)['width'], '95%');
    assert.equal(pill.props?.['title'], statusFor(47.5).tooltip);
  });

  it('stays neutral below the first threshold', () => {
    const pill = exports['pillElement'](statusFor(5)) as Element;
    assert.equal((pill.props?.['style'] as Record<string, unknown>)['color'], 'inherit');
  });

  it('renders nothing until the route answers', () => {
    assert.equal(exports['BudgetPill']({}), null);
  });
});
