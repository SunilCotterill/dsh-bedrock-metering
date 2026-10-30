/**
 * Wrap every model call: refuse it when the budget is spent (metered routes
 * only), forward every chunk unchanged, and append one ledger row from the
 * last `usage` chunk when the stream ends, fails or is abandoned. A call that
 * failed after reporting usage is still billed, because the provider billed it.
 * @param runtime - shared metering state.
 * @returns the `llm/stream` waterfall listener.
 */
export function streamListener(runtime) {
    return (options, next) => {
        const attempt = runtime.host.newId();
        // Throws before any downstream listener or adapter runs.
        runtime.guard(options, attempt);
        return (async function* metered() {
            let usage;
            let outcome = 'incomplete';
            try {
                for await (const chunk of next()) {
                    if (chunk.type === 'usage')
                        usage = chunk.usage;
                    else if (chunk.type === 'finish')
                        outcome = chunk.reason.kind;
                    yield chunk;
                }
            }
            catch (error) {
                outcome = 'thrown';
                throw error;
            }
            finally {
                if (usage !== undefined) {
                    try {
                        runtime.recordUsage(options, usage, outcome, attempt);
                    }
                    catch (error) {
                        runtime.host.error('bedrock-metering: failed to record usage', error);
                    }
                }
            }
        })();
    };
}
/**
 * Reject a proposed step once the budget is spent and no override is active.
 * The turn then ends with reason `blocked` before any model request is made.
 * @param runtime - shared metering state.
 * @returns the `agent/pre-step` waterfall listener.
 */
export function preStepListener(runtime) {
    return (payload, next) => {
        if (runtime.gate(payload.agent, payload.turn, payload.step))
            return Promise.resolve({ kind: 'reject' });
        return next();
    };
}
