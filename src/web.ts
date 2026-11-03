/**
 * Web surface: a status route behind the browser-trust fence, read by the
 * composer budget pill in `client/budget-pill.js`. The route returns display
 * text as well as numbers, so the browser bundle stays a thin renderer.
 * @module dsh-bedrock-metering/web
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { formatLocal, formatPercent, formatUsd, windowLabel } from './budget.ts';
import type { BudgetConfig, BudgetWindow, Verdict, WindowSummary } from './budget.ts';
import type { MeteringRuntime } from './runtime.ts';

/** Absolute path of the status route; the client fetches it relative to the app base. */
export const STATUS_PATH = '/bedrock-metering/status';

/** Pill colour band: neutral, amber, red, or amber while an override lifts a stop. */
export type StatusLevel = 'ok' | 'warn' | 'critical' | 'stopped' | 'overridden';

/** JSON body of {@link STATUS_PATH}. */
export interface BudgetStatus {
  v: 1;
  level: StatusLevel;
  /** Spend over limit, clamped to [0, 1] for the bar. */
  bar: number;
  /** Short pill text: dollars spent in the window, e.g. `$1.23`, or `$50.12 · stopped`. */
  label: string;
  /** Multi-line hover text. */
  tooltip: string;
  window: BudgetWindow;
  spentUsd: number;
  limitUsd: number;
  resetsAt?: string;
  overrideUntil?: string;
}

/**
 * Colour band for a verdict: amber from the first warning threshold, red from
 * the last one (when there are several) or once over the limit.
 * @param verdict - current verdict.
 * @param config - thresholds.
 * @returns the band.
 */
export function statusLevel(verdict: Verdict, config: BudgetConfig): StatusLevel {
  if (verdict.stop) return 'stopped';
  if (verdict.overLimit && verdict.overridden) return 'overridden';
  const thresholds = [...config.warnAt].sort((a, b) => a - b);
  const last = thresholds.at(-1);
  if (verdict.overLimit || (thresholds.length > 1 && last !== undefined && verdict.fraction >= last)) return 'critical';
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
export function budgetStatus(summary: WindowSummary, verdict: Verdict, config: BudgetConfig): BudgetStatus {
  const level = statusLevel(verdict, config);
  const percent = formatPercent(verdict.fraction);
  const spent = formatUsd(summary.spentUsd);
  const conversation = config.window === 'session';
  const label = level === 'stopped' ? `${spent} · stopped` : spent;
  const lines = [conversation
    ? `${spent} of ${formatUsd(config.limitUsd)} Bedrock budget for this conversation (${percent})`
    : `${spent} of ${formatUsd(config.limitUsd)} ${windowLabel(config.window)} Bedrock budget (${percent})`];
  if (summary.end !== undefined) lines.push(`Resets ${formatLocal(summary.end)}`);
  if (summary.subagentSessions > 0) {
    lines.push(`Includes ${formatUsd(summary.subagentUsd)} from ${summary.subagentSessions} subagent${summary.subagentSessions === 1 ? '' : 's'}`);
  }
  if (conversation && Number.isFinite(summary.start)) lines.push(`Counted since the /budget reset at ${formatLocal(summary.start)}`);
  if (config.warnAt.length > 0) lines.push(`Warns at ${config.warnAt.map(formatPercent).join(', ')}; stops at ${formatPercent(config.stopAt)}`);
  if (summary.overrideUntil !== undefined) lines.push(`Override active until ${formatLocal(summary.overrideUntil)}`);
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

/** The web composition's route carrier, typed locally (its package is not a dependency). */
interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void;
}

/** The web composition's browser-trust fence, typed locally. */
interface ConnectionLike {
  requestRejection(request: IncomingMessage): number | undefined;
}

/**
 * Answer one status request.
 * @param runtime - shared metering state.
 * @param connection - trust fence; an untrusted or unauthenticated request gets its status code and no body.
 * @param req - the request.
 * @param res - the response.
 */
export function handleStatus(runtime: MeteringRuntime, connection: ConnectionLike, req: IncomingMessage, res: ServerResponse): void {
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
export function installStatusRoute(ctx: Context, runtime: MeteringRuntime): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer') as WebServerLike;
    const connection = webCtx.get('connection') as ConnectionLike;
    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => handleStatus(runtime, connection, req, res),
    }), 'bedrock-metering: status route');
  });
}
