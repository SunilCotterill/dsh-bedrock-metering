/**
 * The `/budget` chat command: status, time-boxed override, and window reset.
 * @module dsh-bedrock-metering/command
 */
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import type { BudgetWindow } from './budget.ts';
import type { MeteringRuntime } from './runtime.ts';
export declare const USAGE = "usage: /budget [status] | /budget override <minutes> | /budget reset";
/**
 * Command-menu description for the configured window.
 * @param window - budget window.
 * @returns one line shown beside `/budget`.
 */
export declare function commandDescription(window: BudgetWindow): string;
/**
 * Handle one `/budget` invocation.
 * @param runtime - shared metering state.
 * @param invocation - the receiving agent and the text after `/budget`.
 * @returns the command result shown in the UI.
 */
export declare function handleBudgetCommand(runtime: MeteringRuntime, invocation: Pick<CommandInvocation, 'agent' | 'rawInput'>): CommandResult;
/**
 * Render the current window for `/budget status`.
 * @param runtime - shared metering state.
 * @param session - the asking session (scopes a `session` window).
 * @returns multi-line status text.
 */
export declare function statusText(runtime: MeteringRuntime, session: string): string;
