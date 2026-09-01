/** Freeze every nested object and array without changing its values. */
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}
const defaults = {
    schemaVersion: 1,
    enabled: true,
    widget: {
        enabled: true,
        placement: 'aboveEditor',
        maxItems: 4,
        showCompletedForMinutes: 10,
        hideWhenClear: true,
    },
    status: {
        enabled: true,
        hideWhenClear: true,
    },
    notifications: {
        highPriorityQuestion: true,
        questionEscalated: true,
        deliveryFailed: true,
        normalQuestion: false,
        updateCompleted: false,
    },
    questions: {
        defaultDeliveryMode: 'steer',
        defaultBlockingPolicy: 'when_agent_settles',
        recoveryDeliveryOnStart: true,
    },
    limits: {
        maxActiveUpdates: 50,
        maxActionableQuestions: 20,
        visibleHistoryLimit: 500,
        maxUpdateMutationsPerTurn: 12,
        maxQuestionMutationsPerTurn: 5,
        maxAcknowledgementsPerTurn: 20,
    },
    ui: {
        wideLayoutMinimumColumns: 100,
        minimumColumns: 50,
        showRelativeTime: true,
    },
    debug: {
        enabled: false,
        showAnswerMessages: false,
    },
};
/** Normative version-1 defaults. This object is deeply immutable. */
export const DEFAULT_CONFIG = deepFreeze(defaults);
