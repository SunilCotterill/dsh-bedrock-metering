import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Announcer, calendarEnd, calendarStart, evaluate, formatUsd, stopText, summarize, warningText, windowLabel,
} from '../src/budget.ts';
import type { BudgetConfig } from '../src/budget.ts';
import type { HeldRow, LedgerRow } from '../src/ledger.ts';

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const daily: BudgetConfig = { window: 'day', limitUsd: 50, warnAt: [0.8, 0.95], stopAt: 1 };
const perConversation: BudgetConfig = { ...daily, window: 'session' };

let attempt = 0;
function usage(at: number, usd: number, extra: Partial<LedgerRow> = {}): HeldRow {
  return {
    at,
    row: {
      v: 1, kind: 'usage', ts: new Date(at).toISOString(), home: '/h', profile: 'web', attempt: `a${++attempt}`,
      provider: 'amazon-bedrock', model: 'global.moonshotai.kimi-k3', in: 10, out: 5, cacheRead: 2, cacheWrite: 0, reasoning: 0,
      usd, metered: true, priced: true, ...extra,
    } as LedgerRow,
  };
}
function control(at: number, row: Partial<LedgerRow>): HeldRow {
  return { at, row: { v: 1, ts: new Date(at).toISOString(), home: '/h', profile: 'web', ...row } as LedgerRow };
}

describe('windows', () => {
  it('starts a day at local midnight and ends at the next one', () => {
    const now = local(2026, 10, 28, 17, 55);
    assert.equal(calendarStart('day', now), local(2026, 10, 28));
    assert.equal(calendarEnd('day', now), local(2026, 10, 29));
  });

  it('starts a month on the 1st, local time, across a year end', () => {
    assert.equal(calendarStart('month', local(2026, 12, 31, 23, 59)), local(2026, 12, 1));
    assert.equal(calendarEnd('month', local(2026, 12, 31, 23, 59)), local(2027, 1, 1));
  });

  it('sums only rows inside the current day', () => {
    const now = local(2026, 10, 28, 12);
    const rows = [usage(local(2026, 10, 27, 23, 59), 100), usage(local(2026, 10, 28, 0, 0), 1.5), usage(local(2026, 10, 28, 11), 2.25)];
    const summary = summarize(rows, 'day', now);
    assert.equal(summary.spentUsd, 3.75);
    assert.equal(summary.start, local(2026, 10, 28));
    assert.equal(summary.end, local(2026, 10, 29));
  });

  it('ignores rows stamped after now (clock skew between processes)', () => {
    const now = local(2026, 10, 28, 12);
    assert.equal(summarize([usage(local(2026, 10, 28, 13), 9)], 'day', now).spentUsd, 0);
  });

  it('moves the window start forward on /budget reset', () => {
    const now = local(2026, 10, 28, 12);
    const rows = [usage(local(2026, 10, 28, 9), 40), control(local(2026, 10, 28, 10), { kind: 'reset' }), usage(local(2026, 10, 28, 11), 1)];
    const summary = summarize(rows, 'day', now);
    assert.equal(summary.spentUsd, 1);
    assert.equal(summary.start, local(2026, 10, 28, 10));
  });

  it('scopes a session window to one session', () => {
    const now = local(2026, 10, 28, 12);
    const rows = [usage(now - 1000, 2, { session: 's1' }), usage(now - 500, 3, { session: 's2' })];
    assert.equal(summarize(rows, 'session', now, 's1').spentUsd, 2);
    assert.equal(summarize(rows, 'session', now).spentUsd, 0);
  });

  it('keeps token counts per route, including unmetered routes at $0', () => {
    const now = local(2026, 10, 28, 12);
    const rows = [
      usage(now - 3, 0.5),
      usage(now - 2, 0.25),
      usage(now - 1, 0, { provider: 'local-deepseek', model: 'deepseek-v4-flash', metered: false, priced: false }),
      usage(now, 0, { model: 'mystery', priced: false }),
    ];
    const summary = summarize(rows, 'day', now);
    assert.equal(summary.routes[0]?.calls, 2);
    assert.equal(summary.routes[0]?.in, 20);
    assert.equal(summary.routes.length, 3);
    assert.equal(summary.unpricedCalls, 1);
  });
});

describe('conversation window', () => {
  const now = local(2026, 11, 3, 12);
  const s1 = { session: 's1' } as Partial<LedgerRow>;
  const s2 = { session: 's2' } as Partial<LedgerRow>;

  it('is labelled as a conversation', () => {
    assert.equal(windowLabel('session'), 'conversation');
  });

  it('sums a conversation across calendar days, with its own routes and refusals', () => {
    const rows = [
      usage(local(2026, 10, 30, 9), 4, s1),
      usage(local(2026, 11, 3, 11), 1.25, { ...s1, purpose: 'session-title' }),
      usage(local(2026, 11, 3, 11, 30), 7, s2),
      control(local(2026, 11, 3, 11, 45), { kind: 'refused', attempt: 'r1', provider: 'amazon-bedrock', model: 'm', session: 's2' } as Partial<LedgerRow>),
    ];
    const summary = summarize(rows, 'session', now, 's1');
    assert.equal(summary.spentUsd, 5.25);
    assert.equal(summary.start, Number.NEGATIVE_INFINITY);
    assert.equal(summary.end, undefined);
    assert.equal(summary.routes[0]?.calls, 2);
    assert.equal(summary.refused, 0);
    assert.equal(summarize(rows, 'session', now, 's2').refused, 1);
  });

  it('rolls subagent rows stamped with the conversation into its total', () => {
    const child = { session: 'c1', conversation: 's1' } as Partial<LedgerRow>;
    const until = new Date(now + 30 * 60_000).toISOString();
    const rows = [
      usage(now - 5, 2, s1), usage(now - 4, 0.5, child), usage(now - 3, 0.25, { session: 'c2', conversation: 's1' } as Partial<LedgerRow>),
      usage(now - 2, 7, s2),
      control(now - 1, { kind: 'override', until, minutes: 30, window: 'session', ...child } as Partial<LedgerRow>),
    ];
    const summary = summarize(rows, 'session', now, 's1');
    assert.equal(summary.conversation, 's1');
    assert.equal(summary.spentUsd, 2.75);
    assert.equal(summary.subagentUsd, 0.75);
    assert.equal(summary.subagentSessions, 2);
    assert.equal(summary.overrideUntil, Date.parse(until));
    assert.equal(summarize(rows, 'session', now, 's2').spentUsd, 7);
    assert.equal(summarize(rows, 'session', now, 's2').overrideUntil, undefined);
    assert.equal(summarize(rows, 'day', now).subagentSessions, 0);
  });

  it('warns and stops each conversation against its own spend', () => {
    const rows = [usage(now - 3, 40, s1), usage(now - 2, 10, s2), usage(now - 1, 9.99, s2)];
    const verdict = (session: string) => evaluate(summarize(rows, 'session', now, session), perConversation, now);
    assert.equal(verdict('s1').warnLevel, 0.8);
    assert.equal(verdict('s2').warnLevel, undefined);
    const over = [...rows, usage(now, 10, s1)];
    assert.equal(evaluate(summarize(over, 'session', now, 's1'), perConversation, now).stop, true);
    assert.equal(evaluate(summarize(over, 'session', now, 's2'), perConversation, now).stop, false);
  });

  it('applies an override only to the conversation it was made in', () => {
    const until = new Date(now + 30 * 60_000).toISOString();
    const rows = [
      usage(now - 3, 60, s1), usage(now - 2, 60, s2),
      control(now - 1, { kind: 'override', until, minutes: 30, window: 'session', session: 's1' } as Partial<LedgerRow>),
    ];
    assert.equal(evaluate(summarize(rows, 'session', now, 's1'), perConversation, now).stop, false);
    assert.equal(evaluate(summarize(rows, 'session', now, 's2'), perConversation, now).stop, true);
  });

  it('restarts only its own count on /budget reset', () => {
    const rows = [
      usage(now - 4, 40, s1), usage(now - 3, 30, s2),
      control(now - 2, { kind: 'reset', window: 'session', session: 's1' } as Partial<LedgerRow>),
      usage(now - 1, 1, s1),
    ];
    const summary = summarize(rows, 'session', now, 's1');
    assert.equal(summary.spentUsd, 1);
    assert.equal(summary.start, now - 2);
    assert.equal(summarize(rows, 'session', now, 's2').spentUsd, 30);
  });

  it('keeps conversation overrides and resets out of calendar windows, but honours 0.1.x rows there', () => {
    const until = new Date(now + 30 * 60_000).toISOString();
    const conversationRows = [
      usage(now - 3, 60, s1),
      control(now - 2, { kind: 'override', until, minutes: 30, window: 'session', session: 's1' } as Partial<LedgerRow>),
      control(now - 1, { kind: 'reset', window: 'session', session: 's1' } as Partial<LedgerRow>),
    ];
    const day = summarize(conversationRows, 'day', now);
    assert.equal(day.spentUsd, 60);
    assert.equal(day.overrideUntil, undefined);
    const legacy = [usage(now - 3, 60, s1), control(now - 2, { kind: 'override', until, minutes: 30, session: 's1' } as Partial<LedgerRow>)];
    assert.equal(summarize(legacy, 'day', now).overrideUntil, Date.parse(until));
  });

  it('announces thresholds once per conversation', () => {
    const announcer = new Announcer();
    const rows = [usage(now - 2, 41, s1), usage(now - 1, 42, s2)];
    const next = (session: string) => {
      const summary = summarize(rows, 'session', now, session);
      return announcer.next(summary, evaluate(summary, perConversation, now));
    };
    assert.equal(next('s1'), 0.8);
    assert.equal(next('s1'), undefined);
    assert.equal(next('s2'), 0.8);
  });

  it('words warnings and stops for a conversation', () => {
    const summary = summarize([usage(now - 1, 41.1, s1)], 'session', now, 's1');
    assert.equal(warningText(summary, evaluate(summary, perConversation, now), perConversation), '82% of $50.00 conversation limit used ($41.10)');
    const text = stopText(summarize([usage(now - 1, 50.12, s1)], 'session', now, 's1'), perConversation);
    assert.match(text, /^stopped: \$50\.12 of \$50\.00 conversation Bedrock budget used; this conversation stays stopped\./);
    assert.match(text, /Start a new conversation, run \/budget override <minutes> in this one/);
  });
});

describe('thresholds', () => {
  const at = local(2026, 10, 28, 12);
  const verdictFor = (usd: number, config = daily, rows: HeldRow[] = []) => {
    const summary = summarize([usage(at - 1, usd), ...rows], config.window, at);
    return { summary, verdict: evaluate(summary, config, at) };
  };

  it('warns at 80% and 95% and stops at 100%', () => {
    assert.equal(verdictFor(39.99).verdict.warnLevel, undefined);
    assert.equal(verdictFor(40).verdict.warnLevel, 0.8);
    assert.equal(verdictFor(47.5).verdict.warnLevel, 0.95);
    assert.equal(verdictFor(49.99).verdict.stop, false);
    assert.equal(verdictFor(50).verdict.stop, true);
  });

  it('treats any spend over a zero limit as over the limit', () => {
    const { verdict } = verdictFor(0.0001, { ...daily, limitUsd: 0 });
    assert.equal(verdict.fraction, Number.POSITIVE_INFINITY);
    assert.equal(verdict.stop, true);
  });

  it('warns immediately with warnAt [0]', () => {
    const summary = summarize([], 'day', at);
    assert.equal(evaluate(summary, { ...daily, warnAt: [0] }, at).warnLevel, 0);
  });

  it('lifts the stop while an override is active, even one set before midnight', () => {
    const until = new Date(at + 30 * 60_000).toISOString();
    const override = control(local(2026, 10, 27, 23, 50), { kind: 'override', until, minutes: 30 } as Partial<LedgerRow>);
    const active = verdictFor(60, daily, [override]).verdict;
    assert.equal(active.overLimit, true);
    assert.equal(active.overridden, true);
    assert.equal(active.stop, false);
    const later = at + 31 * 60_000;
    const summary = summarize([usage(at - 1, 60), override], 'day', later);
    assert.equal(evaluate(summary, daily, later).stop, true);
  });
});

describe('Announcer', () => {
  it('announces each newly crossed threshold once per window', () => {
    const announcer = new Announcer();
    const at = local(2026, 10, 28, 12);
    const step = (usd: number, now = at) => {
      const summary = summarize([usage(now - 1, usd)], 'day', now);
      return announcer.next(summary, evaluate(summary, daily, now));
    };
    assert.equal(step(10), undefined);
    assert.equal(step(41), 0.8);
    assert.equal(step(42), undefined);
    assert.equal(step(48), 0.95);
    assert.equal(step(49), undefined);
    assert.equal(step(41, local(2026, 10, 29, 9)), 0.8);
  });
});

describe('messages', () => {
  it('formats the plan warning line', () => {
    const at = local(2026, 10, 28, 12);
    const summary = summarize([usage(at - 1, 41.1)], 'day', at);
    assert.equal(warningText(summary, evaluate(summary, daily, at), daily), '82% of $50.00 daily limit used ($41.10)');
  });

  it('names the reset time and the ways out when stopped', () => {
    const at = local(2026, 10, 28, 12);
    const text = stopText(summarize([usage(at - 1, 50.12)], 'day', at), daily);
    assert.match(text, /^stopped: \$50\.12 of \$50\.00 daily Bedrock budget used; the window resets at 2026-10-29 00:00 local time\./);
    assert.match(text, /\/budget override <minutes>/);
  });

  it('keeps tiny amounts readable', () => {
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatUsd(0.001), '$0.001');
    assert.equal(formatUsd(0.045), '$0.045');
    assert.equal(formatUsd(0.5), '$0.50');
    assert.equal(formatUsd(12.345), '$12.35');
  });
});
