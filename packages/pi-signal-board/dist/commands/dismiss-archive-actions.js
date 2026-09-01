import { isFiniteUtcTimestamp } from '../domain/invariants.js';
import { sanitizeText } from '../domain/sanitization.js';
/** Confirm and invoke the accepted question service once. This function never sends a message. */
export async function confirmDismissQuestion(dependencies) {
    const { question } = dependencies;
    if (question === undefined)
        return unavailable('SB_NOT_FOUND');
    if (question.revision !== dependencies.expectedRevision) {
        return unavailable('SB_REVISION_MISMATCH');
    }
    if (!isDismissible(question))
        return unavailable('SB_STATE_CONFLICT');
    if (!hasConfirmationUi(dependencies.context))
        return unavailable('SB_UI_UNAVAILABLE');
    const displayId = safeDisplayId(question.displayId, 'selected question');
    let confirmed;
    try {
        confirmed = await dependencies.context.ui.confirm(`Dismiss ${displayId}?`, 'Item type: question\n\nDismissal is not an answer. Nothing will be sent to the agent, and this question will move to History.');
    }
    catch {
        return unavailable('SB_UI_UNAVAILABLE');
    }
    if (typeof confirmed !== 'boolean')
        return unavailable('SB_INVALID_ARGUMENT');
    if (!confirmed)
        return Object.freeze({ kind: 'cancelled' });
    let dismissedAt;
    let commandId;
    try {
        dismissedAt = dependencies.now().toISOString();
        commandId = dependencies.commandId();
    }
    catch {
        return unavailable('SB_INTERNAL');
    }
    if (!isFiniteUtcTimestamp(dismissedAt))
        return unavailable('SB_INTERNAL');
    try {
        const result = await dependencies.dismissQuestion({
            commandId,
            id: question.id,
            expectedRevision: dependencies.expectedRevision,
            dismissedAt,
            reason: 'user_dismissed',
            source: 'board',
        });
        return result.ok ? Object.freeze({ kind: 'success' }) : unavailable(result.error.code);
    }
    catch {
        return unavailable('SB_INTERNAL');
    }
}
/** Confirm and invoke the accepted update service once for a terminal update. */
export async function confirmArchiveUpdate(dependencies) {
    const { update } = dependencies;
    if (update === undefined)
        return unavailable('SB_NOT_FOUND');
    if (update.revision !== dependencies.expectedRevision) {
        return unavailable('SB_REVISION_MISMATCH');
    }
    if (!isArchiveEligible(update))
        return unavailable('SB_STATE_CONFLICT');
    if (!hasConfirmationUi(dependencies.context))
        return unavailable('SB_UI_UNAVAILABLE');
    const displayId = safeDisplayId(update.displayId, 'selected update');
    let confirmed;
    try {
        confirmed = await dependencies.context.ui.confirm(`Archive ${displayId}?`, 'Item type: update\n\nThis terminal update will leave Updates and remain available in History.');
    }
    catch {
        return unavailable('SB_UI_UNAVAILABLE');
    }
    if (typeof confirmed !== 'boolean')
        return unavailable('SB_INVALID_ARGUMENT');
    if (!confirmed)
        return Object.freeze({ kind: 'cancelled' });
    let archivedAt;
    let commandId;
    try {
        archivedAt = dependencies.now().toISOString();
        commandId = dependencies.commandId();
    }
    catch {
        return unavailable('SB_INTERNAL');
    }
    if (!isFiniteUtcTimestamp(archivedAt))
        return unavailable('SB_INTERNAL');
    try {
        const result = await dependencies.archiveFromUi({
            commandId,
            id: update.id,
            expectedRevision: dependencies.expectedRevision,
            archivedAt,
            source: 'board',
        });
        return result.ok ? Object.freeze({ kind: 'success' }) : unavailable(result.error.code);
    }
    catch {
        return unavailable('SB_INTERNAL');
    }
}
function isDismissible(question) {
    return ((question.status === 'pending' || question.status === 'blocking') &&
        question.answerId === undefined);
}
function isArchiveEligible(update) {
    return !update.archived && (update.kind === 'completed' || update.kind === 'failed');
}
function hasConfirmationUi(context) {
    try {
        return context.mode === 'tui' && context.hasUI && typeof context.ui.confirm === 'function';
    }
    catch {
        return false;
    }
}
function safeDisplayId(value, fallback) {
    const result = sanitizeText(value, { mode: 'one_line', maxCodePoints: 32 });
    return result.ok ? result.value : fallback;
}
function unavailable(code) {
    return Object.freeze({ kind: 'unavailable', code });
}
