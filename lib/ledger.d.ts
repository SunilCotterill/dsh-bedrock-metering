import type { BudgetWindow } from './budget.ts';
/** Fields every row carries. */
interface RowBase {
    v: 1;
    ts: string;
    home: string;
    profile: string;
    session?: string;
    /** Top-level conversation, when {@link session} is a subagent's child session; absent otherwise. */
    conversation?: string;
}
/** One metered model call. Rows without `kind` (hand-written or older) are read as usage. */
export interface UsageRow extends RowBase {
    kind: 'usage';
    turn?: number;
    step?: number;
    attempt: string;
    purpose?: string;
    provider: string;
    model: string;
    in: number;
    out: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    usd: number;
    /** Whether the route is listed in `meter.providers` and so counts toward the budget. */
    metered?: boolean;
    /** Whether the route is metered and a price was found. */
    priced: boolean;
    /** Bundled row key or `config`, when priced. */
    price?: string;
    /** Terminal finish kind, or `thrown` when the stream failed without one. */
    outcome?: string;
}
/** A model call the stream guard refused. */
export interface RefusedRow extends RowBase {
    kind: 'refused';
    attempt: string;
    purpose?: string;
    provider: string;
    model: string;
}
/**
 * `/budget override <minutes>`: lifts the stop until `until` for every process.
 * Made under a conversation window (`window: 'session'`), it applies to its own session only.
 */
export interface OverrideRow extends RowBase {
    kind: 'override';
    until: string;
    minutes: number;
    /** Window the override was made under; absent on rows from 0.1.x, which apply to every window. */
    window?: BudgetWindow;
}
/**
 * `/budget reset`: starts a fresh window at `ts` for every process.
 * Made under a conversation window (`window: 'session'`), it restarts its own session's count only.
 */
export interface ResetRow extends RowBase {
    kind: 'reset';
    /** Window the reset was made under; absent on rows from 0.1.x. */
    window?: BudgetWindow;
}
export type LedgerRow = UsageRow | RefusedRow | OverrideRow | ResetRow;
/**
 * Expand a leading `~` and resolve to an absolute path.
 * @param path - configured ledger path.
 * @returns the absolute path.
 */
export declare function expandHome(path: string): string;
/**
 * Stable dedupe key of one row.
 * @param row - a parsed row.
 * @returns `(kind, session, turn, step, attempt)` when an attempt id is present, else a content hash.
 */
export declare function rowKey(row: LedgerRow): string;
/** A row kept in memory with its parsed timestamp. */
export interface HeldRow {
    readonly at: number;
    readonly row: LedgerRow;
}
/** One process's view of the shared ledger file. */
export declare class Ledger {
    readonly path: string;
    /** Bytes consumed so far; always at a line boundary. */
    private offset;
    /** Rows at or after {@link keepFrom}, in file order. */
    private held;
    private keys;
    private keepFrom;
    /**
     * @param path - absolute ledger path; the directory is created on first append.
     */
    constructor(path: string);
    /**
     * Append one row as a single `O_APPEND` write, creating the file and its directory if needed.
     * @param row - the row to persist.
     */
    append(row: LedgerRow): void;
    /**
     * Fold rows other writers (or this process) appended since the last refresh,
     * keeping only rows at or after `keepFrom`.
     * @param keepFrom - epoch ms; earlier rows are dropped from memory.
     * @returns whether anything new was read.
     */
    refresh(keepFrom: number): boolean;
    /** Rows currently held, in file order. */
    rows(): readonly HeldRow[];
    private reset;
    private readFrom;
}
export {};
