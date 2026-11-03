/**
 * Start of the calendar window holding `now`, in local time.
 * @param window - `day` starts at local midnight, `month` on the 1st.
 * @param now - epoch ms.
 * @returns epoch ms of the window start.
 */
export function calendarStart(window, now) {
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
export function calendarEnd(window, now) {
    const date = new Date(now);
    return window === 'day'
        ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
        : new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}
/** Adjective used in messages for each window. */
export function windowLabel(window) {
    return window === 'day' ? 'daily' : window === 'month' ? 'monthly' : 'conversation';
}
/**
 * Whether a row counts toward a window. A conversation window counts only its
 * own session's rows, overrides and resets included. Calendar windows count
 * every row except overrides and resets made under a conversation window,
 * which belong to that conversation alone.
 * @param row - a ledger row.
 * @param window - window kind.
 * @param session - session id scoping a `session` window.
 * @returns whether the row is in scope.
 */
export function inScope(row, window, session) {
    if (window === 'session')
        return session !== undefined && row.session === session;
    return !((row.kind === 'override' || row.kind === 'reset') && row.window === 'session');
}
/**
 * Fold held ledger rows into the current window's totals.
 * @param rows - rows in file order (held from at least the window start).
 * @param window - window kind.
 * @param now - epoch ms.
 * @param session - session id, required to scope a `session` window.
 * @returns the summary.
 */
export function summarize(rows, window, now, session) {
    const calendar = window === 'session' ? undefined : window;
    let start = calendar === undefined ? Number.NEGATIVE_INFINITY : calendarStart(calendar, now);
    for (const { at, row } of rows) {
        if (row.kind === 'reset' && at >= start && at <= now && inScope(row, window, session))
            start = at;
    }
    let spentUsd = 0;
    let overrideUntil;
    let refused = 0;
    let unpricedCalls = 0;
    const routes = new Map();
    for (const { at, row } of rows) {
        if (row.kind === 'override') {
            if (!inScope(row, window, session))
                continue;
            const until = Date.parse(row.until);
            if (at <= now && until > now && (overrideUntil === undefined || until > overrideUntil))
                overrideUntil = until;
            continue;
        }
        if (at < start || at > now || !inScope(row, window, session))
            continue;
        if (row.kind === 'refused')
            refused++;
        if (row.kind !== 'usage')
            continue;
        addRoute(routes, row);
        spentUsd += row.usd;
        if (row.metered && !row.priced)
            unpricedCalls++;
    }
    return {
        window,
        start,
        ...calendar === undefined ? {} : { end: calendarEnd(calendar, now) },
        spentUsd,
        ...overrideUntil === undefined ? {} : { overrideUntil },
        refused,
        routes: [...routes.values()].sort((a, b) => b.usd - a.usd || b.calls - a.calls),
        unpricedCalls,
    };
}
function addRoute(routes, row) {
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
/**
 * Compare spend against the configured thresholds.
 * @param summary - current window totals.
 * @param config - limit and thresholds.
 * @param now - epoch ms, for override expiry.
 * @returns the verdict.
 */
export function evaluate(summary, config, now) {
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
    announced = new Map();
    /**
     * @param summary - current window (its kind and start form the key).
     * @param verdict - current verdict.
     * @param session - session id, part of the key for `session` windows.
     * @returns the threshold to announce now, or undefined when none is new.
     */
    next(summary, verdict, session) {
        if (verdict.warnLevel === undefined)
            return undefined;
        const key = `${summary.window}:${summary.start}:${summary.window === 'session' ? session ?? '' : ''}`;
        const previous = this.announced.get(key);
        if (previous !== undefined && previous >= verdict.warnLevel)
            return undefined;
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
export function formatUsd(value) {
    if (!Number.isFinite(value))
        return `$${value}`;
    if (value === 0 || Math.abs(value) >= 1)
        return `$${value.toFixed(2)}`;
    if (Math.abs(value) < 0.0001)
        return `$${value.toPrecision(2)}`;
    return `$${value.toFixed(4).replace(/(\.\d\d\d?)0+$/, '$1').replace(/(\.\d\d)0$/, '$1')}`;
}
/** Render a fraction as a whole percentage, e.g. `82%`. */
export function formatPercent(fraction) {
    // The epsilon keeps 0.045 / 0.05 from flooring to 89%.
    return Number.isFinite(fraction) ? `${Math.floor(fraction * 100 + 1e-9)}%` : 'over 100%';
}
/** Local `YYYY-MM-DD HH:MM` for messages. */
export function formatLocal(at) {
    const date = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** One-line warning, e.g. `82% of $50.00 conversation limit used ($41.10)`. */
export function warningText(summary, verdict, config) {
    return `${formatPercent(verdict.fraction)} of ${formatUsd(config.limitUsd)} ${windowLabel(config.window)} limit used (${formatUsd(summary.spentUsd)})`;
}
/** One-line stop explanation with the ways out. */
export function stopText(summary, config) {
    const used = `stopped: ${formatUsd(summary.spentUsd)} of ${formatUsd(config.limitUsd)} ${windowLabel(config.window)} Bedrock budget used`;
    if (summary.end === undefined) {
        return `${used}; this conversation stays stopped. ` +
            'Start a new conversation, run /budget override <minutes> in this one in the web UI, or raise budget.limitUsd in the profile patch to continue.';
    }
    return `${used}; the window resets at ${formatLocal(summary.end)} local time. ` +
        'Run /budget override <minutes> in the web UI or raise budget.limitUsd in the profile patch to continue.';
}
