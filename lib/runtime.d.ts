/**
 * One process's metering state: the ledger view, price book, announcement
 * memory and the side effects (records, logger, headless stderr) that the
 * hooks and the `/budget` command share.
 * @module dsh-bedrock-metering/runtime
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { BudgetConfig, Verdict, WindowSummary } from './budget.ts';
import { Ledger } from './ledger.ts';
import { PriceBook } from './pricing.ts';
import type { CacheFallback, PriceOverrides, PriceTable } from './pricing.ts';
/** Validated plugin config (see `Config` in the entry module). */
export interface MeteringConfig {
    ledgerPath: string;
    budget: BudgetConfig;
    meter: {
        providers: string[];
        region: string;
        unpricedModel: 'warn-zero' | 'block';
        cacheFallback: CacheFallback;
        notifyModel: boolean;
    };
    override: {
        allow: boolean;
        maxMinutes: number;
    };
    prices: PriceOverrides;
}
/** Host effects, injected so tests can drive the runtime without a harness. */
export interface RuntimeHost {
    now(): number;
    newId(): string;
    /** Logger warning (Cordis keeps it in an in-memory ring buffer; see README). */
    warn(message: string): void;
    error(message: string, error?: unknown): void;
    /** Direct stderr line, present only in the headless profile. */
    stderr(): ((line: string) => void) | undefined;
    session(id: string): Session | undefined;
    agent(id: string): Agent | undefined;
    /** Dsh home and profile name stamped on every ledger row. */
    home: string;
    profile: string;
}
/** Stable error code thrown by the stream guard. */
export declare const BUDGET_EXCEEDED = "BUDGET_EXCEEDED";
/** Stable error code for a metered model without a price under `unpricedModel: block`. */
export declare const UNPRICED_MODEL = "BUDGET_UNPRICED_MODEL";
export declare class MeteringRuntime {
    readonly config: MeteringConfig;
    readonly host: RuntimeHost;
    readonly ledger: Ledger;
    readonly prices: PriceBook;
    private readonly providers;
    private readonly announcer;
    /** Latest `step/start` position per session, stamped on ledger rows. */
    readonly positions: Map<string, {
        turn: number;
        step: number;
    }>;
    private readonly unpricedWarned;
    constructor(config: MeteringConfig, host: RuntimeHost, table: PriceTable);
    isMetered(provider: string | undefined): boolean;
    /** Whether the agent's next request may go to a metered route (its options or its last logged header). */
    agentIsMetered(agent: Agent): boolean;
    /**
     * Refresh the ledger view and evaluate the current window.
     * @param session - session id, used by the `session` window.
     * @returns the window summary and verdict.
     */
    current(session?: string): {
        summary: WindowSummary;
        verdict: Verdict;
    };
    /**
     * Append one usage row for a finished (or failed) model call, then announce any newly crossed threshold.
     * @param options - the request.
     * @param usage - the last `usage` chunk the call reported.
     * @param outcome - terminal finish kind, or how the stream ended without one.
     * @param attempt - id minted for this call.
     */
    recordUsage(options: GenerateOptions, usage: TokenUsage, outcome: string, attempt: string): void;
    /**
     * Refuse a metered model call when the budget is spent (D5 guard), or when
     * its model is unpriced under `unpricedModel: block`.
     * @param options - the request about to be dispatched.
     * @param attempt - id minted for this call.
     * @throws LlmError with {@link BUDGET_EXCEEDED} or {@link UNPRICED_MODEL}.
     */
    guard(options: GenerateOptions, attempt: string): void;
    /**
     * Decide one proposed step (D5 primary stop).
     * @param agent - the agent proposing the step.
     * @param turn - the step's turn.
     * @param step - the proposed step.
     * @returns true when the step must be rejected.
     */
    gate(agent: Agent, turn: number, step: number): boolean;
    /** Announce a newly crossed warning threshold once per window in this process. */
    announce(agent: Agent | undefined, sessionId: string | undefined, summary: WindowSummary, verdict: Verdict): void;
    /**
     * `/budget override <minutes>`: lift the stop for every process sharing the ledger.
     * @returns the command reply.
     */
    override(agent: Agent, minutes: number): string;
    /**
     * `/budget reset`: start a fresh window now (for mistakes only).
     * @returns the command reply.
     */
    reset(agent: Agent): string;
    /** Row fields shared by every kind. */
    private base;
    private append;
    private refuse;
    private stopped;
    private record;
    private notify;
    private warnUnpriced;
}
