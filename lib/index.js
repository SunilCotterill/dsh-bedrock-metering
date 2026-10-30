/**
 * dsh-bedrock-metering: meter every model call, price it with published
 * Amazon Bedrock on-demand rates, warn as spend approaches the budget, and
 * stop the agent once the budget is spent.
 * @module dsh-bedrock-metering
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';
import z from '@deepseek-ai/schemastery';
import { handleBudgetCommand } from './command.js';
import { preStepListener, streamListener } from './hooks.js';
import { loadBundledTable } from './pricing.js';
import { MeteringRuntime } from './runtime.js';
import { installStatusRoute } from './web.js';
export { BUDGET_EXCEEDED, UNPRICED_MODEL } from './runtime.js';
export const name = 'bedrock-metering';
export const inject = ['llm', 'agents', 'sessions'];
const PriceSchema = z.object({
    input: z.number().min(0).required(),
    output: z.number().min(0).required(),
    cacheRead: z.number().min(0),
    cacheWrite: z.number().min(0),
});
/** Runtime schema for {@link Config}; defaults match `cordis.patch.yml`. */
export const Config = z.object({
    ledgerPath: z.string().default('~/.dsh-bedrock-metering/ledger.jsonl')
        .description('Shared append-only JSONL ledger for every dsh home and process.'),
    budget: z.object({
        window: z.union(['day', 'month', 'session']).default('day').description('Budget window; day and month start at local midnight.'),
        limitUsd: z.number().min(0).default(50).description('Spend limit in USD for one window.'),
        warnAt: z.array(z.number().min(0)).default([0.8, 0.95]).description('Fractions of limitUsd that each warn once per window.'),
        stopAt: z.number().min(0).default(1).description('Fraction of limitUsd at which the agent stops.'),
    }),
    meter: z.object({
        providers: z.array(z.string()).default(['amazon-bedrock']).description('Provider routes that count toward the budget.'),
        region: z.string().default('us').description('Preferred bundled price-row region when a model id has several.'),
        unpricedModel: z.union(['warn-zero', 'block']).default('warn-zero').description('Metered model without a price: count $0 with a warning, or refuse the call.'),
        cacheFallback: z.union(['input-rate', 'zero']).default('input-rate').description('Cache-read rate when a row publishes none.'),
        notifyModel: z.boolean().default(false).description('Also inject warnings as model-visible context.'),
    }),
    override: z.object({
        allow: z.boolean().default(true).description('Allow /budget override <minutes>.'),
        maxMinutes: z.natural().min(1).default(120).description('Longest override in minutes.'),
    }),
    prices: z.dict(z.dict(PriceSchema)).default({})
        .description('Price overrides in USD per 1M tokens: provider route, then model id.'),
});
/**
 * Mount the meter, the stop gate and guard, and the `/budget` command.
 * @param ctx - plugin context.
 * @param config - validated config.
 */
export function apply(ctx, config) {
    const profileContext = ctx.get('profileContext');
    const runtime = new MeteringRuntime(config, {
        now: Date.now,
        newId: randomUUID,
        warn: (message) => ctx.logger.warn(message),
        error: (message, error) => (error === undefined ? ctx.logger.error(message) : ctx.logger.error(`${message}: %o`, error)),
        // The headless runner's provider is only mounted in the headless profile, where ctx.logger reaches no sink.
        stderr: () => (ctx.get('headlessStartup') === undefined ? undefined : (line) => void process.stderr.write(`${line}\n`)),
        session: (id) => ctx.sessions.get(id),
        agent: (id) => ctx.agents.get(id),
        home: profileContext?.home ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
        profile: profileContext?.name ?? 'unknown',
    }, loadBundledTable());
    ctx.on('llm/stream', streamListener(runtime), { global: true, prepend: true });
    ctx.on('agent/pre-step', preStepListener(runtime), { prepend: true });
    ctx.on('session/event', (session, event) => {
        if (event.type === 'step/start')
            runtime.positions.set(session.id, { turn: event.data.turn, step: event.data.step });
    });
    ctx.on('session/disposed', (session) => {
        runtime.positions.delete(session.id);
    });
    installStatusRoute(ctx, runtime);
    ctx.inject(['commands'], (commandsCtx) => {
        commandsCtx.commands.register({
            definitionId: CommandDefinitionId('dsh-bedrock-metering/budget'),
            name: 'budget',
            description: 'Bedrock spend against the budget; override a stop or reset the window',
            input: { hint: 'status | override <minutes> | reset' },
            handler: (invocation) => handleBudgetCommand(runtime, invocation),
        });
    });
}
