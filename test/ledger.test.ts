import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { summarize } from '../src/budget.ts';
import { expandHome, Ledger, rowKey } from '../src/ledger.ts';
import type { UsageRow } from '../src/ledger.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-bedrock-metering-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const freshPath = () => join(dir, `nested-${++files}`, 'ledger.jsonl');
const existingPath = () => {
  const path = freshPath();
  mkdirSync(join(path, '..'), { recursive: true });
  return path;
};

function row(attempt: string, usd: number, ts = '2026-10-28T10:00:00.000Z', extra: Partial<UsageRow> = {}): UsageRow {
  return {
    v: 1, kind: 'usage', ts, home: '/h', profile: 'headless', session: 's1', turn: 1, step: 1, attempt,
    provider: 'amazon-bedrock', model: 'global.moonshotai.kimi-k3', in: 1, out: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    usd, metered: true, priced: true, ...extra,
  };
}

const total = (ledger: Ledger) => ledger.rows().reduce((sum, held) => sum + (held.row.kind === 'usage' ? held.row.usd : 0), 0);

describe('Ledger', () => {
  it('creates the directory and file on first append, owner-only', () => {
    const path = freshPath();
    new Ledger(path).append(row('a', 1));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8').split('\n').filter(Boolean).length, 1);
  });

  it('replays every row appended by several writers', () => {
    const path = freshPath();
    const web = new Ledger(path);
    const headless = new Ledger(path);
    web.append(row('a', 1));
    headless.append(row('b', 2));
    web.append(row('c', 0.5));
    const reader = new Ledger(path);
    reader.refresh(Number.NEGATIVE_INFINITY);
    assert.equal(total(reader), 3.5);
    assert.equal(reader.refresh(Number.NEGATIVE_INFINITY), false);
    headless.append(row('d', 4));
    assert.equal(reader.refresh(Number.NEGATIVE_INFINITY), true);
    assert.equal(total(reader), 7.5);
  });

  it('dedupes rows with the same key', () => {
    const path = freshPath();
    const ledger = new Ledger(path);
    ledger.append(row('same', 1));
    ledger.append(row('same', 1));
    ledger.refresh(Number.NEGATIVE_INFINITY);
    assert.equal(ledger.rows().length, 1);
  });

  it('keys rows by attempt when present and by content otherwise', () => {
    assert.equal(rowKey(row('x', 1)), 'usage|s1|1|1|x');
    const legacy = { ...row('', 1), attempt: '' };
    assert.match(rowKey(legacy), /^[0-9a-f]{40}$/);
  });

  it('waits for a partial trailing line to complete', () => {
    const path = freshPath();
    const ledger = new Ledger(path);
    ledger.append(row('a', 1));
    const partial = JSON.stringify(row('b', 2));
    appendFileSync(path, partial.slice(0, 20));
    ledger.refresh(Number.NEGATIVE_INFINITY);
    assert.equal(total(ledger), 1);
    appendFileSync(path, partial.slice(20) + '\n');
    ledger.refresh(Number.NEGATIVE_INFINITY);
    assert.equal(total(ledger), 3);
  });

  it('skips malformed lines and reads rows without a kind as usage', () => {
    const path = existingPath();
    const { kind: _kind, ...legacy } = row('legacy', 2);
    writeFileSync(path, ['not json', '{"ts":"nope"}', JSON.stringify(legacy), JSON.stringify(row('a', 1)), ''].join('\n'));
    const ledger = new Ledger(path);
    ledger.refresh(Number.NEGATIVE_INFINITY);
    assert.equal(total(ledger), 3);
  });

  it('drops rows older than the held window and starts over when the file shrinks', () => {
    const path = freshPath();
    const ledger = new Ledger(path);
    ledger.append(row('old', 5, '2026-10-27T10:00:00.000Z'));
    ledger.append(row('new', 1, '2026-10-28T10:00:00.000Z'));
    ledger.refresh(Date.parse('2026-10-28T00:00:00.000Z'));
    assert.equal(total(ledger), 1);
    writeFileSync(path, JSON.stringify(row('fresh', 0.25)) + '\n');
    ledger.refresh(Date.parse('2026-10-28T00:00:00.000Z'));
    assert.equal(total(ledger), 0.25);
  });

  it('replays non-ASCII rows split across read chunks', () => {
    const path = freshPath();
    const ledger = new Ledger(path);
    const wide = 'é'.repeat(700_000);
    ledger.append(row('wide', 1, undefined, { home: wide }));
    ledger.append(row('after', 2));
    ledger.refresh(Number.NEGATIVE_INFINITY);
    assert.equal(total(ledger), 3);
    assert.equal(ledger.rows()[0]?.row.home, wide);
  });

  it('feeds window totals', () => {
    const path = freshPath();
    const ledger = new Ledger(path);
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    ledger.append(row('a', 1.25, new Date(now - 60_000).toISOString()));
    ledger.append({ v: 1, kind: 'refused', ts: new Date(now - 30_000).toISOString(), home: '/h', profile: 'web', attempt: 'r', provider: 'amazon-bedrock', model: 'm' });
    ledger.refresh(Number.NEGATIVE_INFINITY);
    const summary = summarize(ledger.rows(), 'session', now, 's1');
    assert.equal(summary.spentUsd, 1.25);
  });

  it('expands ~ in the configured path', () => {
    assert.ok(!expandHome('~/.dsh-bedrock-metering/ledger.jsonl').startsWith('~'));
  });
});
