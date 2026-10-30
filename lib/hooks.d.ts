/**
 * The `llm/stream` meter and guard, and the `agent/pre-step` gate.
 * @module dsh-bedrock-metering/hooks
 */
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { MeteringRuntime } from './runtime.ts';
/**
 * Wrap every model call: refuse it when the budget is spent (metered routes
 * only), forward every chunk unchanged, and append one ledger row from the
 * last `usage` chunk when the stream ends, fails or is abandoned. A call that
 * failed after reporting usage is still billed, because the provider billed it.
 * @param runtime - shared metering state.
 * @returns the `llm/stream` waterfall listener.
 */
export declare function streamListener(runtime: MeteringRuntime): (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
/**
 * Reject a proposed step once the budget is spent and no override is active.
 * The turn then ends with reason `blocked` before any model request is made.
 * @param runtime - shared metering state.
 * @returns the `agent/pre-step` waterfall listener.
 */
export declare function preStepListener(runtime: MeteringRuntime): (payload: {
    agent: Agent;
    turn: number;
    step: number;
}, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>;
