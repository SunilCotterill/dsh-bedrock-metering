/**
 * Budget windows, thresholds, overrides and the per-process announcement
 * state. Pure: every function takes the clock as an argument.
 * @module dsh-bedrock-metering/budget
 */
import type { HeldRow, LedgerRow } from './ledger.ts';
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
export declare function calendarStart(window: 'day' | 'month', now: number): number;
/**
 * End (exclusive) of the calendar window holding `now`, in local time.
 * @param window - `day` or `month`.
 * @param now - epoch ms.
 * @returns epoch ms of the next window start.
 */
export declare function calendarEnd(window: 'day' | 'month', now: number): number;
/** Adjective used in messages for each window. */
export declare function windowLabel(window: BudgetWindow): string;
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
export declare function inScope(row: LedgerRow, window: BudgetWindow, conversation: string | undefined): boolean;
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
export declare function summarize(rows: readonly HeldRow[], window: BudgetWindow, now: number, conversation?: string): WindowSummary;
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
export declare function evaluate(summary: WindowSummary, config: BudgetConfig, now: number): Verdict;
/**
 * Per-process memory of the highest threshold already announced in each
 * window, so each crossing is announced once per window per process.
 */
export declare class Announcer {
    private readonly announced;
    /**
     * @param summary - current window (its kind, start and conversation form the key).
     * @param verdict - current verdict.
     * @returns the threshold to announce now, or undefined when none is new.
     */
    next(summary: WindowSummary, verdict: Verdict): number | undefined;
}
/**
 * Render a dollar amount: cents from $1, up to four decimals below $1 so
 * small test budgets stay readable.
 * @param value - USD.
 * @returns e.g. `$41.10`, `$0.50`, `$0.0219`, `$0.001`.
 */
export declare function formatUsd(value: number): string;
/** Render a fraction as a whole percentage, e.g. `82%`. */
export declare function formatPercent(fraction: number): string;
/** Local `YYYY-MM-DD HH:MM` for messages. */
export declare function formatLocal(at: number): string;
/** One-line warning, e.g. `82% of $50.00 conversation limit used ($41.10)`. */
export declare function warningText(summary: WindowSummary, verdict: Verdict, config: BudgetConfig): string;
/** One-line stop explanation with the ways out. */
export declare function stopText(summary: WindowSummary, config: BudgetConfig): string;
