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
/**
 * Append one budget record to a session log.
 * @param session - the live session that receives it.
 * @param kind - record kind.
 * @param data - JSON payload.
 * @returns the error when the append was refused (a closed or reentered session), else undefined.
 */
export function appendBudgetRecord(session, kind, data) {
    try {
        appendPluginRecord(session, `plugin:dsh-bedrock-metering/${kind}`, data);
        return undefined;
    }
    catch (error) {
        return error;
    }
}
