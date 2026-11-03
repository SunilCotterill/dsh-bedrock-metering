/**
 * Budget windows, thresholds, overrides and the per-process announcement
 * state. Pure: every function takes the clock as an argument.
 * @module dsh-bedrock-metering/budget
 */
import type { HeldRow, LedgerRow, UsageRow } from './ledger.ts';

/**
 * `session` is one conversation: a top-level dsh session together with its
 * subagents' child sessions. `day` and `month` are calendar windows.
 */
export type BudgetWindow = 'day' | 'month' | 'session';

export interface BudgetConfig {
  window: BudgetWindow;
  limitUsd: number;
  /** Fractions of {@link limitUsd} that each announce once per window. */
  warnAt: number[];
  /** Fraction of {@link limitUsd} at which the agent stops. */
  stopAt: number;
}

/**
 * Start of the calendar window holding `now`, in local time.
 * @param window - `day` starts at local midnight, `month` on the 1st.
 * @param now - epoch ms.
 * @returns epoch ms of the window start.
 */
export function calendarStart(window: 'day' | 'month', now: number): number {
  const date = new Date(now);
  return window === 'day'
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    : new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/**
 * End (exclusive) of the calendar window holding `now`, in local time.
 * @param window - `day` or `month`.
 * @param now - epoch ms.
 * @returns epoch ms of the next window start.
 */
export function calendarEnd(window: 'day' | 'month', now: number): number {
  const date = new Date(now);
  return window === 'day'
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
    : new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

/** Adjective used in messages for each window. */
export function windowLabel(window: BudgetWindow): string {
  return window === 'day' ? 'daily' : window === 'month' ? 'monthly' : 'conversation';
}

/**
 * Whether a row counts toward a window. A conversation window counts only the
 * rows of its own conversation (its top-level session and any subagent child
 * sessions stamped with it), overrides and resets included. Calendar windows
 * count every row except overrides and resets made under a conversation
 * window, which belong to that conversation alone.
 * @param row - a ledger row.
 * @param window - window kind.
 * @param conversation - top-level session id scoping a `session` window.
 * @returns whether the row is in scope.
 */
export function inScope(row: LedgerRow, window: BudgetWindow, conversation: string | undefined): boolean {
  if (window === 'session') return conversation !== undefined && (row.conversation ?? row.session) === conversation;
  return !((row.kind === 'override' || row.kind === 'reset') && row.window === 'session');
}

/** Token and spend totals for one provider/model route. */
export interface RouteTotals {
  provider: string;
  model: string;
  calls: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  priced: boolean;
}

/** Everything the gate, guard and `/budget status` need about the current window. */
export interface WindowSummary {
  window: BudgetWindow;
  /** Epoch ms (`-Infinity` for a conversation never reset); a `/budget reset` in the window moves it forward. */
  start: number;
  /** Epoch ms of the next calendar window, absent for `session`. */
  end?: number;
  /** Top-level session id a `session` window was scoped to. */
  conversation?: string;
  spentUsd: number;
  /** Part of {@link spentUsd} spent in subagent child sessions of the conversation. */
  subagentUsd: number;
  /** Subagent child sessions with usage in the conversation. */
  subagentSessions: number;
  /** Latest active override expiry, epoch ms. */
  overrideUntil?: number;
  refused: number;
  routes: RouteTotals[];
  /** Calls on a metered route whose model had no price (counted as $0 or blocked per `unpricedModel`). */
  unpricedCalls: number;
}

/**
 * Fold held ledger rows into the current window's totals.
 * @param rows - rows in file order (held from at least the window start).
 * @param window - window kind.
 * @param now - epoch ms.
 * @param conversation - top-level session id, required to scope a `session` window.
 * @returns the summary.
 */
export function summarize(rows: readonly HeldRow[], window: BudgetWindow, now: number, conversation?: string): WindowSummary {
  const calendar = window === 'session' ? undefined : window;
  let start = calendar === undefined ? Number.NEGATIVE_INFINITY : calendarStart(calendar, now);
  for (const { at, row } of rows) {
    if (row.kind === 'reset' && at >= start && at <= now && inScope(row, window, conversation)) start = at;
  }
  let spentUsd = 0;
  let subagentUsd = 0;
  const subagents = new Set<string>();
  let overrideUntil: number | undefined;
  let refused = 0;
  let unpricedCalls = 0;
  const routes = new Map<string, RouteTotals>();
  for (const { at, row } of rows) {
    if (row.kind === 'override') {
      if (!inScope(row, window, conversation)) continue;
      const until = Date.parse(row.until);
      if (at <= now && until > now && (overrideUntil === undefined || until > overrideUntil)) overrideUntil = until;
      continue;
    }
    if (at < start || at > now || !inScope(row, window, conversation)) continue;
    if (row.kind === 'refused') refused++;
    if (row.kind !== 'usage') continue;
    addRoute(routes, row);
    spentUsd += row.usd;
    if (row.metered && !row.priced) unpricedCalls++;
    if (calendar === undefined && row.session !== undefined && row.session !== conversation) {
      subagentUsd += row.usd;
      subagents.add(row.session);
    }
  }
  return {
    window,
    start,
    ...calendar === undefined ? {} : { end: calendarEnd(calendar, now) },
    ...calendar === undefined && conversation !== undefined ? { conversation } : {},
    spentUsd,
    subagentUsd,
    subagentSessions: subagents.size,
    ...overrideUntil === undefined ? {} : { overrideUntil },
    refused,
    routes: [...routes.values()].sort((a, b) => b.usd - a.usd || b.calls - a.calls),
    unpricedCalls,
  };
}

function addRoute(routes: Map<string, RouteTotals>, row: UsageRow): void {
  const key = `${row.provider}\u0000${row.model}`;
  const totals = routes.get(key) ?? {
    provider: row.provider, model: row.model, calls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0, priced: false,
  };
  totals.calls++;
  totals.in += row.in;
  totals.out += row.out;
  totals.cacheRead += row.cacheRead;
  totals.cacheWrite += row.cacheWrite;
  totals.usd += row.usd;
  totals.priced ||= row.priced;
  routes.set(key, totals);
}

export interface Verdict {
  /** Spend over limit; `Infinity` when the limit is zero and anything was spent. */
  fraction: number;
  /** Highest `warnAt` threshold reached, if any. */
  warnLevel?: number;
  /** Spend reached `stopAt` (regardless of override). */
  overLimit: boolean;
  /** Over the limit and no override is active. */
  stop: boolean;
  overridden: boolean;
}

/**
 * Compare spend against the configured thresholds.
 * @param summary - current window totals.
 * @param config - limit and thresholds.
 * @param now - epoch ms, for override expiry.
 * @returns the verdict.
 */
export function evaluate(summary: WindowSummary, config: BudgetConfig, now: number): Verdict {
  const { spentUsd } = summary;
  const fraction = config.limitUsd > 0 ? spentUsd / config.limitUsd : spentUsd > 0 ? Number.POSITIVE_INFINITY : 0;
  const reached = config.warnAt.filter((threshold) => fraction >= threshold);
  const warnLevel = reached.length === 0 ? undefined : Math.max(...reached);
  const overLimit = fraction >= config.stopAt;
  const overridden = summary.overrideUntil !== undefined && summary.overrideUntil > now;
  return { fraction, ...warnLevel === undefined ? {} : { warnLevel }, overLimit, stop: overLimit && !overridden, overridden };
}

/**
 * Per-process memory of the highest threshold already announced in each
 * window, so each crossing is announced once per window per process.
 */
export class Announcer {
  private readonly announced = new Map<string, number>();

  /**
   * @param summary - current window (its kind, start and conversation form the key).
   * @param verdict - current verdict.
   * @returns the threshold to announce now, or undefined when none is new.
   */
  next(summary: WindowSummary, verdict: Verdict): number | undefined {
    if (verdict.warnLevel === undefined) return undefined;
    const key = `${summary.window}:${summary.start}:${summary.conversation ?? ''}`;
    const previous = this.announced.get(key);
    if (previous !== undefined && previous >= verdict.warnLevel) return undefined;
    this.announced.set(key, verdict.warnLevel);
    return verdict.warnLevel;
  }
}

/**
 * Render a dollar amount: cents from $1, up to four decimals below $1 so
 * small test budgets stay readable.
 * @param value - USD.
 * @returns e.g. `$41.10`, `$0.50`, `$0.0219`, `$0.001`.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return `$${value}`;
  if (value === 0 || Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) < 0.0001) return `$${value.toPrecision(2)}`;
  return `$${value.toFixed(4).replace(/(\.\d\d\d?)0+$/, '$1').replace(/(\.\d\d)0$/, '$1')}`;
}

/** Render a fraction as a whole percentage, e.g. `82%`. */
export function formatPercent(fraction: number): string {
  // The epsilon keeps 0.045 / 0.05 from flooring to 89%.
  return Number.isFinite(fraction) ? `${Math.floor(fraction * 100 + 1e-9)}%` : 'over 100%';
}

/** Local `YYYY-MM-DD HH:MM` for messages. */
export function formatLocal(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** One-line warning, e.g. `82% of $50.00 conversation limit used ($41.10)`. */
export function warningText(summary: WindowSummary, verdict: Verdict, config: BudgetConfig): string {
  return `${formatPercent(verdict.fraction)} of ${formatUsd(config.limitUsd)} ${windowLabel(config.window)} limit used (${formatUsd(summary.spentUsd)})`;
}

/** One-line stop explanation with the ways out. */
export function stopText(summary: WindowSummary, config: BudgetConfig): string {
  const used = `stopped: ${formatUsd(summary.spentUsd)} of ${formatUsd(config.limitUsd)} ${windowLabel(config.window)} Bedrock budget used`;
  if (summary.end === undefined) {
    return `${used}; this conversation stays stopped. ` +
      'Start a new conversation, run /budget override <minutes> in this one in the web UI, or raise budget.limitUsd in the profile patch to continue.';
  }
  return `${used}; the window resets at ${formatLocal(summary.end)} local time. ` +
    'Run /budget override <minutes> in the web UI or raise budget.limitUsd in the profile patch to continue.';
}
