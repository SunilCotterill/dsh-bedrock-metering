import { formatLocal, formatPercent, formatUsd, windowLabel } from './budget.js';
/** Absolute path of the status route; the client fetches it relative to the app base. */
export const STATUS_PATH = '/bedrock-metering/status';
/**
 * Colour band for a verdict: amber from the first warning threshold, red from
 * the last one (when there are several) or once over the limit.
 * @param verdict - current verdict.
 * @param config - thresholds.
 * @returns the band.
 */
export function statusLevel(verdict, config) {
    if (verdict.stop)
        return 'stopped';
    if (verdict.overLimit && verdict.overridden)
        return 'overridden';
    const thresholds = [...config.warnAt].sort((a, b) => a - b);
    const last = thresholds.at(-1);
    if (verdict.overLimit || (thresholds.length > 1 && last !== undefined && verdict.fraction >= last))
        return 'critical';
    const first = thresholds[0];
    return first !== undefined && verdict.fraction >= first ? 'warn' : 'ok';
}
/**
 * Build the status body from the current window.
 * @param summary - window totals.
 * @param verdict - thresholds verdict.
 * @param config - budget config.
 * @returns the JSON body.
 */
export function budgetStatus(summary, verdict, config) {
    const level = statusLevel(verdict, config);
    const percent = formatPercent(verdict.fraction);
    const spent = formatUsd(summary.spentUsd);
    const conversation = config.window === 'session';
    const label = level === 'stopped' ? `${spent} · stopped` : spent;
    const lines = [conversation
            ? `${spent} of ${formatUsd(config.limitUsd)} Bedrock budget for this conversation (${percent})`
            : `${spent} of ${formatUsd(config.limitUsd)} ${windowLabel(config.window)} Bedrock budget (${percent})`];
    if (summary.end !== undefined)
        lines.push(`Resets ${formatLocal(summary.end)}`);
    if (summary.subagentSessions > 0) {
        lines.push(`Includes ${formatUsd(summary.subagentUsd)} from ${summary.subagentSessions} subagent${summary.subagentSessions === 1 ? '' : 's'}`);
    }
    if (conversation && Number.isFinite(summary.start))
        lines.push(`Counted since the /budget reset at ${formatLocal(summary.start)}`);
    if (config.warnAt.length > 0)
        lines.push(`Warns at ${config.warnAt.map(formatPercent).join(', ')}; stops at ${formatPercent(config.stopAt)}`);
    if (summary.overrideUntil !== undefined)
        lines.push(`Override active until ${formatLocal(summary.overrideUntil)}`);
    if (level === 'stopped') {
        lines.push(conversation
            ? 'Model calls in this conversation are refused. Start a new conversation or run /budget override <minutes> to continue.'
            : 'Model calls are refused. Run /budget override <minutes> to continue.');
    }
    return {
        v: 1,
        level,
        bar: Number.isFinite(verdict.fraction) ? Math.round(Math.min(1, Math.max(0, verdict.fraction)) * 1e4) / 1e4 : 1,
        label,
        tooltip: lines.join('\n'),
        window: config.window,
        spentUsd: Math.round(summary.spentUsd * 1e6) / 1e6,
        limitUsd: config.limitUsd,
        ...summary.end === undefined ? {} : { resetsAt: new Date(summary.end).toISOString() },
        ...summary.overrideUntil === undefined ? {} : { overrideUntil: new Date(summary.overrideUntil).toISOString() },
    };
}
/**
 * Answer one status request.
 * @param runtime - shared metering state.
 * @param connection - trust fence; an untrusted or unauthenticated request gets its status code and no body.
 * @param req - the request.
 * @param res - the response.
 */
export function handleStatus(runtime, connection, req, res) {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
    }
    if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
    }
    const session = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session') ?? undefined;
    const { summary, verdict } = runtime.current(session);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(budgetStatus(summary, verdict, runtime.config.budget)));
}
/**
 * Mount the status route while the web server and its trust fence exist
 * (the web profile); headless has neither, so nothing is mounted there.
 * @param ctx - plugin context.
 * @param runtime - shared metering state.
 */
export function installStatusRoute(ctx, runtime) {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
        const webServer = webCtx.get('webServer');
        const connection = webCtx.get('connection');
        webCtx.effect(() => webServer.register({
            kind: 'exact',
            path: STATUS_PATH,
            handler: (req, res) => handleStatus(runtime, connection, req, res),
        }), 'bedrock-metering: status route');
    });
}
