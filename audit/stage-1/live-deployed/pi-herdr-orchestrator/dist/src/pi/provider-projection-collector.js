import { AGENT_BOARD_CHANGED_EVENT, AGENT_BOARD_REQUEST_EVENT, AGENT_BOARD_SUMMARY_EVENT, TODO_CHANGED_EVENT, TODO_REQUEST_EVENT, TODO_SUMMARY_EVENT, AGENT_BOARD_VIEW_CHANGED_EVENT, AGENT_BOARD_VIEW_REQUEST_EVENT, AGENT_BOARD_VIEW_RESPONSE_EVENT, FILES_PROVIDER_SUMMARY_EVENT, FILES_PROVIDER_VIEW_EVENT, FILES_PROVIDER_REQUEST_EVENT, FILES_PROVIDER_RESPONSE_EVENT, FILES_CAPABILITY_EVENT, FILES_CAPABILITY_REQUEST_EVENT, normalizeAgentBoardProjection, normalizeTodoProjection, unavailableProviderProjection, } from "../shared/provider-projections.js";
const objectRecord = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
function unwrapProviderEnvelope(value) {
    const outer = objectRecord(value);
    for (const key of ["response", "result", "data", "payload"]) {
        const nested = objectRecord(outer[key]);
        if (Object.keys(nested).length > 0)
            return { ...outer, ...nested };
    }
    return outer;
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]));
}
function semanticSignature(projection) {
    return JSON.stringify(canonical(projection));
}
export class ProviderProjectionCollector {
    #events;
    #publish;
    #projection = unavailableProviderProjection("unbound", "unbound");
    #bound = false;
    #started = false;
    #publishing = false;
    #scheduled = false;
    #dirty = false;
    #lifecycleGeneration = 0;
    #lastPublishedSignature;
    #unsubscribers = [];
    #retryTimers = [];
    #filesRequestId = "";
    #boardRequestId = "";
    #agentBoardListener = (value) => {
        this.#projection = {
            ...this.#projection,
            agentBoard: normalizeAgentBoardProjection(value),
        };
        this.queuePublish();
    };
    #boardViewListener = (value) => {
        const body = unwrapProviderEnvelope(value);
        const snapshot = body.snapshot ?? body.view ?? value;
        const snapshotBody = objectRecord(snapshot);
        this.#projection = {
            ...this.#projection,
            agentBoard: {
                ...this.#projection.agentBoard,
                available: true,
                ...(typeof snapshotBody.health === "string"
                    ? { health: snapshotBody.health }
                    : {}),
                ...(typeof snapshotBody.preferredCommand === "string"
                    ? { preferredCommand: snapshotBody.preferredCommand }
                    : {}),
                view: snapshot,
            },
        };
        this.queuePublish();
    };
    #boardViewResponseListener = (value) => {
        const body = unwrapProviderEnvelope(value);
        if (body.requestId !== this.#boardRequestId || body.snapshot === undefined)
            return;
        this.#boardViewListener(value);
    };
    #filesResponseListener = (value) => {
        const body = unwrapProviderEnvelope(value);
        if (body.requestId !== this.#filesRequestId)
            return;
        if (body.ok === false) {
            // During Pi extension reload, a stale duplicate listener can answer the
            // same correlated request after the active provider already published a
            // valid tree. Never replace a usable provider view with that stale error.
            if (this.#projection.files?.available &&
                this.#projection.files.view !== undefined)
                return;
            this.#projection = {
                ...this.#projection,
                files: {
                    ...this.#projection.files,
                    available: false,
                    error: typeof body.error === "string"
                        ? body.error
                        : "Files provider request failed.",
                },
            };
            this.queuePublish();
            return;
        }
        this.#filesListener(value);
    };
    #filesListener = (value) => {
        const body = unwrapProviderEnvelope(value);
        const files = {
            ...this.#projection.files,
            available: true,
            ...(body.capability !== undefined ? { capability: body.capability } : {}),
            ...(body.summary !== undefined ? { summary: body.summary } : {}),
            ...(body.view !== undefined ? { view: body.view } : {}),
        };
        delete files.error;
        this.#projection = { ...this.#projection, files };
        this.queuePublish();
    };
    #todoListener = (value) => {
        this.#projection = {
            ...this.#projection,
            todo: normalizeTodoProjection(value),
        };
        this.queuePublish();
    };
    constructor(events, publish) {
        this.#events = events;
        this.#publish = publish;
    }
    start() {
        if (this.#started)
            return;
        this.#started = true;
        this.#lifecycleGeneration += 1;
        this.#lastPublishedSignature = undefined;
        this.#projection = unavailableProviderProjection(this.#projection.ownerAgentId, this.#projection.piSessionId);
        if (!this.#events)
            return;
        for (const [event, listener] of [
            [AGENT_BOARD_SUMMARY_EVENT, this.#agentBoardListener],
            [AGENT_BOARD_CHANGED_EVENT, this.#agentBoardListener],
            [TODO_SUMMARY_EVENT, this.#todoListener],
            [TODO_CHANGED_EVENT, this.#todoListener],
            [AGENT_BOARD_VIEW_CHANGED_EVENT, this.#boardViewListener],
            [AGENT_BOARD_VIEW_RESPONSE_EVENT, this.#boardViewResponseListener],
            [FILES_PROVIDER_SUMMARY_EVENT, this.#filesListener],
            [FILES_PROVIDER_VIEW_EVENT, this.#filesListener],
            [FILES_PROVIDER_RESPONSE_EVENT, this.#filesResponseListener],
            [FILES_CAPABILITY_EVENT, this.#filesListener],
        ]) {
            const unsubscribe = this.#events.on(event, listener);
            if (typeof unsubscribe === "function")
                this.#unsubscribers.push(unsubscribe);
        }
        this.request();
        // Extensions can register in either order during /reload. Repeat the
        // provider discovery request after the event bus has settled.
        for (const delay of [250, 1_000, 3_000])
            this.#retryTimers.push(setTimeout(() => {
                if (this.#started)
                    this.request();
            }, delay));
    }
    bind(ownerAgentId, piSessionId) {
        this.#projection = {
            ...this.#projection,
            ownerAgentId,
            piSessionId,
        };
        this.#bound = true;
        this.queuePublish();
        if (this.#started)
            this.request();
    }
    publish() {
        this.queuePublish();
    }
    request() {
        if (!this.#events)
            return;
        const boardCallback = (summary) => this.#agentBoardListener(summary);
        const todoCallback = (summary) => this.#todoListener(summary);
        this.#events.emit(AGENT_BOARD_REQUEST_EVENT, {
            schemaVersion: 1,
            requestId: "pi-herdr-orchestrator",
            callback: boardCallback,
            respond: boardCallback,
        });
        this.#boardRequestId = `pi-herdr-board-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.#events.emit(AGENT_BOARD_VIEW_REQUEST_EVENT, {
            schemaVersion: 2,
            requestId: this.#boardRequestId,
        });
        this.#events.emit(FILES_CAPABILITY_REQUEST_EVENT, {
            requestId: "pi-herdr-orchestrator",
        });
        this.#filesRequestId = `pi-herdr-files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.#events.emit(FILES_PROVIDER_REQUEST_EVENT, {
            version: 1,
            requestId: this.#filesRequestId,
            action: "snapshot",
        });
        this.#events.emit(TODO_REQUEST_EVENT, {
            requestId: "pi-herdr-orchestrator",
            callback: todoCallback,
            respond: todoCallback,
        });
    }
    stop() {
        this.#lifecycleGeneration += 1;
        this.#scheduled = false;
        this.#dirty = false;
        if (!this.#started)
            return;
        this.#started = false;
        for (const timer of this.#retryTimers.splice(0))
            clearTimeout(timer);
        for (const unsubscribe of this.#unsubscribers.splice(0))
            unsubscribe();
        this.#events?.off?.(AGENT_BOARD_SUMMARY_EVENT, this.#agentBoardListener);
        this.#events?.off?.(AGENT_BOARD_CHANGED_EVENT, this.#agentBoardListener);
        this.#events?.off?.(TODO_SUMMARY_EVENT, this.#todoListener);
        this.#events?.off?.(TODO_CHANGED_EVENT, this.#todoListener);
        this.#events?.off?.(AGENT_BOARD_VIEW_CHANGED_EVENT, this.#boardViewListener);
        this.#events?.off?.(AGENT_BOARD_VIEW_RESPONSE_EVENT, this.#boardViewResponseListener);
        this.#events?.off?.(FILES_PROVIDER_SUMMARY_EVENT, this.#filesListener);
        this.#events?.off?.(FILES_PROVIDER_VIEW_EVENT, this.#filesListener);
        this.#events?.off?.(FILES_PROVIDER_RESPONSE_EVENT, this.#filesResponseListener);
        this.#events?.off?.(FILES_CAPABILITY_EVENT, this.#filesListener);
    }
    snapshot() {
        return structuredClone(this.#projection);
    }
    queuePublish() {
        if (!this.#bound)
            return;
        this.#dirty = true;
        if (this.#scheduled || this.#publishing)
            return;
        this.#scheduled = true;
        const generation = this.#lifecycleGeneration;
        queueMicrotask(() => {
            this.#scheduled = false;
            if (generation !== this.#lifecycleGeneration || !this.#dirty)
                return;
            void this.flush(generation);
        });
    }
    async flush(generation) {
        if (this.#publishing || generation !== this.#lifecycleGeneration)
            return;
        this.#publishing = true;
        try {
            while (this.#dirty && generation === this.#lifecycleGeneration) {
                this.#dirty = false;
                const projection = this.snapshot();
                const signature = semanticSignature(projection);
                if (signature === this.#lastPublishedSignature)
                    continue;
                try {
                    await this.#publish(projection);
                    if (generation === this.#lifecycleGeneration)
                        this.#lastPublishedSignature = signature;
                }
                catch {
                    // Keep the successful signature unchanged. A later event or explicit
                    // publish retries the newest state without a timed debounce.
                    break;
                }
            }
        }
        finally {
            this.#publishing = false;
            if (this.#dirty && generation === this.#lifecycleGeneration)
                this.queuePublish();
        }
    }
}
