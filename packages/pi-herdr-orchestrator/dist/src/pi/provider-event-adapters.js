export const AGENT_BOARD_ACTION_REQUEST_EVENT = "pi-agent-board:action-request-v1";
export const AGENT_BOARD_ACTION_RESPONSE_EVENT = "pi-agent-board:action-response-v1";
export const AGENT_BOARD_VIEW_REQUEST_EVENT = "pi-agent-board:view-request-v2";
export const AGENT_BOARD_VIEW_RESPONSE_EVENT = "pi-agent-board:view-response-v2";
export const TODO_ACTION_REQUEST_EVENT = "pi-todo:request-action-v1";
export const TODO_ACTION_RESPONSE_EVENT = "pi-todo:action-response-v1";
export const FILES_OPEN_REQUEST_EVENT = "pi-files-ui:request-open-v1";
export const FILES_OPEN_RESPONSE_EVENT = "pi-files-ui:open-response-v1";
export const FILES_PROVIDER_REQUEST_EVENT = "pi-files-ui:provider-request-v1";
export const FILES_PROVIDER_RESPONSE_EVENT = "pi-files-ui:provider-response-v1";
export const FILES_PROVIDER_SUMMARY_EVENT = "pi-files-ui:provider-summary-v1";
export const FILES_PROVIDER_VIEW_EVENT = "pi-files-ui:provider-view-change-v1";
export class ProviderActionException extends Error {
    code;
    retryable;
    constructor(error) {
        super(error.message);
        this.name = "ProviderActionException";
        this.code = error.code;
        this.retryable = error.retryable;
    }
}
const id = () => `deck-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
export class ProviderEventAdapters {
    events;
    constructor(events) {
        this.events = events;
    }
    filesOpen() {
        return this.request(FILES_OPEN_REQUEST_EVENT, FILES_OPEN_RESPONSE_EVENT, {
            version: 1,
            requestId: id(),
        });
    }
    files(action, fields = {}) {
        return this.request(FILES_PROVIDER_REQUEST_EVENT, FILES_PROVIDER_RESPONSE_EVENT, { version: 1, requestId: id(), action, ...fields });
    }
    boardView(selections) {
        return this.request(AGENT_BOARD_VIEW_REQUEST_EVENT, AGENT_BOARD_VIEW_RESPONSE_EVENT, {
            schemaVersion: 2,
            requestId: id(),
            ...(selections ? { selections } : {}),
        });
    }
    todo(action, taskId) {
        return this.request(TODO_ACTION_REQUEST_EVENT, TODO_ACTION_RESPONSE_EVENT, { version: 1, requestId: id(), action, taskId });
    }
    agentBoardOpen(schemaVersion = 2) {
        return this.request(AGENT_BOARD_ACTION_REQUEST_EVENT, AGENT_BOARD_ACTION_RESPONSE_EVENT, { schemaVersion, requestId: id(), action: "open-ui" });
    }
    agentBoardAction(action, fields = {}) {
        return this.request(AGENT_BOARD_ACTION_REQUEST_EVENT, AGENT_BOARD_ACTION_RESPONSE_EVENT, { schemaVersion: 2, requestId: id(), action, ...fields });
    }
    agentBoardAnswer(request) {
        return this.agentBoardAction("answer-question", request);
    }
    request(requestEvent, responseEvent, payload) {
        const requestId = payload.requestId;
        return new Promise((resolve, reject) => {
            let timer;
            let deferredFailure;
            let lastFailure;
            const remove = () => {
                clearTimeout(timer);
                if (deferredFailure)
                    clearTimeout(deferredFailure);
                this.events.off?.(responseEvent, listener);
            };
            const listener = (value) => {
                if (!value ||
                    typeof value !== "object" ||
                    value.requestId !== requestId)
                    return;
                const outer = value;
                const nested = ["response", "result", "data", "payload"]
                    .map((key) => outer[key])
                    .find((item) => item && typeof item === "object" && !Array.isArray(item));
                const result = (nested ? { ...outer, ...nested } : outer);
                if (result.ok === false) {
                    const raw = result.error;
                    const error = raw && typeof raw === "object"
                        ? raw
                        : {
                            message: typeof raw === "string" ? raw : "Provider action failed.",
                        };
                    lastFailure = new ProviderActionException({
                        code: typeof error.code === "string"
                            ? error.code
                            : "PROVIDER_ACTION_FAILED",
                        message: typeof error.message === "string"
                            ? error.message
                            : "Provider action failed.",
                        retryable: typeof error.retryable === "boolean" ? error.retryable : false,
                    });
                    // Pi reloads can briefly leave an old and a new listener on the same
                    // event bus. Give the active provider a short chance to answer before
                    // a stale listener failure wins the correlated request.
                    const staleReloadListener = lastFailure.message === "No active Files provider";
                    if (!deferredFailure)
                        deferredFailure = setTimeout(() => {
                            remove();
                            reject(lastFailure);
                        }, staleReloadListener ? 1_500 : 75);
                    return;
                }
                remove();
                resolve(result);
            };
            timer = setTimeout(() => {
                remove();
                reject(lastFailure ??
                    new ProviderActionException({
                        code: "PROVIDER_ACTION_TIMEOUT",
                        message: "Provider action timed out.",
                        retryable: true,
                    }));
            }, 10_000);
            this.events.on(responseEvent, listener);
            this.events.emit(requestEvent, payload);
        });
    }
}
