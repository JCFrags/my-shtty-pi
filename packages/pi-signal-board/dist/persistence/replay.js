import { EVENT_CUSTOM_TYPE } from '../constants.js';
import { createEmptyBoardState, reduceBoardEvent } from '../domain/reducer.js';
import { decodeBoardEvent } from './event-codec.js';
export const MAX_REPLAY_WARNINGS = 100;
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/**
 * Rebuild one complete root-to-leaf branch supplied by the caller.
 * This function has no host, clock, storage, or network dependency.
 */
export function replayBranch(entries) {
    let state = createEmptyBoardState();
    let acceptedEvents = 0;
    let skippedEvents = 0;
    const warnings = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined || entry.type !== 'custom' || entry.customType !== EVENT_CUSTOM_TYPE) {
            continue;
        }
        const decoded = decodeBoardEvent(entry.data);
        if (!decoded.ok) {
            skippedEvents += 1;
            addWarning(warnings, entry, index, decoded.error.code === 'SB_EVENT_UNSUPPORTED_VERSION'
                ? 'SB_REPLAY_UNSUPPORTED_VERSION'
                : 'SB_REPLAY_DECODE_INVALID');
            continue;
        }
        const reduced = reduceBoardEvent(state, decoded.event);
        if (!reduced.ok) {
            skippedEvents += 1;
            addWarning(warnings, entry, index, 'SB_REPLAY_REDUCER_REJECTED');
            continue;
        }
        state = reduced.state;
        acceptedEvents += 1;
    }
    const immutableWarnings = Object.freeze(warnings);
    const replay = Object.freeze({ acceptedEvents, skippedEvents, warnings: immutableWarnings });
    const finalState = Object.freeze({ ...state, replay });
    return Object.freeze({
        state: finalState,
        acceptedEvents,
        skippedEvents,
        warnings: immutableWarnings,
    });
}
function addWarning(warnings, entry, entryIndex, code) {
    if (warnings.length >= MAX_REPLAY_WARNINGS)
        return;
    const entryId = typeof entry.id === 'string' && SAFE_ENTRY_ID.test(entry.id) ? entry.id : undefined;
    warnings.push(Object.freeze({ entryIndex, ...(entryId === undefined ? {} : { entryId }), code }));
}
