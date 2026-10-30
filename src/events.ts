/**
 * Durable budget records on agent sessions.
 *
 * These are plugin records (`plugin:dsh-bedrock-metering/*`), not new
 * `SessionEventMap` members: the session reader refuses to load a log holding
 * an unknown event type unless it is marked `ignorable`, and
 * `appendPluginRecord` is the API that writes such marked records. A reader
 * without this plugin skips them; none enters the model-visible surface.
 * @module dsh-bedrock-metering/events
 */
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { BudgetWindow } from './budget.ts';

/** A warning threshold was crossed for the first time in this window (per process). */
export interface BudgetWarningRecord {
  window: BudgetWindow;
  windowStart: string;
  limitUsd: number;
  spentUsd: number;
  threshold: number;
  fraction: number;
}

/** A step was rejected or a model call refused because the budget is spent. */
export interface BudgetStopRecord {
  window: BudgetWindow;
  windowStart: string;
  limitUsd: number;
  spentUsd: number;
  via: 'pre-step' | 'stream-guard';
  turn?: number;
  step?: number;
  provider?: string;
  model?: string;
  purpose?: string;
}

/** `/budget override <minutes>` was run from this session. */
export interface BudgetOverrideRecord {
  minutes: number;
  until: string;
  limitUsd: number;
  spentUsd: number;
}

/** `/budget reset` was run from this session. */
export interface BudgetResetRecord {
  window: BudgetWindow;
  previousStart: string;
  spentUsd: number;
}

export interface BudgetRecords {
  warning: BudgetWarningRecord;
  stop: BudgetStopRecord;
  override: BudgetOverrideRecord;
  reset: BudgetResetRecord;
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-bedrock-metering/warning': BudgetWarningRecord;
    'plugin:dsh-bedrock-metering/stop': BudgetStopRecord;
    'plugin:dsh-bedrock-metering/override': BudgetOverrideRecord;
    'plugin:dsh-bedrock-metering/reset': BudgetResetRecord;
  }
}

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    /** Model-visible budget notice injected when `meter.notifyModel` is on. */
    'bedrock-metering': { kind: 'bedrock-metering' } & ContextFormed;
  }
}

/**
 * Append one budget record to a session log.
 * @param session - the live session that receives it.
 * @param kind - record kind.
 * @param data - JSON payload.
 * @returns the error when the append was refused (a closed or reentered session), else undefined.
 */
export function appendBudgetRecord<K extends keyof BudgetRecords>(session: Session, kind: K, data: BudgetRecords[K]): unknown {
  try {
    appendPluginRecord(session, `plugin:dsh-bedrock-metering/${kind}`, data as never);
    return undefined;
  } catch (error) {
    return error;
  }
}
