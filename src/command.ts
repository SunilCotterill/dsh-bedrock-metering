/**
 * The `/budget` chat command: status, time-boxed override, and window reset.
 * @module dsh-bedrock-metering/command
 */
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import { formatLocal, formatPercent, formatUsd, windowLabel } from './budget.ts';
import type { BudgetWindow, RouteTotals } from './budget.ts';
import type { MeteringRuntime } from './runtime.ts';

export const USAGE = 'usage: /budget [status] | /budget override <minutes> | /budget reset';

/**
 * Command-menu description for the configured window.
 * @param window - budget window.
 * @returns one line shown beside `/budget`.
 */
export function commandDescription(window: BudgetWindow): string {
  return window === 'session'
    ? 'Bedrock spend in this conversation against its budget; override a stop or restart the count'
    : `Bedrock spend against the ${windowLabel(window)} budget; override a stop or reset the window`;
}

/**
 * Handle one `/budget` invocation.
 * @param runtime - shared metering state.
 * @param invocation - the receiving agent and the text after `/budget`.
 * @returns the command result shown in the UI.
 */
export function handleBudgetCommand(runtime: MeteringRuntime, invocation: Pick<CommandInvocation, 'agent' | 'rawInput'>): CommandResult {
  const [verb = 'status', ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
  switch (verb.toLowerCase()) {
    case 'status':
      return rest.length === 0 ? { kind: 'success', text: statusText(runtime, invocation.agent.session.id) } : { kind: 'error', text: USAGE };
    case 'override': {
      const { allow, maxMinutes } = runtime.config.override;
      if (!allow) return { kind: 'error', text: 'Budget overrides are disabled (override.allow is false in the profile patch).' };
      const minutes = rest.length === 1 && /^\d+$/.test(rest[0] ?? '') ? Number(rest[0]) : Number.NaN;
      if (!(minutes >= 1 && minutes <= maxMinutes)) return { kind: 'error', text: `usage: /budget override <minutes>, with 1 to ${maxMinutes} minutes` };
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
export function statusText(runtime: MeteringRuntime, session: string): string {
  const { config } = runtime;
  const { summary, verdict } = runtime.current(session);
  const { budget } = config;
  const conversation = budget.window === 'session';
  const scope = conversation ? 'this conversation' : 'this window';
  const lines = [conversation
    ? `Bedrock budget for this conversation, counted ${Number.isFinite(summary.start) ? `since the /budget reset at ${formatLocal(summary.start)} local time` : 'since it started'}`
    : `Bedrock budget: ${windowLabel(budget.window)} window since ${formatLocal(summary.start)}` +
      `${summary.end === undefined ? '' : `, resets ${formatLocal(summary.end)}`} (local time)`];
  lines.push(
    `Spent ${formatUsd(summary.spentUsd)} of ${formatUsd(budget.limitUsd)} (${formatPercent(verdict.fraction)}); ` +
      `warn at ${budget.warnAt.map(formatPercent).join(', ') || 'never'}; stop at ${formatPercent(budget.stopAt)}.`,
  );
  if (summary.subagentSessions > 0) {
    lines.push(`Includes ${formatUsd(summary.subagentUsd)} spent by ${summary.subagentSessions} subagent session${summary.subagentSessions === 1 ? '' : 's'} of this conversation.`);
  }
  if (summary.overrideUntil !== undefined) lines.push(`Override active until ${formatLocal(summary.overrideUntil)}.`);
  if (verdict.stop) {
    lines.push(conversation
      ? 'STOPPED: metered model calls in this conversation are refused. Start a new conversation or use /budget override <minutes> to continue.'
      : 'STOPPED: metered model calls are refused. Use /budget override <minutes> to continue.');
  }
  const metered = summary.routes.filter((route) => runtime.isMetered(route.provider));
  const others = summary.routes.filter((route) => !runtime.isMetered(route.provider));
  if (metered.length === 0) lines.push(`Metered routes: no calls in ${scope}.`);
  else lines.push(`Metered calls: ${totalsLine(metered)}`, 'Metered routes:');
  for (const route of metered) lines.push(`  ${routeLine(route)}  ${route.priced ? formatUsd(route.usd) : 'unpriced ($0)'}`);
  if (others.length > 0) {
    lines.push('Other routes (tokens only, not counted):');
    for (const route of others) lines.push(`  ${routeLine(route)}`);
  }
  if (summary.refused > 0) lines.push(`Refused calls in ${scope}: ${summary.refused}.`);
  if (summary.unpricedCalls > 0) lines.push(`Unpriced metered calls in ${scope}: ${summary.unpricedCalls} (counted as $0).`);
  const { table } = runtime.prices;
  const unverified = table.rows.filter((row) => !row.verified).length;
  lines.push(
    `Prices: bundled Bedrock table retrieved ${table.retrievedAt}` +
      (unverified > 0 ? `, ${unverified} of ${table.rows.length} rows unverified against an AWS bill` : '') +
      `; config overrides for ${Object.keys(config.prices).length} provider(s).`,
    `Ledger: ${runtime.ledger.path}`,
  );
  return lines.join('\n');
}

function totalsLine(routes: readonly RouteTotals[]): string {
  const sum = (pick: (route: RouteTotals) => number) => routes.reduce((total, route) => total + pick(route), 0);
  const calls = sum((route) => route.calls);
  const cacheRead = sum((route) => route.cacheRead);
  const cacheWrite = sum((route) => route.cacheWrite);
  const cache = cacheRead + cacheWrite > 0 ? `, cache read ${tokens(cacheRead)}, cache write ${tokens(cacheWrite)}` : '';
  return `${calls} call${calls === 1 ? '' : 's'}, in ${tokens(sum((route) => route.in))}, out ${tokens(sum((route) => route.out))}${cache}`;
}

function routeLine(route: RouteTotals): string {
  const cache = route.cacheRead + route.cacheWrite > 0 ? `, cache read ${tokens(route.cacheRead)}, cache write ${tokens(route.cacheWrite)}` : '';
  return `${route.provider}/${route.model}: ${route.calls} call${route.calls === 1 ? '' : 's'}, in ${tokens(route.in)}, out ${tokens(route.out)}${cache}`;
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  return String(count);
}
