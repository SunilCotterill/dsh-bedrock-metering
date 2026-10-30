import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { handleBudgetCommand } from '../src/command.ts';
import { preStepListener, streamListener } from '../src/hooks.ts';
import { loadBundledTable } from '../src/pricing.ts';
import { MeteringRuntime } from '../src/runtime.ts';
import type { MeteringConfig } from '../src/runtime.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-bedrock-metering-hooks-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let ledgers = 0;

function setup(budget: Partial<MeteringConfig['budget']> = {}, meter: Partial<MeteringConfig['meter']> = {}) {
  const config: MeteringConfig = {
    ledgerPath: join(dir, `ledger-${++ledgers}.jsonl`),
    budget: { window: 'day', limitUsd: 50, warnAt: [0.8, 0.95], stopAt: 1, ...budget },
    meter: { providers: ['amazon-bedrock'], region: 'us', unpricedModel: 'warn-zero', cacheFallback: 'input-rate', notifyModel: false, ...meter },
    override: { allow: true, maxMinutes: 120 },
    prices: {},
  };
  const clock = { now: Date.parse('2026-10-28T12:00:00.000Z') };
  const stderr: string[] = [];
  const errors: string[] = [];
  const session = Session.create(SessionId('session-test'));
  const injected: unknown[] = [];
  const agent = {
    id: session.id,
    session,
    options: { provider: 'amazon-bedrock', model: 'global.moonshotai.kimi-k3' },
    inject: (message: unknown) => injected.push(message),
  } as unknown as Agent;
  let ids = 0;
  const runtime = new MeteringRuntime(config, {
    now: () => clock.now,
    newId: () => `attempt-${++ids}`,
    warn: () => {},
    error: (message) => errors.push(message),
    stderr: () => (line) => stderr.push(line),
    session: (id) => (id === session.id ? session : undefined),
    agent: (id) => (id === session.id ? agent : undefined),
    home: '/home/test/.dsh-local',
    profile: 'headless',
  }, loadBundledTable());
  const ledgerRows = () => readFileSync(runtime.ledger.path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const records = () => [...Array(session.seq).keys()]
    .map((seq) => session.eventAt(SessionSeq(seq)) as { type: string; ignorable?: true; data: unknown } | undefined)
    .filter((event) => event?.type.startsWith('plugin:'));
  return { runtime, agent, session, clock, stderr, errors, injected, ledgerRows, records };
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'amazon-bedrock', model: 'global.moonshotai.kimi-k3', messages: [], sessionId: SessionId('session-test'), ...extra };
}

async function* adapter(chunks: StreamChunk[], failAfter = false): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk;
  if (failAfter) throw new Error('socket closed');
}

const usageChunk = (inputTokens: number, outputTokens: number, cacheReadTokens = 0): StreamChunk => ({
  type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens },
});
const done: StreamChunk = { type: 'finish', reason: { kind: 'stop' } };

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = [];
  for await (const chunk of stream) seen.push(chunk);
  return seen;
}

describe('llm/stream meter', () => {
  it('forwards chunks unchanged and appends one priced row', async () => {
    const { runtime, ledgerRows } = setup();
    const chunks = [usageChunk(6087, 84, 7936), done];
    const seen = await drain(streamListener(runtime)(request(), () => adapter(chunks)));
    assert.deepEqual(seen, chunks);
    const [row] = ledgerRows();
    assert.equal(row.kind, 'usage');
    assert.equal(row.provider, 'amazon-bedrock');
    assert.equal(row.in, 6087);
    assert.equal(row.cacheRead, 7936);
    assert.equal(row.priced, true);
    assert.equal(row.price, 'kimi-k3-global');
    assert.equal(row.outcome, 'stop');
    assert.equal(row.usd, Math.round(((6087 * 3 + 84 * 15 + 7936 * 0.3) / 1e6) * 1e8) / 1e8);
  });

  it('still bills a stream that fails after reporting usage', async () => {
    const { runtime, ledgerRows } = setup();
    await assert.rejects(drain(streamListener(runtime)(request(), () => adapter([usageChunk(100, 10)], true))), /socket closed/);
    assert.equal(ledgerRows()[0].outcome, 'thrown');
  });

  it('logs unmetered routes with tokens only', async () => {
    const { runtime, ledgerRows } = setup();
    await drain(streamListener(runtime)(request({ provider: 'local-deepseek', model: 'deepseek-v4-flash' }), () => adapter([usageChunk(50, 5), done])));
    const [row] = ledgerRows();
    assert.equal(row.metered, false);
    assert.equal(row.priced, false);
    assert.equal(row.usd, 0);
  });

  it('warns once about an unpriced metered model and counts it at $0', async () => {
    const { runtime, ledgerRows, stderr } = setup({}, { providers: ['amazon-bedrock', 'deepseek-official'] });
    const listener = streamListener(runtime);
    for (let i = 0; i < 2; i++) await drain(listener(request({ provider: 'deepseek-official', model: 'deepseek-flash' }), () => adapter([usageChunk(50, 5), done])));
    assert.equal(ledgerRows().filter((row) => row.metered && !row.priced).length, 2);
    assert.equal(stderr.filter((line) => line.includes('no Bedrock price for deepseek-official/deepseek-flash')).length, 1);
  });

  it('announces a crossed threshold on stderr and as a durable record', async () => {
    const { runtime, stderr, records } = setup({ limitUsd: 0.05 });
    await drain(streamListener(runtime)(request(), () => adapter([usageChunk(10_000, 1000), done])));
    assert.deepEqual(stderr, ['dsh: budget: 90% of $0.05 daily limit used ($0.045)']);
    const [record] = records();
    assert.equal(record?.type, 'plugin:dsh-bedrock-metering/warning');
    assert.equal(record?.ignorable, true);
  });

  it('injects a model-visible notice only when notifyModel is on', async () => {
    for (const notifyModel of [false, true]) {
      const { runtime, injected } = setup({ limitUsd: 0.05 }, { notifyModel });
      await drain(streamListener(runtime)(request(), () => adapter([usageChunk(10_000, 1000), done])));
      assert.equal(injected.length, notifyModel ? 1 : 0);
    }
  });
});

describe('stop', () => {
  it('rejects the step at pre-step once the limit is reached', async () => {
    const { runtime, agent, stderr, records } = setup({ limitUsd: 0.001 });
    await drain(streamListener(runtime)(request(), () => adapter([usageChunk(10_000, 1000), done])));
    let reached = false;
    const decision = await preStepListener(runtime)({ agent, turn: 2, step: 1 }, async () => {
      reached = true;
      return { kind: 'enter', messages: [] };
    });
    assert.deepEqual(decision, { kind: 'reject' });
    assert.equal(reached, false);
    assert.match(stderr.at(-1) ?? '', /^dsh: budget: stopped: \$0\.045 of \$0\.001 daily Bedrock budget used/);
    const stop = records().find((event) => event?.type === 'plugin:dsh-bedrock-metering/stop');
    assert.deepEqual((stop?.data as { via: string; turn: number }).via, 'pre-step');
  });

  it('lets the step through for an agent on an unmetered route', async () => {
    const { runtime, agent } = setup({ limitUsd: 0 });
    runtime.ledger.append({ v: 1, kind: 'usage', ts: '2026-10-28T11:00:00.000Z', home: '/h', profile: 'web', attempt: 'x', provider: 'amazon-bedrock', model: 'm', in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 1, metered: true, priced: true });
    const local = { ...agent, options: { provider: 'local-deepseek', model: 'deepseek-v4-flash' } } as unknown as Agent;
    const decision = await preStepListener(runtime)({ agent: local, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(decision.kind, 'enter');
  });

  it('guards hand-built metered calls with a non-retryable LlmError', async () => {
    const { runtime, ledgerRows } = setup({ limitUsd: 0.001 });
    await drain(streamListener(runtime)(request(), () => adapter([usageChunk(10_000, 1000), done])));
    let dispatched = false;
    assert.throws(
      () => streamListener(runtime)(request({ purpose: 'session-title' }), () => {
        dispatched = true;
        return adapter([done]);
      }),
      (error: unknown) => error instanceof LlmError && error.code === 'BUDGET_EXCEEDED' && error.failure.code === 'BUDGET_EXCEEDED',
    );
    assert.equal(dispatched, false);
    const refused = ledgerRows().filter((row) => row.kind === 'refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].purpose, 'session-title');
  });

  it('never guards unmetered routes', async () => {
    const { runtime } = setup({ limitUsd: 0 });
    runtime.ledger.append({ v: 1, kind: 'usage', ts: '2026-10-28T11:00:00.000Z', home: '/h', profile: 'web', attempt: 'x', provider: 'amazon-bedrock', model: 'm', in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 1, metered: true, priced: true });
    const seen = await drain(streamListener(runtime)(request({ provider: 'local-deepseek', model: 'x' }), () => adapter([done])));
    assert.equal(seen.length, 1);
  });

  it('refuses unpriced metered models under unpricedModel: block', () => {
    const { runtime } = setup({}, { unpricedModel: 'block' });
    assert.throws(() => streamListener(runtime)(request({ model: 'no.such-model' }), () => adapter([done])), (error: unknown) => error instanceof LlmError && error.code === 'BUDGET_UNPRICED_MODEL');
  });
});

describe('/budget', () => {
  it('reports status per route', async () => {
    const { runtime, agent } = setup();
    await drain(streamListener(runtime)(request(), () => adapter([usageChunk(6087, 84, 7936), done])));
    const result = handleBudgetCommand(runtime, { agent, rawInput: '' });
    assert.equal(result.kind, 'success');
    assert.match(result.text ?? '', /Spent \$0\.0219 of \$50\.00 \(0%\)/);
    assert.match(result.text ?? '', /amazon-bedrock\/global\.moonshotai\.kimi-k3: 1 call, in 6087, out 84, cache read 7936/);
  });

  it('overrides a stop for a bounded time, shared through the ledger', async () => {
    const { runtime, agent, clock, ledgerRows, records } = setup({ limitUsd: 0.001 });
    await drain(streamListener(runtime)(request(), () => adapter([usageChunk(10_000, 1000), done])));
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' override 121' }).kind, 'error');
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' override soon' }).kind, 'error');
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' override 30' }).kind, 'success');
    assert.equal(runtime.gate(agent, 2, 1), false);
    assert.equal(ledgerRows().at(-1).kind, 'override');
    assert.ok(records().some((event) => event?.type === 'plugin:dsh-bedrock-metering/override'));
    clock.now += 31 * 60_000;
    assert.equal(runtime.gate(agent, 3, 1), true);
  });

  it('refuses overrides when they are disabled', () => {
    const { runtime, agent } = setup();
    runtime.config.override.allow = false;
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' override 10' }).kind, 'error');
  });

  it('resets the window', async () => {
    const { runtime, agent, clock } = setup({ limitUsd: 0.001 });
    await drain(streamListener(runtime)(request(), () => adapter([usageChunk(10_000, 1000), done])));
    clock.now += 1000;
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' reset' }).kind, 'success');
    clock.now += 1000;
    assert.equal(runtime.gate(agent, 2, 1), false);
  });

  it('prints usage for unknown verbs', () => {
    const { runtime, agent } = setup();
    assert.deepEqual(handleBudgetCommand(runtime, { agent, rawInput: ' spend' }).kind, 'error');
  });
});
