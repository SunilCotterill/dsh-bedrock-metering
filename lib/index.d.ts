import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { MeteringConfig } from './runtime.ts';
export type { MeteringConfig } from './runtime.ts';
export type { BudgetRecords } from './events.ts';
export { BUDGET_EXCEEDED, UNPRICED_MODEL } from './runtime.ts';
export declare const name = "bedrock-metering";
export declare const inject: string[];
export type Config = MeteringConfig;
/** Runtime schema for {@link Config}; defaults match `cordis.patch.yml`. */
export declare const Config: z<Config>;
/**
 * Mount the meter, the stop gate and guard, and the `/budget` command.
 * @param ctx - plugin context.
 * @param config - validated config.
 */
export declare function apply(ctx: Context, config: Config): void;
