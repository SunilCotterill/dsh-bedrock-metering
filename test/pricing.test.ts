import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cost, loadBundledTable, PriceBook } from '../src/pricing.ts';

const table = loadBundledTable();
const book = (overrides = {}, region = 'us') => new PriceBook(table, overrides, region, ['amazon-bedrock']);

describe('bundled table', () => {
  it('flags every row unverified with its source and retrieval date', () => {
    assert.ok(table.rows.length > 0);
    for (const row of table.rows) {
      assert.equal(row.verified, false, row.key);
      assert.equal(row.sourceUrl, 'https://aws.amazon.com/bedrock/pricing/', row.key);
      assert.match(row.retrievedAt, /^\d{4}-\d{2}-\d{2}$/, row.key);
      assert.ok(row.modelIds.length > 0, row.key);
    }
  });

  it('carries the plan section 2 rates', () => {
    const rate = (model: string, region = 'us') => book({}, region).lookup('amazon-bedrock', model)?.price;
    assert.deepEqual(pick(rate('global.moonshotai.kimi-k3')), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    assert.deepEqual(pick(rate('us.moonshotai.kimi-k3')), { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 });
    assert.deepEqual(pick(rate('deepseek.v3.2')), { input: 0.62, output: 1.85, cacheRead: null, cacheWrite: null });
    assert.deepEqual(pick(rate('deepseek.v3.2', 'mumbai-saopaulo-jakarta-tokyo-stockholm')), { input: 0.74, output: 2.22, cacheRead: null, cacheWrite: null });
    assert.deepEqual(pick(rate('apac.deepseek.v3.1')), { input: 0.5974, output: 1.7304, cacheRead: null, cacheWrite: null });
    assert.deepEqual(pick(rate('us.moonshotai.kimi-k2-thinking')), { input: 0.6, output: 2.5, cacheRead: null, cacheWrite: null });
    assert.deepEqual(pick(rate('us.moonshotai.kimi-k2.5')), { input: 0.6, output: 3, cacheRead: null, cacheWrite: null });
  });
});

describe('PriceBook.lookup', () => {
  it('prefers the configured region when several rows share a model id', () => {
    assert.equal(book({}, 'us').lookup('amazon-bedrock', 'deepseek.v3-v1:0')?.source, 'deepseek-v3.1-us');
    assert.equal(book({}, 'sydney').lookup('amazon-bedrock', 'deepseek.v3-v1:0')?.source, 'deepseek-v3.1-sydney');
  });

  it('falls back to the first matching row for an unknown region', () => {
    assert.equal(book({}, 'mars').lookup('amazon-bedrock', 'deepseek.v3.2')?.source, 'deepseek-v3.2-us');
  });

  it('lets config overrides win, on any provider route', () => {
    const overrides = {
      'amazon-bedrock': { 'global.moonshotai.kimi-k3': { input: 1, output: 2 } },
      'local-deepseek': { 'deepseek-v4-flash': { input: 0.1, output: 0.2 } },
    };
    assert.deepEqual(book(overrides).lookup('amazon-bedrock', 'global.moonshotai.kimi-k3'), { price: { input: 1, output: 2 }, source: 'config', verified: true });
    assert.equal(book(overrides).lookup('local-deepseek', 'deepseek-v4-flash')?.source, 'config');
  });

  it('applies bundled Bedrock rows only to the Bedrock routes', () => {
    assert.equal(book().lookup('local-deepseek', 'deepseek.v3.2'), undefined);
    assert.equal(book().lookup('amazon-bedrock', 'no.such-model'), undefined);
  });
});

describe('cost', () => {
  const kimi = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const deepseek = { input: 0.62, output: 1.85, cacheRead: null, cacheWrite: null };

  it('prices disjoint input, output and cache buckets per 1M tokens', () => {
    const usage = { inputTokens: 6087, outputTokens: 84, cacheReadTokens: 7936, cacheWriteTokens: 0, totalTokens: 14107 };
    assert.equal(round(cost(usage, kimi, 'input-rate')), round((6087 * 3 + 84 * 15 + 7936 * 0.3) / 1e6));
  });

  it('bills cache writes at the published cache-write rate', () => {
    assert.equal(round(cost({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }, kimi, 'input-rate')), 3.75);
  });

  it('bills cache reads at the input rate when no cache price is published (D13)', () => {
    const usage = { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 1_000_000 };
    assert.equal(round(cost(usage, deepseek, 'input-rate')), round((1000 * 0.62 + 1_000_000 * 0.62) / 1e6));
    assert.equal(round(cost(usage, deepseek, 'zero')), round(1000 * 0.62 / 1e6));
  });

  it('bills unpublished cache writes at zero', () => {
    assert.equal(cost({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 5000 }, deepseek, 'input-rate'), 0);
  });

  it('treats output as inclusive of reasoning unless the total shows otherwise (D12)', () => {
    const inclusive = { inputTokens: 100, outputTokens: 1000, reasoningTokens: 600, totalTokens: 1100 };
    assert.equal(round(cost(inclusive, kimi, 'input-rate')), round((100 * 3 + 1000 * 15) / 1e6));
    const separate = { inputTokens: 100, outputTokens: 400, reasoningTokens: 600, totalTokens: 1100 };
    assert.equal(round(cost(separate, kimi, 'input-rate')), round((100 * 3 + 1000 * 15) / 1e6));
    const noTotal = { inputTokens: 100, outputTokens: 400, reasoningTokens: 600 };
    assert.equal(round(cost(noTotal, kimi, 'input-rate')), round((100 * 3 + 400 * 15) / 1e6));
  });
});

function pick(price: { input: number; output: number; cacheRead?: number | null; cacheWrite?: number | null } | undefined) {
  assert.ok(price);
  return { input: price.input, output: price.output, cacheRead: price.cacheRead ?? null, cacheWrite: price.cacheWrite ?? null };
}

function round(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}
