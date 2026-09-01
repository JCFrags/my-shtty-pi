import { ERROR_DEFINITIONS, fail, signalBoardError, succeed, } from '../domain/errors.js';
/** Copy the complete immutable writer identity when a board action opens. */
export function captureBoardAction(runtime, action) {
    const capturedRuntime = Object.freeze({ ...runtime });
    if (action.type === 'archive_update') {
        return Object.freeze({
            intent: action.type,
            entityType: 'update',
            entityId: action.entityId,
            expectedRevision: action.expectedRevision,
            runtime: capturedRuntime,
        });
    }
    if (action.type === 'retry_delivery') {
        if (action.answerId === undefined)
            throw new Error('Retry action has no answer identity.');
        return Object.freeze({
            intent: action.type,
            entityType: 'question',
            entityId: action.entityId,
            expectedRevision: action.expectedRevision,
            answerId: action.answerId,
            runtime: capturedRuntime,
        });
    }
    return Object.freeze({
        intent: action.type,
        entityType: 'question',
        entityId: action.entityId,
        expectedRevision: action.expectedRevision,
        runtime: capturedRuntime,
    });
}
/**
 * One writer boundary for every board mutation intent.
 *
 * Dialogs run before this boundary. The final preflight and accepted locked
 * service call run in the lifecycle queue as one operation.
 */
export class BoardActionCoordinator {
    #lifecycle;
    constructor(lifecycle) {
        this.#lifecycle = lifecycle;
    }
    run(capture, mutationLocked) {
        return this.#lifecycle.queue.run(async () => {
            const runtime = this.#lifecycle.slot.current();
            if (!sameRuntime(runtime, capture.runtime)) {
                return fail(signalBoardError('SB_STATE_CONFLICT'));
            }
            const entity = capture.entityType === 'question'
                ? runtime.state.questions.get(capture.entityId)
                : runtime.state.updates.get(capture.entityId);
            if (entity === undefined)
                return fail(signalBoardError('SB_NOT_FOUND'));
            if (entity.revision !== capture.expectedRevision) {
                return fail(signalBoardError('SB_REVISION_MISMATCH'));
            }
            if (!statePermits(capture, entity))
                return fail(signalBoardError('SB_STATE_CONFLICT'));
            try {
                return await mutationLocked(runtime, entity);
            }
            catch {
                return fail(Object.freeze({
                    code: 'SB_INTERNAL',
                    message: ERROR_DEFINITIONS.SB_INTERNAL.message,
                    retryable: ERROR_DEFINITIONS.SB_INTERNAL.retryable,
                }));
            }
        });
    }
    /** Run the same preflight for an intent whose mutation service is not in this slice. */
    preflight(capture) {
        return this.run(capture, () => succeed(undefined));
    }
}
function sameRuntime(runtime, captured) {
    return (runtime !== undefined &&
        !runtime.disposed &&
        runtime.status === 'healthy' &&
        runtime.compatibility.supported &&
        runtime.generation === captured.generation &&
        runtime.identity.token === captured.identityToken &&
        runtime.treeRevision === captured.treeRevision);
}
function statePermits(capture, entity) {
    if (capture.entityType === 'update') {
        const update = entity;
        return !update.archived && (update.kind === 'completed' || update.kind === 'failed');
    }
    const question = entity;
    if (capture.intent === 'retry_delivery') {
        return question.status === 'delivery_failed' && question.answerId === capture.answerId;
    }
    return ((question.status === 'pending' || question.status === 'blocking') &&
        question.answerId === undefined);
}
