import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Text } from '@earendil-works/pi-tui';
import { registerSignalBoardShortcut, } from './commands/shortcut-registration.js';
import { handleSignalBoardOpen, registerSignalBoardCommand, } from './commands/signalboard-command.js';
import { loadConfiguration } from './config/loader.js';
import { ANSWER_CUSTOM_TYPE, COMMAND_INVOCATION } from './constants.js';
import { ERROR_DEFINITIONS } from './domain/errors.js';
import { RuntimeIdGenerator } from './domain/ids.js';
import { registerAskUserDeferredProviderV1, } from './integration/ask-user-deferred-provider.js';
import { evaluateCurrentHostCompatibility } from './integration/compatibility.js';
import { registerAgentBoardEventBus, } from './integration/event-bus.js';
import { DEFAULT_REPLAY_ADAPTER, RuntimeLifecycle, } from './integration/lifecycle.js';
import { createPiSessionStore } from './persistence/pi-session-store.js';
import { projectRecommendationAnswer } from './questions/validation/index.js';
import { TurnAcknowledgementRateCounter } from './services/acknowledgement-rate-counter.js';
import { AcknowledgementService } from './services/acknowledgement-service.js';
import { AnswerDeliveryService } from './services/answer-delivery-service.js';
import { AnswerPersistenceService } from './services/answer-persistence-service.js';
import { BoardViewCheckpointService } from './services/board-view-checkpoint-service.js';
import { ExpiryService } from './services/expiry-service.js';
import { QuestionEscalationService } from './services/question-escalation-service.js';
import { TurnQuestionRateCounter } from './services/question-rate-counter.js';
import { QuestionService } from './services/question-service.js';
import { TurnUpdateRateCounter } from './services/update-rate-counter.js';
import { UpdateService } from './services/update-service.js';
import { registerAckTool } from './tools/ack-tool.js';
import { registerQuestionTool } from './tools/question-tool.js';
import { PendingToolFailures, patchPendingToolFailure, registerUpdateTool, } from './tools/update-tool.js';
import { completionWindowCutoff, createSignalBoardUiAdapter } from './ui/adapter.js';
const DEFAULT_ADAPTERS = {
    evaluateCompatibility: evaluateCurrentHostCompatibility,
    loadConfig: loadConfiguration,
    now: () => new Date(),
    effectiveCommand: () => COMMAND_INVOCATION,
    writePrint: (text) => process.stdout.write(`${text}\n`),
    replay: DEFAULT_REPLAY_ADAPTER,
    hooks: Object.freeze({}),
    expiryTimers: {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle),
    },
};
function safeEmit(context, text, writePrint) {
    if (context.mode === 'print') {
        try {
            writePrint(text);
        }
        catch {
            // A failed print stream must not escape the command boundary.
        }
    }
    try {
        context.ui.notify(text, 'info');
    }
    catch {
        // A failed UI surface must not escape the command boundary.
    }
}
/** Build the extension factory with deterministic host and lifecycle adapters. */
export function createSignalBoardExtension(overrides = {}) {
    return (pi) => {
        let lifecycle;
        let shortcutRegistration = Object.freeze({
            availability: 'available',
        });
        let eventBusRegistration;
        let askUserProviderRegistration;
        let resolveEffectiveCommand = (runtime) => {
            const invocation = overrides.effectiveCommand?.(runtime) ?? COMMAND_INVOCATION;
            return {
                baseName: 'signals',
                invocationName: invocation.replace(/^\//u, ''),
                invocation,
                discovered: false,
                collision: invocation !== COMMAND_INVOCATION,
                ambiguous: false,
            };
        };
        const adapters = {
            ...DEFAULT_ADAPTERS,
            ...overrides,
            effectiveCommand: overrides.effectiveCommand ?? ((runtime) => resolveEffectiveCommand(runtime).invocation),
        };
        const hooks = {
            ...adapters.hooks,
            async evaluateExpiryLocked(runtime) {
                recordShortcutConflictOnce(runtime, shortcutRegistration, adapters.now);
                constructRuntimeServices(runtime, pi, lifecycle, adapters, () => eventBusRegistration?.notifyCommittedChange());
                await runtime.expiryService?.evaluateExpiryLocked(adapters.now());
                await adapters.hooks.evaluateExpiryLocked?.(runtime);
            },
            async resetTurnRateCountersLocked(runtime) {
                runtime.updateRateCounter?.reset();
                runtime.questionRateCounter?.reset();
                runtime.acknowledgementRateCounter?.reset();
                await adapters.hooks.resetTurnRateCountersLocked?.(runtime);
            },
            async onTimerLocked(runtime) {
                await runtime.expiryService?.evaluateExpiryLocked(adapters.now());
                await adapters.hooks.onTimerLocked?.(runtime);
            },
            armTimerLocked(runtime, callback) {
                if (adapters.hooks.armTimerLocked !== undefined) {
                    return adapters.hooks.armTimerLocked(runtime, callback);
                }
                return runtime.expiryService?.armNearestTimerLocked(callback);
            },
            clearTimer(handle) {
                if (adapters.hooks.armTimerLocked !== undefined) {
                    if (adapters.hooks.clearTimer !== undefined) {
                        adapters.hooks.clearTimer(handle);
                    }
                    else {
                        safeClearExpiryHandle(adapters.expiryTimers, handle);
                    }
                    return;
                }
                const current = lifecycle.slot.current();
                if (current !== undefined &&
                    current.timer === handle &&
                    current.expiryService !== undefined) {
                    current.expiryService.clearTimerLocked();
                    return;
                }
                safeClearExpiryHandle(adapters.expiryTimers, handle);
            },
            async recoverDeliveryLocked(runtime) {
                constructRuntimeServices(runtime, pi, lifecycle, adapters, () => eventBusRegistration?.notifyCommittedChange());
                const result = await runtime.answerDeliveryService?.recoverLocked();
                if (result !== undefined && !result.ok) {
                    runtime.diagnostics.record({
                        at: safeAdapterTimestamp(adapters.now),
                        code: result.error.code,
                        severity: 'error',
                        area: result.error.code === 'SB_PERSISTENCE_FAILED' ? 'persistence' : 'delivery',
                        category: result.error.code === 'SB_PERSISTENCE_FAILED' ? 'append_rejected' : 'host_rejected',
                    });
                }
                await adapters.hooks.recoverDeliveryLocked?.(runtime);
            },
            async escalateConditionalQuestionsLocked(runtime) {
                constructRuntimeServices(runtime, pi, lifecycle, adapters, () => eventBusRegistration?.notifyCommittedChange());
                const result = await runtime.questionEscalationService?.escalateConditionalQuestionsLocked(safeAdapterTimestamp(adapters.now));
                if (result !== undefined && !result.ok) {
                    runtime.diagnostics.record({
                        at: safeAdapterTimestamp(adapters.now),
                        code: result.error.code,
                        severity: 'error',
                        area: result.error.code === 'SB_PERSISTENCE_FAILED' ? 'persistence' : 'lifecycle',
                        category: result.error.code === 'SB_PERSISTENCE_FAILED' ? 'append_rejected' : 'unexpected',
                    });
                }
                await adapters.hooks.escalateConditionalQuestionsLocked?.(runtime);
            },
            async refreshLocked(runtime) {
                await adapters.hooks.refreshLocked?.(runtime);
                refreshRuntimeUi(runtime, adapters);
            },
        };
        lifecycle = new RuntimeLifecycle({
            evaluateCompatibility: adapters.evaluateCompatibility,
            loadConfig: adapters.loadConfig,
            replay: adapters.replay,
            now: adapters.now,
            hooks,
        });
        adapters.captureLifecycle?.(lifecycle);
        registerStaticRenderers(pi);
        const pendingFailures = new PendingToolFailures();
        registerStaticTools(pi, lifecycle, pendingFailures);
        pi.on('tool_result', (event) => patchPendingToolFailure(event, pendingFailures));
        pi.on('session_start', () => pendingFailures.clear());
        pi.on('session_shutdown', () => pendingFailures.clear());
        const commandDependencies = {
            lifecycle,
            now: adapters.now,
            emit: (context, text) => safeEmit(context, text, adapters.writePrint),
            ownEntryPath: fileURLToPath(import.meta.url),
            shortcutAvailability: () => shortcutRegistration.availability,
        };
        resolveEffectiveCommand = registerSignalBoardCommand(pi, commandDependencies);
        shortcutRegistration = registerSignalBoardShortcut(pi, {
            openBoard: (context) => handleSignalBoardOpen(context, commandDependencies, resolveEffectiveCommand),
            onFailure: (context) => safeEmit(context, 'Signals command failed safely (SB_INTERNAL). No state changed.', adapters.writePrint),
        });
        lifecycle.register(pi);
        const eventBusActions = {
            now: () => adapters.now().toISOString(),
            openUi: async () => {
                const current = lifecycle.slot.current();
                if (current === undefined)
                    return {
                        ok: false,
                        error: {
                            code: 'SB_NOT_INITIALIZED',
                            message: 'Signals is not initialized.',
                            retryable: true,
                        },
                    };
                await handleSignalBoardOpen(current.context, commandDependencies, resolveEffectiveCommand);
                return { ok: true };
            },
            answerQuestion: async (request) => {
                const result = await lifecycle.runHealthy(async (runtime) => {
                    constructRuntimeServices(runtime, pi, lifecycle, adapters, () => eventBusRegistration?.notifyCommittedChange());
                    const persistence = runtime.answerPersistenceService;
                    const delivery = runtime.answerDeliveryService;
                    const ids = runtime.ids;
                    if (persistence === undefined || delivery === undefined || ids === undefined)
                        return {
                            ok: false,
                            error: {
                                code: 'SB_NOT_INITIALIZED',
                                message: 'Signals is not initialized.',
                                retryable: true,
                            },
                        };
                    const saved = await persistence.answerQuestionLocked({
                        commandId: ids.command(),
                        questionId: request.questionId,
                        expectedRevision: request.expectedRevision,
                        source: request.source,
                        value: request.value,
                    });
                    if (!saved.ok)
                        return { ok: false, error: saved.error };
                    const sent = await delivery.deliverLocked(saved.value.answer.id);
                    return sent.ok
                        ? { ok: true, answerId: saved.value.answer.id }
                        : { ok: false, error: sent.error };
                });
                return result.ok ? result.value : { ok: false, error: result.error };
            },
            providerAction: async (request) => {
                const result = await lifecycle.runHealthy(async (runtime) => {
                    constructRuntimeServices(runtime, pi, lifecycle, adapters, () => eventBusRegistration?.notifyCommittedChange());
                    const ids = runtime.ids;
                    if (ids === undefined)
                        return {
                            ok: false,
                            error: {
                                code: 'SB_NOT_INITIALIZED',
                                message: 'Signals is not initialized.',
                                retryable: true,
                            },
                        };
                    if (request.action === 'answer-question' || request.action === 'accept-recommendation') {
                        const question = runtime.state.questions.get(request.questionId);
                        const value = request.action === 'accept-recommendation'
                            ? question === undefined
                                ? undefined
                                : projectRecommendationAnswer(question)
                            : request.value;
                        if (value === undefined)
                            return {
                                ok: false,
                                error: {
                                    code: 'SB_INVALID_ARGUMENT',
                                    message: 'A valid answer value is required.',
                                    retryable: false,
                                },
                            };
                        const saved = await runtime.answerPersistenceService?.answerQuestionLocked({
                            commandId: ids.command(),
                            questionId: request.questionId,
                            expectedRevision: request.expectedRevision,
                            source: request.action === 'accept-recommendation' ? 'recommendation' : 'manual',
                            value,
                        });
                        if (saved === undefined || !saved.ok)
                            return saved === undefined
                                ? {
                                    ok: false,
                                    error: {
                                        code: 'SB_NOT_INITIALIZED',
                                        message: 'Answer service is unavailable.',
                                        retryable: true,
                                    },
                                }
                                : { ok: false, error: saved.error };
                        const sent = await runtime.answerDeliveryService?.deliverLocked(saved.value.answer.id);
                        if (sent === undefined || !sent.ok)
                            return sent === undefined
                                ? {
                                    ok: false,
                                    error: {
                                        code: 'SB_NOT_INITIALIZED',
                                        message: 'Delivery service is unavailable.',
                                        retryable: true,
                                    },
                                }
                                : { ok: false, error: sent.error };
                        return { ok: true, value: { answerId: saved.value.answer.id } };
                    }
                    if (request.action === 'retry-delivery') {
                        const sent = await runtime.answerDeliveryService?.deliverLocked(request.answerId);
                        return sent === undefined
                            ? {
                                ok: false,
                                error: {
                                    code: 'SB_NOT_INITIALIZED',
                                    message: 'Delivery service is unavailable.',
                                    retryable: true,
                                },
                            }
                            : sent.ok
                                ? { ok: true, value: { answerId: sent.value.answer.id } }
                                : { ok: false, error: sent.error };
                    }
                    if (request.action === 'dismiss-question') {
                        const dismissed = await runtime.questionService?.dismissQuestionLocked({
                            commandId: ids.command(),
                            id: request.questionId,
                            expectedRevision: request.expectedRevision,
                            dismissedAt: adapters.now().toISOString(),
                            reason: 'user_dismissed',
                            source: 'board',
                        });
                        return dismissed === undefined
                            ? {
                                ok: false,
                                error: {
                                    code: 'SB_NOT_INITIALIZED',
                                    message: 'Question service is unavailable.',
                                    retryable: true,
                                },
                            }
                            : dismissed.ok
                                ? { ok: true }
                                : { ok: false, error: dismissed.error };
                    }
                    if (request.action === 'archive-update') {
                        const archived = await runtime.updateService?.archiveFromUiLocked({
                            commandId: ids.command(),
                            id: request.updateId,
                            expectedRevision: request.expectedRevision,
                            archivedAt: adapters.now().toISOString(),
                            source: 'board',
                        });
                        return archived === undefined
                            ? {
                                ok: false,
                                error: {
                                    code: 'SB_NOT_INITIALIZED',
                                    message: 'Update service is unavailable.',
                                    retryable: true,
                                },
                            }
                            : archived.ok
                                ? { ok: true }
                                : { ok: false, error: archived.error };
                    }
                    const ackRequest = request;
                    const acknowledged = await runtime.acknowledgementService?.acknowledgeLocked({
                        commandId: `tool:side-panel:${randomUUID()}`,
                        answerId: ackRequest.answerId,
                        outcome: ackRequest.outcome,
                        summary: ackRequest.summary,
                        ...(ackRequest.resultingUpdateIds === undefined
                            ? {}
                            : { resultingUpdateIds: ackRequest.resultingUpdateIds }),
                        ...(ackRequest.attachments === undefined
                            ? {}
                            : { attachments: ackRequest.attachments }),
                    });
                    return acknowledged === undefined
                        ? {
                            ok: false,
                            error: {
                                code: 'SB_NOT_INITIALIZED',
                                message: 'Acknowledgement service is unavailable.',
                                retryable: true,
                            },
                        }
                        : acknowledged.ok
                            ? {
                                ok: true,
                                value: {
                                    answerId: acknowledged.value.acknowledgement.answerId,
                                    outcome: acknowledged.value.acknowledgement.outcome,
                                },
                            }
                            : { ok: false, error: acknowledged.error };
                });
                return result.ok ? result.value : { ok: false, error: result.error };
            },
        };
        eventBusRegistration = registerAgentBoardEventBus(pi.events, () => lifecycle.slot.current(), eventBusActions);
        askUserProviderRegistration = registerAskUserDeferredProviderV1(pi.events, {
            createQuestion: async (command) => {
                const access = lifecycle.slot.requireHealthyLocked();
                if (!access.ok)
                    return { ok: false, error: runtimeProviderError(access.error.code) };
                const service = access.value.questionService;
                return service === undefined
                    ? { ok: false, error: runtimeProviderError('SB_NOT_INITIALIZED') }
                    : service.createQuestion(command);
            },
            cancelQuestion: async (command) => {
                const access = lifecycle.slot.requireHealthyLocked();
                if (!access.ok)
                    return { ok: false, error: runtimeProviderError(access.error.code) };
                const service = access.value.questionService;
                return service === undefined
                    ? { ok: false, error: runtimeProviderError('SB_NOT_INITIALIZED') }
                    : service.cancelQuestion(command);
            },
        });
        // /reload can evaluate this extension after the active session_start event.
        // Start the same-process provider contract now as well as on future sessions.
        eventBusRegistration.start();
        pi.on('session_start', () => {
            askUserProviderRegistration?.reset();
            eventBusRegistration?.start();
        });
        pi.on('session_tree', () => askUserProviderRegistration?.reset());
        pi.on('session_shutdown', () => {
            askUserProviderRegistration?.shutdown();
            askUserProviderRegistration = undefined;
            eventBusRegistration?.shutdown();
            eventBusRegistration = undefined;
        });
    };
}
function runtimeProviderError(code) {
    const publicCode = code === 'SB_DISABLED' ? 'SB_CONFIG_DISABLED' : code;
    const definition = ERROR_DEFINITIONS[publicCode];
    return Object.freeze({
        code: publicCode,
        message: definition.message,
        retryable: definition.retryable,
    });
}
function recordShortcutConflictOnce(runtime, registration, now) {
    if (registration.availability === 'available' || runtime.notifications.has('shortcut-conflict')) {
        return;
    }
    runtime.notifications.add('shortcut-conflict');
    runtime.diagnostics.record({
        at: safeAdapterTimestamp(now),
        code: 'SB_UI_UNAVAILABLE',
        severity: 'warning',
        area: 'ui',
        category: 'host_rejected',
    });
}
function registerStaticTools(pi, lifecycle, pendingFailures) {
    registerUpdateTool(pi, lifecycle, pendingFailures);
    registerQuestionTool(pi, lifecycle, pendingFailures);
    registerAckTool(pi, lifecycle, pendingFailures);
}
function constructRuntimeServices(runtime, pi, lifecycle, adapters, notifyCommittedChange) {
    if (runtime.updateService !== undefined)
        return;
    runtime.ui ??= createSignalBoardUiAdapter(runtime.context, runtime.diagnostics);
    const ids = new RuntimeIdGenerator();
    const rateCounter = new TurnUpdateRateCounter();
    const questionRateCounter = new TurnQuestionRateCounter();
    const acknowledgementRateCounter = new TurnAcknowledgementRateCounter();
    const sessionStore = createPiSessionStore(pi, {
        correlationIds: { nextCorrelationId: () => randomUUID() },
        at: () => adapters.now().toISOString(),
        diagnostics: runtime.diagnostics,
    });
    const generation = runtime.generation;
    const requireCurrent = () => {
        const current = lifecycle.slot.current();
        if (current?.generation !== generation || current.disposed || current.status !== 'healthy') {
            throw new Error('Stale Signals runtime.');
        }
        return current;
    };
    runtime.ids = ids;
    runtime.updateRateCounter = rateCounter;
    runtime.questionRateCounter = questionRateCounter;
    runtime.acknowledgementRateCounter = acknowledgementRateCounter;
    runtime.sessionStore = sessionStore;
    const refresh = async () => {
        const current = requireCurrent();
        await adapters.hooks.refreshLocked?.(current);
        refreshRuntimeUi(current, adapters);
    };
    const afterMutationLocked = async () => {
        await lifecycle.mutationBoundaryLocked(requireCurrent());
        notifyCommittedChange();
    };
    runtime.boardViewCheckpointService = new BoardViewCheckpointService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutation: notifyCommittedChange,
        clock: { now: adapters.now },
        ids,
    });
    runtime.expiryService = new ExpiryService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutation: notifyCommittedChange,
        clock: { now: adapters.now },
        ids,
        timers: adapters.expiryTimers,
        recordDiagnostic: (record) => {
            requireCurrent().diagnostics.record({
                at: safeAdapterTimestamp(adapters.now),
                code: record.code,
                severity: record.code === 'SB_UI_UNAVAILABLE' ? 'warning' : 'error',
                area: record.code === 'SB_PERSISTENCE_FAILED'
                    ? 'persistence'
                    : record.code === 'SB_UI_UNAVAILABLE'
                        ? 'ui'
                        : 'lifecycle',
                category: record.category,
            });
        },
    });
    runtime.updateService = new UpdateService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutationLocked,
        clock: { now: adapters.now },
        ids,
        cwd: runtime.context.cwd,
        config: runtime.config.config,
        rateCounter,
    });
    runtime.questionService = new QuestionService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutationLocked,
        clock: { now: adapters.now },
        ids,
        cwd: runtime.context.cwd,
        config: runtime.config.config,
        rateCounter: questionRateCounter,
    });
    runtime.answerPersistenceService = new AnswerPersistenceService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutationLocked,
        clock: { now: adapters.now },
        ids,
    });
    runtime.answerDeliveryService = new AnswerDeliveryService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutationLocked,
        sendMessage: (message, options) => pi.sendMessage(message, options),
        clock: { now: adapters.now },
        ids,
        config: runtime.config.config,
    });
    runtime.acknowledgementService = new AcknowledgementService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutationLocked,
        clock: { now: adapters.now },
        ids,
        cwd: runtime.context.cwd,
        config: runtime.config.config,
        rateCounter: acknowledgementRateCounter,
    });
    runtime.questionEscalationService = new QuestionEscalationService({
        queue: lifecycle.queue,
        readState: () => requireCurrent().state,
        swapState: (state) => {
            requireCurrent().state = state;
        },
        append: (event) => sessionStore.append(event),
        refresh,
        afterMutation: notifyCommittedChange,
        notify: (message, severity) => {
            const current = requireCurrent();
            if (current.context.hasUI)
                current.context.ui.notify(message, severity);
        },
        recordPostDurableFailure: (area, at) => {
            requireCurrent().diagnostics.record({
                at,
                code: 'SB_UI_UNAVAILABLE',
                severity: 'warning',
                area: area === 'notification' ? 'lifecycle' : 'ui',
                category: 'ui_failure',
            });
        },
        clock: { now: adapters.now },
        ids,
        config: runtime.config.config,
    });
}
function refreshRuntimeUi(runtime, adapters) {
    runtime.ui ??= createSignalBoardUiAdapter(runtime.context, runtime.diagnostics);
    const currentTime = adapters.now();
    runtime.ui.refresh({
        state: runtime.state,
        config: runtime.config.config,
        currentTime: currentTime.toISOString(),
        completedWindowCutoff: completionWindowCutoff(currentTime, runtime.config.config.widget.showCompletedForMinutes),
        effectiveCommand: adapters.effectiveCommand(runtime),
    });
}
function safeClearExpiryHandle(timers, handle) {
    try {
        timers.clearTimeout(handle);
    }
    catch {
        // Timer cleanup is best-effort and content-free.
    }
}
function safeAdapterTimestamp(now) {
    try {
        return now().toISOString();
    }
    catch {
        return '1970-01-01T00:00:00.000Z';
    }
}
function registerStaticRenderers(pi) {
    pi.registerMessageRenderer(ANSWER_CUSTOM_TYPE, (_message, _options, theme) => new Text(theme.fg('muted', '[Signals answer]'), 0, 0));
}
export default function signalBoardExtension(pi) {
    createSignalBoardExtension()(pi);
}
export * from './commands/answer-actions.js';
export * from './commands/command-parser.js';
export * from './commands/signalboard-command.js';
export * from './integration/ask-user-deferred-provider.js';
export * from './integration/event-bus.js';
export { RuntimeLifecycle } from './integration/lifecycle.js';
export * from './integration/summary-api.js';
export { RuntimeSlot } from './runtime/slot.js';
export * from './services/acknowledgement-service.js';
export * from './services/answer-delivery-service.js';
export * from './services/answer-persistence-service.js';
export * from './services/board-view-checkpoint-service.js';
export * from './ui/board/component.js';
export * from './ui/board/model.js';
