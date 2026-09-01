import { assertNeverBoardEvent } from './events.js';
import { decisionDisplayId, isAnswerId, isCommandId, isEventId, isQuestionId, isUpdateId, questionDisplayId, updateDisplayId, } from './ids.js';
import { answerMatchesRecommendation, canonicalize, commandFingerprint, eventFingerprint, hasValidEnvelope, isFiniteUtcTimestamp, isPositiveSafeInteger, sameSemanticValue, validAnswerValue, validAttachments, validQuestionSpec, validUpdateFields, } from './invariants.js';
export const REDUCER_REJECT_REASONS = Object.freeze({
    invalidEvent: 'Event structure or semantics are invalid.',
    invalidActor: 'Event actor or command ownership is invalid.',
    notFound: 'Referenced state does not exist.',
    conflict: 'Event conflicts with current state.',
    revision: 'Event revision does not match current state.',
    duplicateEvent: 'Event ID was reused with different content.',
    duplicateCommand: 'Command ID was reused with different semantics.',
    unsafeQuestion: 'Authorization questions cannot be persisted.',
});
const EMPTY_COUNTERS = Object.freeze({ nextUpdate: 1, nextQuestion: 1, nextDecision: 1 });
const EMPTY_REPLAY = Object.freeze({
    acceptedEvents: 0,
    skippedEvents: 0,
    warnings: Object.freeze([]),
});
export function createEmptyBoardState() {
    return freezeClone({
        schemaVersion: 1,
        updates: new Map(),
        questions: new Map(),
        answers: new Map(),
        acknowledgements: new Map(),
        commandResults: new Map(),
        acceptedEventIds: new Map(),
        visibleChanges: [],
        counters: EMPTY_COUNTERS,
        replay: EMPTY_REPLAY,
    });
}
export function createStateAfterReset(event) {
    const eventValue = eventFingerprint(event);
    const semanticValue = commandFingerprint(event);
    if (eventValue === undefined || semanticValue === undefined)
        return createEmptyBoardState();
    return freezeClone({
        schemaVersion: 1,
        updates: new Map(),
        questions: new Map(),
        answers: new Map(),
        acknowledgements: new Map(),
        commandResults: new Map([
            [
                event.commandId,
                { eventId: event.eventId, eventType: event.eventType, semanticPayload: event.payload },
            ],
        ]),
        acceptedEventIds: new Map([[event.eventId, eventValue]]),
        visibleChanges: [],
        resetEventId: event.eventId,
        counters: EMPTY_COUNTERS,
        replay: { acceptedEvents: 1, skippedEvents: 0, warnings: [] },
    });
}
/** Pure, total, deterministic reducer for the complete v1 event union. */
export function reduceBoardEvent(state, event) {
    try {
        if (!hasValidEnvelope(event) || !isEventId(event.eventId) || !isCommandId(event.commandId)) {
            return reject('SB_INVALID_ARGUMENT', REDUCER_REJECT_REASONS.invalidEvent);
        }
        if (!commandMatchesActor(event)) {
            return reject('SB_INVALID_ARGUMENT', REDUCER_REJECT_REASONS.invalidActor);
        }
        const fullFingerprint = eventFingerprint(event);
        const semanticFingerprint = commandFingerprint(event);
        if (fullFingerprint === undefined || semanticFingerprint === undefined) {
            return reject('SB_INVALID_ARGUMENT', REDUCER_REJECT_REASONS.invalidEvent);
        }
        const acceptedEvent = state.acceptedEventIds.get(event.eventId);
        if (acceptedEvent !== undefined) {
            return acceptedEvent === fullFingerprint
                ? success(state, { kind: 'none' }, true)
                : reject('SB_STATE_CONFLICT', REDUCER_REJECT_REASONS.duplicateEvent);
        }
        const command = state.commandResults.get(event.commandId);
        if (command !== undefined) {
            const prior = canonicalize({
                eventType: command.eventType,
                payload: command.semanticPayload,
            });
            return prior === semanticFingerprint
                ? success(state, { kind: 'none' }, true)
                : reject('SB_STATE_CONFLICT', REDUCER_REJECT_REASONS.duplicateCommand);
        }
        const handled = dispatch(state, event);
        if ('ok' in handled)
            return handled;
        const recorded = recordAccepted(handled.state, event, fullFingerprint, handled.visibleChange);
        return success(recorded, handled.visibleChange, false);
    }
    catch {
        return reject('SB_INVALID_ARGUMENT', REDUCER_REJECT_REASONS.invalidEvent);
    }
}
function dispatch(state, event) {
    switch (event.eventType) {
        case 'update.upserted':
            return reduceUpdateUpserted(state, event);
        case 'update.archived':
            return reduceUpdateArchived(state, event);
        case 'question.created':
            return reduceQuestionCreated(state, event);
        case 'question.revised':
            return reduceQuestionRevised(state, event);
        case 'question.cancelled':
            return reduceQuestionCancelled(state, event);
        case 'question.escalated':
            return reduceQuestionEscalated(state, event);
        case 'question.staled':
            return reduceQuestionStaled(state, event);
        case 'question.dismissed':
            return reduceQuestionDismissed(state, event);
        case 'question.answered':
            return reduceQuestionAnswered(state, event);
        case 'answer.delivery_queued':
            return reduceDelivery(state, event, 'queued');
        case 'answer.delivery_failed':
            return reduceDelivery(state, event, 'failed');
        case 'answer.acknowledged':
            return reduceAcknowledged(state, event);
        case 'board.viewed':
            return reduceViewed(state, event);
        case 'board.reset':
            return reduceReset(event);
        default:
            return assertNeverBoardEvent(event);
    }
}
function reduceUpdateUpserted(state, event) {
    const payload = event.payload;
    if (!isUpdateId(payload.updateId) ||
        !isPositiveSafeInteger(payload.revision) ||
        !isFiniteUtcTimestamp(payload.createdAt) ||
        !isFiniteUtcTimestamp(payload.updatedAt) ||
        payload.updatedAt !== event.occurredAt ||
        (payload.completedAt !== undefined &&
            (!isFiniteUtcTimestamp(payload.completedAt) || payload.completedAt !== event.occurredAt)) ||
        !validUpdateFields(payload.fields, payload.completedAt))
        return invalid();
    const existing = state.updates.get(payload.updateId);
    if (existing === undefined) {
        if (payload.revision !== 1 ||
            payload.createdAt !== payload.updatedAt ||
            payload.displayId !== updateDisplayId(state.counters.nextUpdate) ||
            [...state.updates.values()].some((item) => item.displayId === payload.displayId) ||
            hasActiveUpdateKey(state, payload.fields.key))
            return conflict();
    }
    else {
        if (existing.archived ||
            payload.createdAt !== existing.createdAt ||
            payload.displayId !== existing.displayId)
            return conflict();
        if (payload.revision !== existing.revision + 1)
            return revision();
        if (hasActiveUpdateKey(state, payload.fields.key, existing.id))
            return conflict();
        if (sameSemanticValue(updateSemantic(existing), normalizedUpdateFields(payload)))
            return conflict();
    }
    const fields = normalizedUpdateFields(payload);
    const item = {
        ...fields,
        id: payload.updateId,
        displayId: payload.displayId,
        revision: payload.revision,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        ...(payload.completedAt === undefined ? {} : { completedAt: payload.completedAt }),
        archived: false,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    const updates = new Map(state.updates).set(item.id, item);
    const kind = existing === undefined
        ? 'update_created'
        : item.kind === 'completed'
            ? 'update_completed'
            : item.kind === 'failed'
                ? 'update_failed'
                : 'update_changed';
    return {
        state: {
            ...state,
            updates,
            counters: {
                ...state.counters,
                nextUpdate: existing === undefined ? state.counters.nextUpdate + 1 : state.counters.nextUpdate,
            },
        },
        visibleChange: { kind, itemId: item.id, updateKind: item.kind },
    };
}
function reduceUpdateArchived(state, event) {
    const payload = event.payload;
    if (!isUpdateId(payload.updateId) ||
        !isPositiveSafeInteger(payload.expectedRevision) ||
        !isPositiveSafeInteger(payload.revision) ||
        !isFiniteUtcTimestamp(payload.archivedAt) ||
        payload.archivedAt !== event.occurredAt)
        return invalid();
    const current = state.updates.get(payload.updateId);
    if (current === undefined)
        return notFound();
    if (current.archived)
        return conflict();
    if (payload.expectedRevision !== current.revision || payload.revision !== current.revision + 1)
        return revision();
    const item = {
        ...current,
        revision: payload.revision,
        updatedAt: payload.archivedAt,
        archivedAt: payload.archivedAt,
        archived: true,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: { ...state, updates: new Map(state.updates).set(item.id, item) },
        visibleChange: { kind: 'update_archived', itemId: item.id, updateKind: item.kind },
    };
}
function reduceQuestionCreated(state, event) {
    const payload = event.payload;
    if (payload.spec.class === 'authorization')
        return reject('SB_UNSAFE_QUESTION', REDUCER_REJECT_REASONS.unsafeQuestion);
    if (!isQuestionId(payload.questionId) ||
        payload.revision !== 1 ||
        payload.displayId !== questionDisplayId(state.counters.nextQuestion) ||
        !isFiniteUtcTimestamp(payload.createdAt) ||
        payload.createdAt !== event.occurredAt ||
        !validQuestionSpec(payload.spec))
        return invalid();
    if (state.questions.has(payload.questionId) ||
        [...state.questions.values()].some((item) => item.displayId === payload.displayId))
        return conflict();
    const item = {
        ...payload.spec,
        id: payload.questionId,
        displayId: payload.displayId,
        revision: 1,
        status: 'pending',
        createdAt: payload.createdAt,
        updatedAt: payload.createdAt,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: {
            ...state,
            questions: new Map(state.questions).set(item.id, item),
            counters: { ...state.counters, nextQuestion: state.counters.nextQuestion + 1 },
        },
        visibleChange: { kind: 'question_created', itemId: item.id },
    };
}
function reduceQuestionRevised(state, event) {
    const payload = event.payload;
    if (payload.spec.class === 'authorization')
        return reject('SB_UNSAFE_QUESTION', REDUCER_REJECT_REASONS.unsafeQuestion);
    if (!isQuestionId(payload.questionId) ||
        !isPositiveSafeInteger(payload.expectedRevision) ||
        !isPositiveSafeInteger(payload.revision) ||
        !isFiniteUtcTimestamp(payload.updatedAt) ||
        payload.updatedAt !== event.occurredAt ||
        typeof payload.revisionSummary !== 'string' ||
        payload.revisionSummary.length === 0 ||
        !validQuestionSpec(payload.spec))
        return invalid();
    const current = state.questions.get(payload.questionId);
    if (current === undefined)
        return notFound();
    if (!isAnswerable(current))
        return conflict();
    if (payload.expectedRevision !== current.revision || payload.revision !== current.revision + 1)
        return revision();
    if (sameSemanticValue(questionSemantic(current), payload.spec))
        return conflict();
    const item = {
        ...current,
        ...payload.spec,
        revision: payload.revision,
        updatedAt: payload.updatedAt,
        revisionSummary: payload.revisionSummary,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: { ...state, questions: new Map(state.questions).set(item.id, item) },
        visibleChange: { kind: 'question_changed', itemId: item.id },
    };
}
function reduceQuestionCancelled(state, event) {
    return reduceQuestionTerminal(state, event, 'cancelled', event.payload.reason);
}
function reduceQuestionStaled(state, event) {
    const current = state.questions.get(event.payload.questionId);
    if (current !== undefined &&
        (current.expiresAt === undefined ||
            Date.parse(event.payload.staleAt) < Date.parse(current.expiresAt)))
        return conflict();
    return reduceQuestionTerminal(state, event, 'stale', event.payload.reason);
}
function reduceQuestionDismissed(state, event) {
    return reduceQuestionTerminal(state, event, 'dismissed');
}
function reduceQuestionTerminal(state, event, status, reasonText) {
    const payload = event.payload;
    const timestamp = event.eventType === 'question.cancelled'
        ? event.payload.cancelledAt
        : event.eventType === 'question.staled'
            ? event.payload.staleAt
            : event.payload.dismissedAt;
    if (!isQuestionId(payload.questionId) ||
        !isPositiveSafeInteger(payload.expectedRevision) ||
        !isPositiveSafeInteger(payload.revision) ||
        !isFiniteUtcTimestamp(timestamp) ||
        timestamp !== event.occurredAt ||
        (reasonText !== undefined && reasonText.length === 0))
        return invalid();
    const current = state.questions.get(payload.questionId);
    if (current === undefined)
        return notFound();
    if (!isAnswerable(current))
        return conflict();
    if (payload.expectedRevision !== current.revision || payload.revision !== current.revision + 1)
        return revision();
    const terminalFields = status === 'cancelled'
        ? { cancelledAt: timestamp, cancelReason: reasonText }
        : status === 'stale'
            ? { staleAt: timestamp, staleReason: reasonText }
            : { dismissedAt: timestamp };
    const item = {
        ...current,
        revision: payload.revision,
        status,
        updatedAt: timestamp,
        ...terminalFields,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: { ...state, questions: new Map(state.questions).set(item.id, item) },
        visibleChange: { kind: 'question_terminal', itemId: item.id },
    };
}
function reduceQuestionEscalated(state, event) {
    const payload = event.payload;
    if (!isQuestionId(payload.questionId) ||
        !isPositiveSafeInteger(payload.expectedRevision) ||
        !isPositiveSafeInteger(payload.revision) ||
        !isFiniteUtcTimestamp(payload.escalatedAt) ||
        payload.escalatedAt !== event.occurredAt)
        return invalid();
    const current = state.questions.get(payload.questionId);
    if (current === undefined)
        return notFound();
    if (current.status !== 'pending' ||
        current.answerId !== undefined ||
        current.blockingPolicy !== 'when_agent_settles')
        return conflict();
    if (payload.expectedRevision !== current.revision || payload.revision !== current.revision + 1)
        return revision();
    const item = {
        ...current,
        revision: payload.revision,
        status: 'blocking',
        updatedAt: payload.escalatedAt,
        escalatedAt: payload.escalatedAt,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: { ...state, questions: new Map(state.questions).set(item.id, item) },
        visibleChange: { kind: 'question_blocking', itemId: item.id },
    };
}
function reduceQuestionAnswered(state, event) {
    const { answer } = event.payload;
    const current = state.questions.get(event.payload.questionId);
    if (current === undefined)
        return notFound();
    if (!isAnswerable(current))
        return conflict();
    if (event.payload.expectedRevision !== current.revision ||
        answer.questionRevision !== current.revision)
        return revision();
    if (!isAnswerId(answer.id) ||
        state.answers.has(answer.id) ||
        answer.questionId !== current.id ||
        answer.questionDisplayId !== current.displayId ||
        !isFiniteUtcTimestamp(answer.answeredAt) ||
        answer.answeredAt !== event.occurredAt ||
        !['manual', 'recommendation'].includes(answer.source) ||
        !validAnswerValue(answer.value, current) ||
        (answer.source === 'recommendation' && !answerMatchesRecommendation(answer.value, current)))
        return conflict();
    const record = {
        ...answer,
        deliveryStatus: 'recorded',
        deliveryAttempts: [],
        lastEventId: event.eventId,
    };
    const question = {
        ...current,
        status: 'answered',
        updatedAt: answer.answeredAt,
        answerId: answer.id,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: {
            ...state,
            answers: new Map(state.answers).set(answer.id, record),
            questions: new Map(state.questions).set(question.id, question),
        },
        visibleChange: { kind: 'question_answered', itemId: question.id },
    };
}
function reduceDelivery(state, event, outcome) {
    const payload = event.payload;
    if (!isAnswerId(payload.answerId) ||
        !isQuestionId(payload.questionId) ||
        !isPositiveSafeInteger(payload.attempt) ||
        !isFiniteUtcTimestamp(payload.at) ||
        payload.at !== event.occurredAt ||
        !['steer', 'followUp', 'nextTurn'].includes(payload.mode))
        return invalid();
    if (outcome === 'failed' &&
        (event.eventType !== 'answer.delivery_failed' ||
            event.payload.errorCode !== 'SB_DELIVERY_FAILED' ||
            !['host_rejected', 'runtime_unavailable', 'unknown'].includes(event.payload.errorCategory)))
        return invalid();
    const answer = state.answers.get(payload.answerId);
    const question = state.questions.get(payload.questionId);
    if (answer === undefined || question === undefined)
        return notFound();
    if (answer.questionId !== question.id ||
        question.answerId !== answer.id ||
        state.acknowledgements.has(answer.id) ||
        question.deliveryMode !== payload.mode)
        return conflict();
    if (!['recorded', 'failed'].includes(answer.deliveryStatus) ||
        payload.attempt !== answer.deliveryAttempts.length + 1)
        return conflict();
    const attempt = event.eventType === 'answer.delivery_queued'
        ? { attempt: payload.attempt, at: payload.at, mode: payload.mode, outcome: 'queued' }
        : {
            attempt: payload.attempt,
            at: payload.at,
            mode: payload.mode,
            outcome: 'failed',
            errorCode: event.payload.errorCode,
            errorCategory: event.payload.errorCategory,
        };
    const nextAnswer = {
        ...answer,
        deliveryStatus: outcome,
        deliveryAttempts: [...answer.deliveryAttempts, attempt],
        lastEventId: event.eventId,
    };
    const nextQuestion = {
        ...question,
        status: outcome === 'queued' ? 'delivery_queued' : 'delivery_failed',
        updatedAt: payload.at,
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: {
            ...state,
            answers: new Map(state.answers).set(answer.id, nextAnswer),
            questions: new Map(state.questions).set(question.id, nextQuestion),
        },
        visibleChange: {
            kind: outcome === 'queued' ? 'question_changed' : 'delivery_failed',
            itemId: question.id,
        },
    };
}
function reduceAcknowledged(state, event) {
    const acknowledgement = event.payload.acknowledgement;
    if (!isAnswerId(acknowledgement.answerId) ||
        !isQuestionId(acknowledgement.questionId) ||
        !['applied', 'partially_applied', 'cannot_apply', 'duplicate', 'superseded'].includes(acknowledgement.outcome) ||
        typeof acknowledgement.summary !== 'string' ||
        acknowledgement.summary.length === 0 ||
        !isFiniteUtcTimestamp(acknowledgement.acknowledgedAt) ||
        acknowledgement.acknowledgedAt !== event.occurredAt ||
        !Array.isArray(acknowledgement.resultingUpdateIds) ||
        new Set(acknowledgement.resultingUpdateIds).size !==
            acknowledgement.resultingUpdateIds.length ||
        !acknowledgement.resultingUpdateIds.every((id) => isUpdateId(id) && state.updates.has(id)) ||
        !validAttachments(acknowledgement.attachments))
        return invalid();
    const answer = state.answers.get(acknowledgement.answerId);
    const question = state.questions.get(acknowledgement.questionId);
    if (answer === undefined || question === undefined)
        return notFound();
    if (answer.questionId !== question.id ||
        question.answerId !== answer.id ||
        state.acknowledgements.has(answer.id) ||
        answer.deliveryAttempts.length === 0 ||
        question.status !== 'delivery_queued')
        return conflict();
    const makesDecision = acknowledgement.outcome === 'applied' || acknowledgement.outcome === 'superseded';
    const resolved = makesDecision || acknowledgement.outcome === 'duplicate';
    const record = {
        ...acknowledgement,
        eventId: event.eventId,
        commandId: event.commandId,
        ...(makesDecision ? { decisionDisplayId: decisionDisplayId(state.counters.nextDecision) } : {}),
    };
    const nextAnswer = {
        ...answer,
        deliveryStatus: 'acknowledged',
        lastEventId: event.eventId,
    };
    const nextQuestion = {
        ...question,
        status: resolved ? 'resolved' : 'needs_attention',
        updatedAt: acknowledgement.acknowledgedAt,
        ...(resolved ? { resolvedAt: acknowledgement.acknowledgedAt } : {}),
        lastEventId: event.eventId,
        lastCommandId: event.commandId,
    };
    return {
        state: {
            ...state,
            answers: new Map(state.answers).set(answer.id, nextAnswer),
            questions: new Map(state.questions).set(question.id, nextQuestion),
            acknowledgements: new Map(state.acknowledgements).set(answer.id, record),
            counters: {
                ...state.counters,
                nextDecision: makesDecision ? state.counters.nextDecision + 1 : state.counters.nextDecision,
            },
        },
        visibleChange: {
            kind: resolved ? 'answer_applied' : 'answer_needs_attention',
            itemId: question.id,
        },
    };
}
function reduceViewed(state, event) {
    if (!isFiniteUtcTimestamp(event.payload.cutoffAt) ||
        Date.parse(event.payload.cutoffAt) > Date.parse(event.occurredAt) ||
        (state.lastViewedAt !== undefined &&
            Date.parse(event.payload.cutoffAt) < Date.parse(state.lastViewedAt)))
        return conflict();
    return {
        state: { ...state, lastViewedAt: event.payload.cutoffAt },
        visibleChange: { kind: 'board_viewed' },
    };
}
function reduceReset(event) {
    if (!isFiniteUtcTimestamp(event.payload.resetAt) ||
        event.payload.resetAt !== event.occurredAt ||
        typeof event.payload.reason !== 'string' ||
        event.payload.reason.length === 0)
        return invalid();
    return { state: createStateAfterReset(event), visibleChange: { kind: 'board_reset' } };
}
function recordAccepted(state, event, fingerprint, visibleChange) {
    if (event.eventType === 'board.reset')
        return state;
    const shouldRecord = 'itemId' in visibleChange && event.eventType !== 'answer.delivery_queued';
    const visibleChanges = shouldRecord
        ? [
            ...state.visibleChanges,
            {
                eventId: event.eventId,
                occurredAt: event.occurredAt,
                change: visibleChange,
            },
        ]
        : state.visibleChanges;
    return freezeClone({
        ...state,
        commandResults: new Map(state.commandResults).set(event.commandId, {
            eventId: event.eventId,
            eventType: event.eventType,
            semanticPayload: event.payload,
        }),
        acceptedEventIds: new Map(state.acceptedEventIds).set(event.eventId, fingerprint),
        visibleChanges,
        replay: { ...state.replay, acceptedEvents: state.replay.acceptedEvents + 1 },
    });
}
function commandMatchesActor(event) {
    return event.actor === 'agent'
        ? event.commandId.startsWith('tool:')
        : event.actor === 'user'
            ? event.commandId.startsWith('ui:')
            : event.commandId.startsWith('system:');
}
function normalizedUpdateFields(payload) {
    return payload.fields.kind === 'completed' && payload.fields.stage === undefined
        ? { ...payload.fields, stage: 'complete' }
        : payload.fields;
}
function updateSemantic(item) {
    return {
        ...(item.key === undefined ? {} : { key: item.key }),
        kind: item.kind,
        title: item.title,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.stage === undefined ? {} : { stage: item.stage }),
        ...(item.progress === undefined ? {} : { progress: item.progress }),
        attachments: item.attachments,
    };
}
function questionSemantic(item) {
    return {
        question: item.question,
        reason: item.reason,
        class: item.class,
        response: item.response,
        ...(item.recommendation === undefined ? {} : { recommendation: item.recommendation }),
        recommendedOptionIds: item.recommendedOptionIds,
        ...(item.recommendedText === undefined ? {} : { recommendedText: item.recommendedText }),
        ...(item.temporaryDefault === undefined ? {} : { temporaryDefault: item.temporaryDefault }),
        priority: item.priority,
        blockingPolicy: item.blockingPolicy,
        deliveryMode: item.deliveryMode,
        affectedWork: item.affectedWork,
        continuingWork: item.continuingWork,
        attachments: item.attachments,
        ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
    };
}
function hasActiveUpdateKey(state, key, except) {
    return (key !== undefined &&
        [...state.updates.values()].some((item) => item.id !== except && !item.archived && item.key === key));
}
function isAnswerable(question) {
    return ((question.status === 'pending' || question.status === 'blocking') &&
        question.answerId === undefined);
}
function success(state, visibleChange, idempotent) {
    return Object.freeze({ ok: true, state, visibleChange: freezeClone(visibleChange), idempotent });
}
function reject(code, reason) {
    return Object.freeze({ ok: false, code, reason });
}
function invalid() {
    return reject('SB_INVALID_ARGUMENT', REDUCER_REJECT_REASONS.invalidEvent);
}
function conflict() {
    return reject('SB_STATE_CONFLICT', REDUCER_REJECT_REASONS.conflict);
}
function revision() {
    return reject('SB_REVISION_MISMATCH', REDUCER_REJECT_REASONS.revision);
}
function notFound() {
    return reject('SB_NOT_FOUND', REDUCER_REJECT_REASONS.notFound);
}
function freezeClone(value) {
    return freezeValue(cloneValue(value));
}
function cloneValue(value, seen = new Map()) {
    if (typeof value !== 'object' || value === null)
        return value;
    const prior = seen.get(value);
    if (prior !== undefined)
        return prior;
    if (value instanceof MutationResistantMap) {
        const copy = new Map();
        seen.set(value, copy);
        for (const [key, child] of value)
            copy.set(cloneValue(key, seen), cloneValue(child, seen));
        return copy;
    }
    if (value instanceof Map) {
        const copy = new Map();
        seen.set(value, copy);
        for (const [key, child] of value)
            copy.set(cloneValue(key, seen), cloneValue(child, seen));
        return copy;
    }
    if (Array.isArray(value)) {
        const copy = [];
        seen.set(value, copy);
        for (const child of value)
            copy.push(cloneValue(child, seen));
        return copy;
    }
    const copy = {};
    seen.set(value, copy);
    for (const [key, child] of Object.entries(value))
        copy[key] = cloneValue(child, seen);
    return copy;
}
function freezeValue(value, seen = new Map()) {
    if (typeof value !== 'object' || value === null)
        return value;
    const prior = seen.get(value);
    if (prior !== undefined)
        return prior;
    if (value instanceof Map) {
        const frozenEntries = new Map();
        seen.set(value, frozenEntries);
        for (const [key, child] of value) {
            frozenEntries.set(freezeValue(key, seen), freezeValue(child, seen));
        }
        const readonly = mutationResistantMap(frozenEntries);
        seen.set(value, readonly);
        return readonly;
    }
    seen.set(value, value);
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            value[index] = freezeValue(value[index], seen);
        }
    }
    else {
        const record = value;
        for (const [key, child] of Object.entries(record))
            record[key] = freezeValue(child, seen);
    }
    return Object.freeze(value);
}
/** A non-Map facade prevents Map.prototype mutation calls from reaching the hidden backing map. */
class MutationResistantMap {
    entriesSnapshot;
    #backing;
    constructor(entries) {
        const snapshot = [...entries].map(([key, value]) => Object.freeze([key, value]));
        this.entriesSnapshot = Object.freeze(snapshot);
        this.#backing = new Map(snapshot);
        Object.freeze(this);
    }
    get size() {
        return this.#backing.size;
    }
    get(key) {
        return this.#backing.get(key);
    }
    has(key) {
        return this.#backing.has(key);
    }
    entries() {
        return this.#backing.entries();
    }
    keys() {
        return this.#backing.keys();
    }
    values() {
        return this.#backing.values();
    }
    forEach(callback, thisArg) {
        this.#backing.forEach((value, key) => {
            callback.call(thisArg, value, key, this);
        });
    }
    [Symbol.iterator]() {
        return this.entries();
    }
    set(_key, _value) {
        throw new TypeError('Signals state maps are read-only.');
    }
    delete(_key) {
        throw new TypeError('Signals state maps are read-only.');
    }
    clear() {
        throw new TypeError('Signals state maps are read-only.');
    }
}
function mutationResistantMap(target) {
    return new MutationResistantMap(target);
}
