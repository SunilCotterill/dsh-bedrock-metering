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
    budget: { window: 'session', limitUsd: 50, warnAt: [0.8, 0.95], stopAt: 1, ...budget },
    meter: { providers: ['amazon-bedrock'], region: 'us', unpricedModel: 'warn-zero', cacheFallback: 'input-rate', notifyModel: false, ...meter },
    override: { allow: true, maxMinutes: 120 },
    prices: {},
  };
  const clock = { now: Date.parse('2026-10-28T12:00:00.000Z') };
  const stderr: string[] = [];
  const errors: string[] = [];
  const injected: unknown[] = [];
  const agents = new Map<string, Agent>();
  /** A live agent on its own session: another conversation, or a subagent child. */
  const addAgent = (id: string) => {
    const session = Session.create(SessionId(id));
    const agent = {
      id: session.id,
      session,
      options: { provider: 'amazon-bedrock', model: 'global.moonshotai.kimi-k3' },
      inject: (message: unknown) => injected.push(message),
    } as unknown as Agent;
    agents.set(id, agent);
    return agent;
  };
  const agent = addAgent('session-test');
  const session = agent.session;
  let ids = 0;
  const runtime = new MeteringRuntime(config, {
    now: () => clock.now,
    newId: () => `attempt-${++ids}`,
    warn: () => {},
    error: (message) => errors.push(message),
    stderr: () => (line) => stderr.push(line),
    session: (id) => agents.get(id)?.session,
    agent: (id) => agents.get(id),
    home: '/home/test/.dsh-local',
    profile: 'headless',
  }, loadBundledTable());
  const ledgerRows = () => readFileSync(runtime.ledger.path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const records = (of: Session = session) => [...Array(of.seq).keys()]
    .map((seq) => of.eventAt(SessionSeq(seq)) as { type: string; ignorable?: true; data: unknown } | undefined)
    .filter((event) => event?.type.startsWith('plugin:'));
  return { runtime, agent, session, clock, stderr, errors, injected, ledgerRows, records, addAgent };
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
    assert.deepEqual(stderr, ['dsh: budget: 90% of $0.05 conversation limit used ($0.045)']);
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
    assert.match(stderr.at(-1) ?? '', /^dsh: budget: stopped: \$0\.045 of \$0\.001 conversation Bedrock budget used; this conversation stays stopped/);
    const stop = records().find((event) => event?.type === 'plugin:dsh-bedrock-metering/stop');
    assert.deepEqual((stop?.data as { via: string; turn: number }).via, 'pre-step');
  });

  it('lets the step through for an agent on an unmetered route', async () => {
    const { runtime, agent } = setup({ limitUsd: 0 });
    runtime.ledger.append({ v: 1, kind: 'usage', ts: '2026-10-28T11:00:00.000Z', home: '/h', profile: 'web', session: 'session-test', attempt: 'x', provider: 'amazon-bedrock', model: 'm', in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 1, metered: true, priced: true });
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
    runtime.ledger.append({ v: 1, kind: 'usage', ts: '2026-10-28T11:00:00.000Z', home: '/h', profile: 'web', session: 'session-test', attempt: 'x', provider: 'amazon-bedrock', model: 'm', in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, usd: 1, metered: true, priced: true });
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

  it('overrides a daily stop for a bounded time, shared through the ledger', async () => {
    const { runtime, agent, clock, ledgerRows, records, addAgent } = setup({ window: 'day', limitUsd: 0.001 });
    await drain(streamListener(runtime)(request(), () => adapter([usageChunk(10_000, 1000), done])));
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' override 121' }).kind, 'error');
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' override soon' }).kind, 'error');
    assert.equal(handleBudgetCommand(runtime, { agent, rawInput: ' override 30' }).kind, 'success');
    assert.equal(runtime.gate(agent, 2, 1), false);
    assert.equal(runtime.gate(addAgent('session-other'), 1, 1), false);
    assert.equal(ledgerRows().at(-1).kind, 'override');
    assert.equal(ledgerRows().at(-1).window, 'day');
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

describe('conversation window', () => {
  const spend = (runtime: MeteringRuntime, sessionId: string, purpose?: GenerateOptions['purpose']) =>
    drain(streamListener(runtime)(request({ sessionId: SessionId(sessionId), ...purpose === undefined ? {} : { purpose } }), () => adapter([usageChunk(10_000, 1000), done])));
  const refusedFor = (runtime: MeteringRuntime, options: Partial<GenerateOptions>) => {
    try {
      streamListener(runtime)(request(options), () => adapter([done]));
      return false;
    } catch (error) {
      return error instanceof LlmError && error.code === 'BUDGET_EXCEEDED';
    }
  };

  it('is the default and words the stop for a conversation', async () => {
    const { runtime, agent, stderr } = setup({ limitUsd: 0.04 });
    assert.equal(runtime.config.budget.window, 'session');
    await spend(runtime, 'session-test');
    assert.equal(runtime.gate(agent, 2, 1), true);
    assert.match(stderr.at(-1) ?? '', /this conversation stays stopped\. Start a new conversation/);
  });

  it('does not let a stop in one conversation block another', async () => {
    const { runtime, agent, addAgent, records, ledgerRows } = setup({ limitUsd: 0.04 });
    const other = addAgent('session-other');
    await spend(runtime, 'session-test');
    assert.equal(runtime.gate(agent, 2, 1), true);
    assert.equal(runtime.gate(other, 1, 1), false);
    // Hand-built calls carry the calling session's id: the title and compaction of the stopped
    // conversation are refused, the other conversation's are not.
    assert.equal(refusedFor(runtime, { purpose: 'session-title' }), true);
    assert.equal(refusedFor(runtime, { purpose: 'compaction' }), true);
    assert.equal(refusedFor(runtime, { sessionId: SessionId('session-other'), purpose: 'session-title' }), false);
    assert.equal(refusedFor(runtime, { sessionId: SessionId('session-other') }), false);
    assert.equal(records(other.session).length, 0);
    assert.ok(records().some((event) => event?.type === 'plugin:dsh-bedrock-metering/stop'));
    assert.deepEqual(ledgerRows().filter((row) => row.kind === 'refused').map((row) => row.session), ['session-test', 'session-test']);
  });

  it('counts a subagent toward its own conversation, not its parent', async () => {
    const { runtime, agent, addAgent } = setup({ limitUsd: 0.04 });
    // A subagent runs on a child session with a fresh id (dsh-subagent mints it with randomUUID).
    const child = addAgent('57d5c73e-7b19-4865-8288-1992077d7d75');
    await spend(runtime, child.session.id);
    assert.equal(runtime.gate(child, 1, 2), true);
    assert.equal(runtime.gate(agent, 2, 1), false);
    assert.match(handleBudgetCommand(runtime, { agent, rawInput: '' }).text ?? '', /Spent \$0\.00 of \$0\.04/);
    assert.match(handleBudgetCommand(runtime, { agent: child, rawInput: '' }).text ?? '', /Spent \$0\.045 of \$0\.04/);
  });

  it('warns each conversation once as it crosses a threshold', async () => {
    const { runtime, addAgent, stderr } = setup({ limitUsd: 0.05 });
    addAgent('session-other');
    await spend(runtime, 'session-test');
    await spend(runtime, 'session-other');
    assert.deepEqual(stderr, [
      'dsh: budget: 90% of $0.05 conversation limit used ($0.045)',
      'dsh: budget: 90% of $0.05 conversation limit used ($0.045)',
    ]);
  });

  it('lifts a stop only in the conversation that ran /budget override', async () => {
    const { runtime, agent, addAgent, ledgerRows } = setup({ limitUsd: 0.04 });
    const other = addAgent('session-other');
    await spend(runtime, 'session-test');
    await spend(runtime, 'session-other');
    const result = handleBudgetCommand(runtime, { agent, rawInput: 'override 30' });
    assert.equal(result.kind, 'success');
    assert.match(result.text ?? '', /^Budget stop lifted for this conversation until .* \(30 min\)\. Spent in this conversation: \$0\.045 of \$0\.04\.$/);
    assert.equal(runtime.gate(agent, 2, 1), false);
    assert.equal(runtime.gate(other, 2, 1), true);
    const row = ledgerRows().at(-1);
    assert.equal(row.kind, 'override');
    assert.equal(row.window, 'session');
    assert.equal(row.session, 'session-test');
  });

  it('restarts only this conversation\'s count on /budget reset', async () => {
    const { runtime, agent, addAgent, clock, ledgerRows } = setup({ limitUsd: 0.04 });
    const other = addAgent('session-other');
    await spend(runtime, 'session-test');
    await spend(runtime, 'session-other');
    clock.now += 1000;
    const result = handleBudgetCommand(runtime, { agent, rawInput: 'reset' });
    assert.match(result.text ?? '', /^Conversation budget reset: spend counts from now\. \$0\.045 spent since the conversation started no longer counts toward this conversation's \$0\.04 limit\. Other conversations are unaffected\./);
    assert.equal(ledgerRows().at(-1).window, 'session');
    clock.now += 1000;
    assert.equal(runtime.gate(agent, 2, 1), false);
    assert.equal(runtime.gate(other, 2, 1), true);
    assert.match(handleBudgetCommand(runtime, { agent, rawInput: 'status' }).text ?? '', /counted since the \/budget reset at /);
  });

  it('reports the conversation\'s spend, calls and tokens in /budget status', async () => {
    const { runtime, agent, addAgent } = setup();
    addAgent('session-other');
    await spend(runtime, 'session-test');
    await spend(runtime, 'session-test', 'session-title');
    await spend(runtime, 'session-other');
    await drain(streamListener(runtime)(request({ provider: 'local-deepseek', model: 'deepseek-v4-flash' }), () => adapter([usageChunk(50, 5), done])));
    const lines = (handleBudgetCommand(runtime, { agent, rawInput: 'status' }).text ?? '').split('\n');
    assert.equal(lines[0], 'Bedrock budget for this conversation, counted since it started');
    assert.equal(lines[1], 'Spent $0.09 of $50.00 (0%); warn at 80%, 95%; stop at 100%.');
    assert.equal(lines[2], 'Metered calls: 2 calls, in 20k, out 2000');
    assert.ok(lines.includes('  amazon-bedrock/global.moonshotai.kimi-k3: 2 calls, in 20k, out 2000  $0.09'));
    assert.ok(lines.includes('  local-deepseek/deepseek-v4-flash: 1 call, in 50, out 5'));
  });

  it('logs a call without a session id but counts it toward no conversation', async () => {
    const { runtime, agent, ledgerRows } = setup({ limitUsd: 0.04 });
    await drain(streamListener(runtime)(request({ sessionId: undefined }), () => adapter([usageChunk(10_000, 1000), done])));
    assert.equal(ledgerRows()[0].session, undefined);
    assert.equal(ledgerRows()[0].usd, 0.045);
    assert.equal(runtime.gate(agent, 1, 1), false);
    assert.equal(refusedFor(runtime, { sessionId: undefined }), false);
  });
});
