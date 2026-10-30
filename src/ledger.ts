/**
 * Append-only JSONL ledger shared by every dsh home and process. Writers
 * append one line per row with `O_APPEND`; readers fold rows incrementally
 * and dedupe them by key, so no locking is needed.
 * @module dsh-bedrock-metering/ledger
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** Fields every row carries. */
interface RowBase {
  v: 1;
  ts: string;
  home: string;
  profile: string;
  session?: string;
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

/** `/budget override <minutes>`: lifts the stop until `until` for every process. */
export interface OverrideRow extends RowBase {
  kind: 'override';
  until: string;
  minutes: number;
}

/** `/budget reset`: starts a fresh window at `ts` for every process. */
export interface ResetRow extends RowBase {
  kind: 'reset';
}

export type LedgerRow = UsageRow | RefusedRow | OverrideRow | ResetRow;

/**
 * Expand a leading `~` and resolve to an absolute path.
 * @param path - configured ledger path.
 * @returns the absolute path.
 */
export function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
}

/**
 * Stable dedupe key of one row.
 * @param row - a parsed row.
 * @returns `(kind, session, turn, step, attempt)` when an attempt id is present, else a content hash.
 */
export function rowKey(row: LedgerRow): string {
  if ('attempt' in row && row.attempt) {
    const turn = 'turn' in row ? row.turn : undefined;
    const step = 'step' in row ? row.step : undefined;
    return [row.kind, row.session ?? '', turn ?? '', step ?? '', row.attempt].join('|');
  }
  return createHash('sha1').update(JSON.stringify(row)).digest('hex');
}

/** Normalize one parsed line, or reject it. */
function parseRow(line: string): LedgerRow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Partial<LedgerRow> & { kind?: string };
  if (typeof row.ts !== 'string' || Number.isNaN(Date.parse(row.ts))) return undefined;
  if (row.kind === undefined) return { ...row, kind: 'usage' } as UsageRow;
  if (row.kind === 'usage' || row.kind === 'refused' || row.kind === 'override' || row.kind === 'reset') return row as LedgerRow;
  return undefined;
}

/** A row kept in memory with its parsed timestamp. */
export interface HeldRow {
  readonly at: number;
  readonly row: LedgerRow;
}

const READ_CHUNK = 1 << 20;

/** One process's view of the shared ledger file. */
export class Ledger {
  readonly path: string;
  /** Bytes consumed so far; always at a line boundary. */
  private offset = 0;
  /** Rows at or after {@link keepFrom}, in file order. */
  private held: HeldRow[] = [];
  private keys = new Set<string>();
  private keepFrom = Number.NEGATIVE_INFINITY;

  /**
   * @param path - absolute ledger path; the directory is created on first append.
   */
  constructor(path: string) {
    this.path = path;
  }

  /**
   * Append one row as a single `O_APPEND` write, creating the file and its directory if needed.
   * @param row - the row to persist.
   */
  append(row: LedgerRow): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeSync(fd, JSON.stringify(row) + '\n');
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Fold rows other writers (or this process) appended since the last refresh,
   * keeping only rows at or after `keepFrom`.
   * @param keepFrom - epoch ms; earlier rows are dropped from memory.
   * @returns whether anything new was read.
   */
  refresh(keepFrom: number): boolean {
    if (keepFrom > this.keepFrom) {
      this.keepFrom = keepFrom;
      const kept = this.held.filter((held) => held.at >= keepFrom);
      if (kept.length !== this.held.length) {
        this.held = kept;
        this.keys = new Set(kept.map((held) => rowKey(held.row)));
      }
    } else if (keepFrom < this.keepFrom) {
      // An earlier window than the one held: rebuild from the start of the file.
      this.keepFrom = keepFrom;
      this.reset();
    }
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.offset !== 0) this.reset();
        return false;
      }
      throw error;
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) return false;
    return this.readFrom(this.offset);
  }

  /** Rows currently held, in file order. */
  rows(): readonly HeldRow[] {
    return this.held;
  }

  private reset(): void {
    this.offset = 0;
    this.held = [];
    this.keys.clear();
  }

  private readFrom(start: number): boolean {
    const fd = openSync(this.path, 'r');
    let changed = false;
    try {
      const end = fstatSync(fd).size;
      let position = start;
      let carry = Buffer.alloc(0);
      const buffer = Buffer.allocUnsafe(READ_CHUNK);
      while (position < end) {
        const bytes = readSync(fd, buffer, 0, Math.min(READ_CHUNK, end - position), position);
        if (bytes === 0) break;
        position += bytes;
        // Split on the newline byte before decoding so a multi-byte character never straddles chunks.
        const chunk = Buffer.concat([carry, buffer.subarray(0, bytes)]);
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          carry = chunk;
          continue;
        }
        carry = Buffer.from(chunk.subarray(lastNewline + 1));
        for (const line of chunk.toString('utf8', 0, lastNewline).split('\n')) {
          if (line.trim() === '') continue;
          const row = parseRow(line);
          if (row === undefined) continue;
          const at = Date.parse(row.ts);
          if (at < this.keepFrom) continue;
          const key = rowKey(row);
          if (this.keys.has(key)) continue;
          this.keys.add(key);
          this.held.push({ at, row });
          changed = true;
        }
      }
      // A trailing partial line belongs to a write still in flight; re-read it next time.
      this.offset = position - carry.length;
    } finally {
      closeSync(fd);
    }
    return changed;
  }
}
