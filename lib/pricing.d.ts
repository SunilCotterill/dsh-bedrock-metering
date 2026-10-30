/** USD per 1M tokens for one model. Absent cache prices fall back per {@link CacheFallback}. */
export interface Price {
    input: number;
    output: number;
    cacheRead?: number | null;
    cacheWrite?: number | null;
}
/** One bundled row of `prices/bedrock.json`. */
export interface PriceRow extends Price {
    key: string;
    name: string;
    modelIds: string[];
    region: string;
    verified: boolean;
    sourceUrl: string;
    retrievedAt: string;
    page?: {
        section: string;
        panel: string;
        row: string;
        region?: string;
    };
}
export interface PriceTable {
    schemaVersion: 1;
    currency: 'USD';
    unit: string;
    tier: string;
    sourceUrl: string;
    retrievedAt: string;
    rows: PriceRow[];
}
/** Token counts as reported by an adapter `usage` chunk (disjoint input buckets). */
export interface Usage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
/** How cache tokens are billed when the row publishes no cache price (D13). */
export type CacheFallback = 'input-rate' | 'zero';
/** Config overrides: provider route → model id → price. */
export type PriceOverrides = Record<string, Record<string, Price>>;
export interface PriceMatch {
    price: Price;
    /** `config` for an override, otherwise the bundled row key. */
    source: string;
    verified: boolean;
}
/**
 * Read the bundled price table shipped beside `lib/` and `src/`.
 * @returns the parsed table.
 */
export declare function loadBundledTable(): PriceTable;
/** Price lookups for the metered provider routes. */
export declare class PriceBook {
    readonly table: PriceTable;
    readonly overrides: PriceOverrides;
    readonly region: string;
    readonly bedrockProviders: ReadonlySet<string>;
    /**
     * @param table - bundled rows, matched by model id for every metered route.
     * @param overrides - config prices; they win over bundled rows.
     * @param region - preferred bundled row region when several rows share a model id.
     * @param bedrockProviders - routes the bundled Bedrock rows apply to.
     */
    constructor(table: PriceTable, overrides: PriceOverrides, region: string, bedrockProviders: Iterable<string>);
    /**
     * Find the price for one exact route.
     * @param provider - provider route from the request.
     * @param model - exact model id from the request.
     * @returns the config override, else the bundled row (preferring {@link region}), else undefined.
     */
    lookup(provider: string, model: string): PriceMatch | undefined;
}
/**
 * Price one call.
 * @param usage - the call's last `usage` chunk.
 * @param price - USD per 1M tokens.
 * @param cacheFallback - rate for cache reads when the row has no cache-read price.
 * @returns USD, unrounded.
 */
export declare function cost(usage: Usage, price: Price, cacheFallback: CacheFallback): number;
