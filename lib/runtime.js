import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { Announcer, evaluate, formatLocal, formatPercent, formatUsd, stopText, summarize, warningText, windowLabel, } from './budget.js';
import { appendBudgetRecord } from './events.js';
import { expandHome, Ledger } from './ledger.js';
import { cost, PriceBook } from './pricing.js';
/** Stable error code thrown by the stream guard. */
export const BUDGET_EXCEEDED = 'BUDGET_EXCEEDED';
/** Stable error code for a metered model without a price under `unpricedModel: block`. */
export const UNPRICED_MODEL = 'BUDGET_UNPRICED_MODEL';
const MINUTE = 60_000;
/**
 * The parent of a subagent child session, read from its immutable header.
 * A user fork also records `parentSession` but is a conversation of its own,
 * so only `origin: 'subagent'` sessions roll into their parent.
 * @param session - a live session.
 * @returns the parent session id, or undefined for a top-level session.
 */
export function subagentParent(session) {
    const { header } = session;
    return header.origin === 'subagent' ? header.parentSession : undefined;
}
export class MeteringRuntime {
    config;
    host;
    ledger;
    prices;
    providers;
    announcer = new Announcer();
    /** Latest `step/start` position per session, stamped on ledger rows. */
    positions = new Map();
    unpricedWarned = new Set();
    constructor(config, host, table) {
        this.config = config;
        this.host = host;
        this.ledger = new Ledger(expandHome(config.ledgerPath));
        this.providers = new Set(config.meter.providers);
        this.prices = new PriceBook(table, config.prices, config.meter.region, config.meter.providers);
    }
    isMetered(provider) {
        return provider !== undefined && this.providers.has(provider);
    }
    /** Whether the agent's next request may go to a metered route (its options or its last logged header). */
    agentIsMetered(agent) {
        return this.isMetered(agent.options.provider) || this.isMetered(agent.session.requestHeader()?.config.provider);
    }
    /**
     * Refresh the ledger view and evaluate the current window.
     * @param session - session id scoping the `session` (conversation) window; a subagent's
     *   child session resolves to its parent conversation. Without one a conversation window
     *   sums nothing, so a model call that carries no session id is logged but neither counted
     *   toward a conversation nor stopped.
     * @returns the window summary and verdict.
     */
    current(session) {
        const now = this.host.now();
        const { window } = this.config.budget;
        // Hold rows from before the window too, so an override set just before midnight survives it.
        const keepFrom = window === 'session'
            ? Number.NEGATIVE_INFINITY
            : summarize([], window, now).start - this.config.override.maxMinutes * MINUTE;
        try {
            this.ledger.refresh(keepFrom);
        }
        catch (error) {
            this.host.error(`bedrock-metering: cannot read ledger ${this.ledger.path}`, error);
        }
        const conversation = window === 'session' && session !== undefined ? this.conversationOf(session) : undefined;
        const summary = summarize(this.ledger.rows(), window, now, conversation);
        return { summary, verdict: evaluate(summary, this.config.budget, now) };
    }
    /**
     * The conversation a session belongs to: the top-level session above any
     * chain of subagent children. Live sessions are walked through their
     * headers; a session that is not live is looked up in the ledger, whose
     * rows record the conversation of every child session.
     * @param session - session id.
     * @returns the top-level session id (the session itself when it is top-level).
     */
    conversationOf(session) {
        const seen = new Set();
        let current = session;
        for (;;) {
            seen.add(current);
            const live = this.host.session(current);
            const parent = live === undefined ? this.recordedConversation(current) : subagentParent(live);
            if (parent === undefined || seen.has(parent))
                return current;
            current = parent;
        }
    }
    /** The conversation the ledger last recorded for a child session, if any. */
    recordedConversation(session) {
        const rows = this.ledger.rows();
        for (let i = rows.length - 1; i >= 0; i--) {
            const { row } = rows[i];
            if (row.session === session && row.conversation !== undefined)
                return row.conversation;
        }
        return undefined;
    }
    /**
     * Append one usage row for a finished (or failed) model call, then announce any newly crossed threshold.
     * @param options - the request.
     * @param usage - the last `usage` chunk the call reported.
     * @param outcome - terminal finish kind, or how the stream ended without one.
     * @param attempt - id minted for this call.
     */
    recordUsage(options, usage, outcome, attempt) {
        const metered = this.isMetered(options.provider);
        const match = metered ? this.prices.lookup(options.provider, options.model) : undefined;
        if (metered && match === undefined)
            this.warnUnpriced(options.provider, options.model);
        const usd = match === undefined ? 0 : cost(usage, match.price, this.config.meter.cacheFallback);
        const position = options.sessionId === undefined ? undefined : this.positions.get(options.sessionId);
        const row = {
            ...this.base(options.sessionId),
            kind: 'usage',
            ...position,
            attempt,
            ...options.purpose === undefined ? {} : { purpose: options.purpose },
            provider: options.provider,
            model: options.model,
            in: usage.inputTokens,
            out: usage.outputTokens,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
            reasoning: usage.reasoningTokens ?? 0,
            usd: Math.round(usd * 1e8) / 1e8,
            metered,
            priced: match !== undefined,
            ...match === undefined ? {} : { price: match.source },
            outcome,
        };
        this.append(row);
        if (!metered)
            return;
        const sessionId = options.sessionId;
        const agent = sessionId === undefined ? undefined : this.host.agent(sessionId);
        const { summary, verdict } = this.current(sessionId);
        this.announce(agent, sessionId, summary, verdict);
    }
    /**
     * Refuse a metered model call when the budget is spent (D5 guard), or when
     * its model is unpriced under `unpricedModel: block`.
     * @param options - the request about to be dispatched.
     * @param attempt - id minted for this call.
     * @throws LlmError with {@link BUDGET_EXCEEDED} or {@link UNPRICED_MODEL}.
     */
    guard(options, attempt) {
        if (!this.isMetered(options.provider))
            return;
        if (this.config.meter.unpricedModel === 'block' && this.prices.lookup(options.provider, options.model) === undefined) {
            this.refuse(options, attempt);
            throw new LlmError(`bedrock-metering: no price for ${options.provider}/${options.model}; add it under prices in the profile patch`, UNPRICED_MODEL);
        }
        const { summary, verdict } = this.current(options.sessionId);
        if (!verdict.stop)
            return;
        this.refuse(options, attempt);
        const session = options.sessionId === undefined ? undefined : this.host.session(options.sessionId);
        this.stopped(session, summary, {
            via: 'stream-guard',
            provider: options.provider,
            model: options.model,
            ...options.purpose === undefined ? {} : { purpose: options.purpose },
        });
        throw new LlmError(`budget ${stopText(summary, this.config.budget)}`, BUDGET_EXCEEDED);
    }
    /**
     * Decide one proposed step (D5 primary stop).
     * @param agent - the agent proposing the step.
     * @param turn - the step's turn.
     * @param step - the proposed step.
     * @returns true when the step must be rejected.
     */
    gate(agent, turn, step) {
        if (!this.agentIsMetered(agent))
            return false;
        const { summary, verdict } = this.current(agent.session.id);
        if (verdict.stop) {
            this.stopped(agent.session, summary, { via: 'pre-step', turn, step });
            return true;
        }
        this.announce(agent, agent.session.id, summary, verdict);
        return false;
    }
    /** Announce a newly crossed warning threshold once per window in this process. */
    announce(agent, sessionId, summary, verdict) {
        const threshold = this.announcer.next(summary, verdict);
        if (threshold === undefined)
            return;
        const text = warningText(summary, verdict, this.config.budget);
        this.notify(`budget: ${text}`);
        const session = agent?.session ?? (sessionId === undefined ? undefined : this.host.session(sessionId));
        if (session !== undefined) {
            this.record(session, 'warning', {
                window: summary.window,
                windowStart: isoOrEpoch(summary.start),
                limitUsd: this.config.budget.limitUsd,
                spentUsd: round(summary.spentUsd),
                threshold,
                fraction: Number.isFinite(verdict.fraction) ? round(verdict.fraction) : 1e9,
            });
        }
        if (this.config.meter.notifyModel && agent !== undefined) {
            const summaryLine = `Bedrock budget: ${text}`;
            agent.inject(createUserMessage({
                content: [{ type: 'text', text: `${summaryLine}. Wrap up soon; the agent stops at ${formatPercent(this.config.budget.stopAt)} of the limit.` }],
                source: { kind: 'bedrock-metering', form: 'notice', summary: summaryLine.slice(0, 120) },
            }));
        }
    }
    /**
     * `/budget override <minutes>`: lift the stop for this conversation (conversation
     * window) or for every process sharing the ledger (calendar windows).
     * @returns the command reply.
     */
    override(agent, minutes) {
        const now = this.host.now();
        const until = now + minutes * MINUTE;
        const { window, limitUsd } = this.config.budget;
        const { summary } = this.current(agent.session.id);
        this.append({ ...this.base(agent.session.id), kind: 'override', until: new Date(until).toISOString(), minutes, window });
        this.record(agent.session, 'override', {
            minutes, until: new Date(until).toISOString(), limitUsd, spentUsd: round(summary.spentUsd),
        });
        const spent = `${formatUsd(summary.spentUsd)} of ${formatUsd(limitUsd)}`;
        if (window === 'session') {
            this.notify(`budget: stop lifted for conversation ${summary.conversation ?? agent.session.id} for ${minutes} min, until ${formatLocal(until)}`);
            return `Budget stop lifted for this conversation until ${formatLocal(until)} local time (${minutes} min). ` +
                `Spent in this conversation: ${spent}.`;
        }
        this.notify(`budget: stop lifted for ${minutes} min, until ${formatLocal(until)}`);
        return `Budget stop lifted until ${formatLocal(until)} local time (${minutes} min) for every dsh process using ${this.ledger.path}. ` +
            `Spent so far: ${spent}.`;
    }
    /**
     * `/budget reset`: restart this conversation's count (conversation window) or
     * start a fresh calendar window now. For mistakes only.
     * @returns the command reply.
     */
    reset(agent) {
        const { window, limitUsd } = this.config.budget;
        const { summary } = this.current(agent.session.id);
        this.append({ ...this.base(agent.session.id), kind: 'reset', window });
        this.record(agent.session, 'reset', {
            window: summary.window, previousStart: isoOrEpoch(summary.start), spentUsd: round(summary.spentUsd),
        });
        if (window === 'session') {
            this.notify(`budget: conversation ${summary.conversation ?? agent.session.id} reset (was ${formatUsd(summary.spentUsd)})`);
            return `Conversation budget reset: spend counts from now. ${formatUsd(summary.spentUsd)} spent since ${formatStart(summary.start)} ` +
                `no longer counts toward this conversation's ${formatUsd(limitUsd)} limit. Other conversations are unaffected. ` +
                'The reset is recorded in the ledger and on this conversation.';
        }
        this.notify(`budget: window reset (was ${formatUsd(summary.spentUsd)})`);
        return `Budget window reset: spend counts from now. ${formatUsd(summary.spentUsd)} spent since ${formatStart(summary.start)} no longer counts toward the ${windowLabel(summary.window)} limit. ` +
            'The reset is recorded in the ledger and on this session.';
    }
    /** Row fields shared by every kind; a subagent's rows also name their conversation. */
    base(session) {
        const conversation = session === undefined ? undefined : this.conversationOf(session);
        return {
            v: 1,
            ts: new Date(this.host.now()).toISOString(),
            home: this.host.home,
            profile: this.host.profile,
            ...session === undefined ? {} : { session },
            ...conversation === undefined || conversation === session ? {} : { conversation },
        };
    }
    append(row) {
        try {
            this.ledger.append(row);
        }
        catch (error) {
            this.host.error(`bedrock-metering: cannot append to ledger ${this.ledger.path}`, error);
        }
    }
    refuse(options, attempt) {
        this.append({
            ...this.base(options.sessionId),
            kind: 'refused',
            attempt,
            ...options.purpose === undefined ? {} : { purpose: options.purpose },
            provider: options.provider,
            model: options.model,
        });
    }
    stopped(session, summary, detail) {
        this.notify(`budget: ${stopText(summary, this.config.budget)}`);
        if (session === undefined)
            return;
        this.record(session, 'stop', {
            window: summary.window,
            windowStart: isoOrEpoch(summary.start),
            limitUsd: this.config.budget.limitUsd,
            spentUsd: round(summary.spentUsd),
            ...detail,
        });
    }
    record(session, kind, data) {
        const error = appendBudgetRecord(session, kind, data);
        if (error !== undefined)
            this.host.error(`bedrock-metering: cannot record budget ${kind} on session ${session.id}`, error);
    }
    notify(message) {
        this.host.warn(message);
        this.host.stderr()?.(`dsh: ${message}`);
    }
    warnUnpriced(provider, model) {
        const key = `${provider}/${model}`;
        if (this.unpricedWarned.has(key))
            return;
        this.unpricedWarned.add(key);
        this.notify(`budget: no Bedrock price for ${key}; its calls count as $0 (add it under prices in the profile patch)`);
    }
}
function round(value) {
    return Math.round(value * 1e6) / 1e6;
}
function isoOrEpoch(at) {
    return Number.isFinite(at) ? new Date(at).toISOString() : 'session-start';
}
function formatStart(at) {
    return Number.isFinite(at) ? formatLocal(at) : 'the conversation started';
}
