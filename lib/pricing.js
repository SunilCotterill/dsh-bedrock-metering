/**
 * Bedrock price table: the bundled `prices/bedrock.json` plus config
 * overrides, keyed by provider route and exact model id.
 * @module dsh-bedrock-metering/pricing
 */
import { readFileSync } from 'node:fs';
const BUNDLED_URL = new URL('../prices/bedrock.json', import.meta.url);
/**
 * Read the bundled price table shipped beside `lib/` and `src/`.
 * @returns the parsed table.
 */
export function loadBundledTable() {
    return JSON.parse(readFileSync(BUNDLED_URL, 'utf8'));
}
/** Price lookups for the metered provider routes. */
export class PriceBook {
    table;
    overrides;
    region;
    bedrockProviders;
    /**
     * @param table - bundled rows, matched by model id for every metered route.
     * @param overrides - config prices; they win over bundled rows.
     * @param region - preferred bundled row region when several rows share a model id.
     * @param bedrockProviders - routes the bundled Bedrock rows apply to.
     */
    constructor(table, overrides, region, bedrockProviders) {
        this.table = table;
        this.overrides = overrides;
        this.region = region;
        this.bedrockProviders = new Set(bedrockProviders);
    }
    /**
     * Find the price for one exact route.
     * @param provider - provider route from the request.
     * @param model - exact model id from the request.
     * @returns the config override, else the bundled row (preferring {@link region}), else undefined.
     */
    lookup(provider, model) {
        const override = this.overrides[provider]?.[model];
        if (override !== undefined)
            return { price: override, source: 'config', verified: true };
        if (!this.bedrockProviders.has(provider))
            return undefined;
        const rows = this.table.rows.filter((row) => row.modelIds.includes(model));
        const row = rows.find((candidate) => candidate.region === this.region) ?? rows[0];
        return row === undefined ? undefined : { price: row, source: row.key, verified: row.verified };
    }
}
/**
 * Whether reasoning tokens arrived outside `outputTokens`. Output is treated
 * as inclusive (D12) unless the reported total only balances with reasoning added.
 */
function reasoningIsSeparate(usage) {
    const reasoning = usage.reasoningTokens ?? 0;
    if (reasoning === 0 || usage.totalTokens === undefined)
        return false;
    const counted = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    return usage.totalTokens === counted + reasoning;
}
/**
 * Price one call.
 * @param usage - the call's last `usage` chunk.
 * @param price - USD per 1M tokens.
 * @param cacheFallback - rate for cache reads when the row has no cache-read price.
 * @returns USD, unrounded.
 */
export function cost(usage, price, cacheFallback) {
    const cacheReadRate = price.cacheRead ?? (cacheFallback === 'input-rate' ? price.input : 0);
    const cacheWriteRate = price.cacheWrite ?? 0;
    const output = usage.outputTokens + (reasoningIsSeparate(usage) ? usage.reasoningTokens ?? 0 : 0);
    return (usage.inputTokens * price.input +
        output * price.output +
        (usage.cacheReadTokens ?? 0) * cacheReadRate +
        (usage.cacheWriteTokens ?? 0) * cacheWriteRate) / 1_000_000;
}
