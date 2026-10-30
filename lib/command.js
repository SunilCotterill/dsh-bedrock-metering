import { formatLocal, formatPercent, formatUsd, windowLabel } from './budget.js';
export const USAGE = 'usage: /budget [status] | /budget override <minutes> | /budget reset';
/**
 * Handle one `/budget` invocation.
 * @param runtime - shared metering state.
 * @param invocation - the receiving agent and the text after `/budget`.
 * @returns the command result shown in the UI.
 */
export function handleBudgetCommand(runtime, invocation) {
    const [verb = 'status', ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
    switch (verb.toLowerCase()) {
        case 'status':
            return rest.length === 0 ? { kind: 'success', text: statusText(runtime, invocation.agent.session.id) } : { kind: 'error', text: USAGE };
        case 'override': {
            const { allow, maxMinutes } = runtime.config.override;
            if (!allow)
                return { kind: 'error', text: 'Budget overrides are disabled (override.allow is false in the profile patch).' };
            const minutes = rest.length === 1 && /^\d+$/.test(rest[0] ?? '') ? Number(rest[0]) : Number.NaN;
            if (!(minutes >= 1 && minutes <= maxMinutes))
                return { kind: 'error', text: `usage: /budget override <minutes>, with 1 to ${maxMinutes} minutes` };
            return { kind: 'success', text: runtime.override(invocation.agent, minutes) };
        }
        case 'reset':
            return rest.length === 0 ? { kind: 'success', text: runtime.reset(invocation.agent) } : { kind: 'error', text: USAGE };
        default:
            return { kind: 'error', text: USAGE };
    }
}
/**
 * Render the current window for `/budget status`.
 * @param runtime - shared metering state.
 * @param session - the asking session (scopes a `session` window).
 * @returns multi-line status text.
 */
export function statusText(runtime, session) {
    const { config } = runtime;
    const { summary, verdict } = runtime.current(session);
    const { budget } = config;
    const since = Number.isFinite(summary.start) ? `since ${formatLocal(summary.start)}` : 'for this session';
    const resets = summary.end === undefined ? '' : `, resets ${formatLocal(summary.end)}`;
    const lines = [
        `Bedrock budget: ${windowLabel(budget.window)} window ${since}${resets} (local time)`,
        `Spent ${formatUsd(summary.spentUsd)} of ${formatUsd(budget.limitUsd)} (${formatPercent(verdict.fraction)}); ` +
            `warn at ${budget.warnAt.map(formatPercent).join(', ') || 'never'}; stop at ${formatPercent(budget.stopAt)}.`,
    ];
    if (summary.overrideUntil !== undefined)
        lines.push(`Override active until ${formatLocal(summary.overrideUntil)}.`);
    if (verdict.stop)
        lines.push('STOPPED: metered model calls are refused. Use /budget override <minutes> to continue.');
    const metered = summary.routes.filter((route) => runtime.isMetered(route.provider));
    const others = summary.routes.filter((route) => !runtime.isMetered(route.provider));
    lines.push(metered.length === 0 ? 'Metered routes: no calls in this window.' : 'Metered routes:');
    for (const route of metered)
        lines.push(`  ${routeLine(route)}  ${route.priced ? formatUsd(route.usd) : 'unpriced ($0)'}`);
    if (others.length > 0) {
        lines.push('Other routes (tokens only, not counted):');
        for (const route of others)
            lines.push(`  ${routeLine(route)}`);
    }
    if (summary.refused > 0)
        lines.push(`Refused calls this window: ${summary.refused}.`);
    if (summary.unpricedCalls > 0)
        lines.push(`Unpriced metered calls this window: ${summary.unpricedCalls} (counted as $0).`);
    const { table } = runtime.prices;
    const unverified = table.rows.filter((row) => !row.verified).length;
    lines.push(`Prices: bundled Bedrock table retrieved ${table.retrievedAt}` +
        (unverified > 0 ? `, ${unverified} of ${table.rows.length} rows unverified against an AWS bill` : '') +
        `; config overrides for ${Object.keys(config.prices).length} provider(s).`, `Ledger: ${runtime.ledger.path}`);
    return lines.join('\n');
}
function routeLine(route) {
    const cache = route.cacheRead + route.cacheWrite > 0 ? `, cache read ${tokens(route.cacheRead)}, cache write ${tokens(route.cacheWrite)}` : '';
    return `${route.provider}/${route.model}: ${route.calls} call${route.calls === 1 ? '' : 's'}, in ${tokens(route.in)}, out ${tokens(route.out)}${cache}`;
}
function tokens(count) {
    if (count >= 1_000_000)
        return `${(count / 1_000_000).toFixed(2)}M`;
    if (count >= 10_000)
        return `${Math.round(count / 1000)}k`;
    return String(count);
}
