/**
 * Web surface: a status route behind the browser-trust fence, read by the
 * composer budget pill in `client/budget-pill.js`. The route returns display
 * text as well as numbers, so the browser bundle stays a thin renderer.
 * @module dsh-bedrock-metering/web
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { BudgetConfig, BudgetWindow, Verdict, WindowSummary } from './budget.ts';
import type { MeteringRuntime } from './runtime.ts';
/** Absolute path of the status route; the client fetches it relative to the app base. */
export declare const STATUS_PATH = "/bedrock-metering/status";
/** Pill colour band: neutral, amber, red, or amber while an override lifts a stop. */
export type StatusLevel = 'ok' | 'warn' | 'critical' | 'stopped' | 'overridden';
/** JSON body of {@link STATUS_PATH}. */
export interface BudgetStatus {
    v: 1;
    level: StatusLevel;
    /** Spend over limit, clamped to [0, 1] for the bar. */
    bar: number;
    /** Short pill text, e.g. `Bedrock 24%`. */
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
export declare function statusLevel(verdict: Verdict, config: BudgetConfig): StatusLevel;
/**
 * Build the status body from the current window.
 * @param summary - window totals.
 * @param verdict - thresholds verdict.
 * @param config - budget config.
 * @returns the JSON body.
 */
export declare function budgetStatus(summary: WindowSummary, verdict: Verdict, config: BudgetConfig): BudgetStatus;
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
export declare function handleStatus(runtime: MeteringRuntime, connection: ConnectionLike, req: IncomingMessage, res: ServerResponse): void;
/**
 * Mount the status route while the web server and its trust fence exist
 * (the web profile); headless has neither, so nothing is mounted there.
 * @param ctx - plugin context.
 * @param runtime - shared metering state.
 */
export declare function installStatusRoute(ctx: Context, runtime: MeteringRuntime): void;
export {};
