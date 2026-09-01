import { COMMAND_INVOCATION, PRODUCT_NAME } from '../constants.js';
import { selectActionableQuestions, selectActiveUpdates, selectBoardCounts, selectSummary, } from '../domain/selectors.js';
import { buildBoardViewModel, } from '../ui/board/model.js';
/** Build a detached summary without coupling a consumer to Herdr or the UI. */
export function getAgentBoardSummary(runtime, limit = 10) {
    return Object.freeze({
        productName: PRODUCT_NAME,
        status: runtime.status,
        command: runtime.effectiveCommand?.invocation ?? COMMAND_INVOCATION,
        summary: selectSummary(runtime.state, limit),
    });
}
export const AGENT_BOARD_PROVIDER_MAX_ROWS = 200;
/** Build the provider contract from the same selectors and native view model. */
export function getAgentBoardProviderSnapshot(runtime, openedAt, selections = {}) {
    const native = buildBoardViewModel(runtime.state, undefined, openedAt, runtime.config.config, selections);
    const boundTabs = {
        inbox: boundTab(native.tabs.inbox),
        updates: boundTab(native.tabs.updates),
        decisions: boundTab(native.tabs.decisions),
        history: boundTab(native.tabs.history),
    };
    return Object.freeze({
        schemaVersion: 2,
        productName: PRODUCT_NAME,
        preferredCommand: runtime.effectiveCommand?.invocation ?? COMMAND_INVOCATION,
        health: runtime.status,
        openedAt,
        view: Object.freeze({ ...native, tabs: Object.freeze(boundTabs) }),
        transport: Object.freeze({
            maxRowsPerView: AGENT_BOARD_PROVIDER_MAX_ROWS,
            bounded: true,
        }),
        fallback: Object.freeze({
            openUiAction: 'open-ui',
            unsupported: Object.freeze([
                'native terminal key navigation',
                'native confirmation/editor dialogs',
            ]),
        }),
    });
}
function boundTab(tab) {
    const rows = tab.rows.slice(0, AGENT_BOARD_PROVIDER_MAX_ROWS);
    const allowed = new Set(rows.map((row) => row.id));
    const detailsById = Object.fromEntries(Object.entries(tab.detailsById).filter(([id]) => allowed.has(id)));
    return Object.freeze({
        ...tab,
        rows: Object.freeze(rows),
        visibleCount: rows.length,
        detailsById: Object.freeze(detailsById),
    });
}
const MAX_DECK_UPDATES = 10;
const MAX_PENDING_QUESTIONS = 10;
const MAX_OPTIONS = 16;
const MAX_TITLE_LENGTH = 160;
const MAX_QUESTION_LENGTH = 4000;
const MAX_OPTION_TEXT_LENGTH = 500;
/** Build the public deck snapshot without prompts, attachments, or history. */
export function getAgentBoardDeckSnapshot(runtime) {
    const state = runtime.state;
    const counts = selectBoardCounts(state, state.lastViewedAt);
    const significantActiveUpdates = selectActiveUpdates(state)
        .slice(0, MAX_DECK_UPDATES)
        .map((item) => Object.freeze({
        id: item.id,
        kind: item.kind,
        title: item.title.slice(0, MAX_TITLE_LENGTH),
        updatedAt: item.updatedAt,
    }));
    return Object.freeze({
        schemaVersion: 1,
        productName: PRODUCT_NAME,
        preferredCommand: COMMAND_INVOCATION,
        health: runtime.status,
        pendingAsyncQuestionCount: selectActionableQuestions(state).length,
        pendingQuestions: Object.freeze(selectActionableQuestions(state)
            .slice(0, MAX_PENDING_QUESTIONS)
            .map((item) => Object.freeze({
            questionId: item.id,
            revision: item.revision,
            question: item.question.slice(0, MAX_QUESTION_LENGTH),
            response: Object.freeze({
                kind: item.response.kind,
                options: Object.freeze((item.response.options ?? []).slice(0, MAX_OPTIONS).map((option) => Object.freeze({
                    id: option.id,
                    label: option.label.slice(0, MAX_OPTION_TEXT_LENGTH),
                    ...(option.description === undefined
                        ? {}
                        : { description: option.description.slice(0, MAX_OPTION_TEXT_LENGTH) }),
                }))),
            }),
            ...(item.recommendation === undefined
                ? {}
                : { recommendation: item.recommendation.slice(0, MAX_QUESTION_LENGTH) }),
            recommendedOptionIds: Object.freeze(item.recommendedOptionIds.slice(0, MAX_OPTIONS)),
            ...(item.recommendedText === undefined
                ? {}
                : { recommendedText: item.recommendedText.slice(0, MAX_QUESTION_LENGTH) }),
        }))),
        significantActiveUpdates: Object.freeze(significantActiveUpdates),
        unreadCount: counts.unread,
    });
}
