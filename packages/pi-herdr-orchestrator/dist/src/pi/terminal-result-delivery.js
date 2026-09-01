export const TERMINAL_RESULT_MESSAGE_TYPE = "pi-herdr-task-terminal";
export const TERMINAL_RESULT_STATE_TYPE = "pi-herdr-terminal-delivery-state";
const TERMINAL_STATES = new Set([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
]);
const MAX_DELIVERY_KEYS = 1_024;
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function safeText(value, max = 256) {
    return typeof value === "string" &&
        value.length > 0 &&
        Buffer.byteLength(value, "utf8") <= max &&
        !/[\u0000-\u001f\u007f]/u.test(value)
        ? value
        : undefined;
}
function safeSequence(value) {
    return Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}
function deliveryKey(taskId, state, resultId) {
    return `${taskId}:${state}:${resultId ?? ""}`;
}
function messageDetails(entry) {
    if (entry.type === "custom_message" &&
        entry.customType === TERMINAL_RESULT_MESSAGE_TYPE)
        return record(entry.details);
    if (entry.type !== "message")
        return undefined;
    const message = record(entry.message);
    return message?.role === "custom" &&
        message.customType === TERMINAL_RESULT_MESSAGE_TYPE
        ? record(message.details)
        : undefined;
}
export class TerminalResultDelivery {
    #api;
    #delivered = new Set();
    #cursor;
    #queue = Promise.resolve();
    #failedEpoch;
    constructor(api) {
        this.#api = api;
    }
    restore(entries) {
        this.#cursor = undefined;
        this.#delivered.clear();
        for (const value of entries) {
            const entry = record(value);
            if (!entry)
                continue;
            if (entry.type === "custom" &&
                entry.customType === TERMINAL_RESULT_STATE_TYPE) {
                const data = record(entry.data);
                if (data?.schemaVersion !== 1)
                    continue;
                this.#restoreCursor(data.eventSeq);
                const key = safeText(data.deliveryKey, 1_024);
                if (key)
                    this.#remember(key);
                continue;
            }
            const details = messageDetails(entry);
            if (!details || details.schemaVersion !== 1)
                continue;
            const taskId = safeText(details.taskId);
            const state = safeText(details.state, 32);
            const resultId = details.resultId === undefined ? undefined : safeText(details.resultId);
            const key = safeText(details.deliveryKey, 1_024);
            if (!taskId ||
                !state ||
                !TERMINAL_STATES.has(state) ||
                key !== deliveryKey(taskId, state, resultId))
                continue;
            this.#restoreCursor(details.eventSeq);
            this.#remember(key);
        }
    }
    beginEpoch(epoch) {
        if (this.#failedEpoch !== epoch)
            this.#failedEpoch = undefined;
    }
    subscriptionCursor(brokerHead) {
        const head = safeSequence(brokerHead) ?? 0;
        return Math.min(this.#cursor ?? head, head);
    }
    handle(event, binding) {
        this.#queue = this.#queue.then(async () => {
            if (!binding.isCurrent() ||
                this.#failedEpoch === binding.epoch ||
                (this.#cursor !== undefined && event.seq <= this.#cursor))
                return;
            try {
                await this.#process(event, binding);
            }
            catch {
                if (!binding.isCurrent())
                    return;
                this.#failedEpoch = binding.epoch;
                binding.retry();
            }
        });
    }
    async flush() {
        await this.#queue;
    }
    async #process(event, binding) {
        if (!["task.state_changed", "run.state_changed"].includes(event.event) ||
            typeof event.refs.taskId !== "string") {
            this.#advance(event.seq);
            return;
        }
        const eventState = String(event.event === "run.state_changed"
            ? (event.data.state ?? "")
            : (event.data.to ?? ""));
        if (!TERMINAL_STATES.has(eventState)) {
            this.#advance(event.seq);
            return;
        }
        const taskId = event.refs.taskId;
        const value = await binding.request("task.get", { taskId }, { timeoutMs: 10_000 });
        if (!binding.isCurrent())
            return;
        const task = record(value);
        if (!task || task.id !== taskId)
            throw new Error("TASK_DELIVERY_INVALID");
        if (task.parentAgentId !== binding.parentAgentId()) {
            this.#advance(event.seq);
            return;
        }
        const state = safeText(task.state, 32);
        if (!state || !TERMINAL_STATES.has(state))
            throw new Error("TASK_DELIVERY_INVALID");
        const resultId = task.resultId === undefined ? undefined : safeText(task.resultId);
        if (task.resultId !== undefined && !resultId)
            throw new Error("TASK_DELIVERY_INVALID");
        const assignedAgentId = task.assignedAgentId === undefined
            ? undefined
            : safeText(task.assignedAgentId);
        if (task.assignedAgentId !== undefined && !assignedAgentId)
            throw new Error("TASK_DELIVERY_INVALID");
        const key = deliveryKey(taskId, state, resultId);
        if (!this.#delivered.has(key)) {
            if (!this.#api.sendMessage)
                throw new Error("PI_MESSAGE_UNAVAILABLE");
            const title = safeText(task.title, 16_384) ?? taskId;
            const agentReference = assignedAgentId
                ? ` for agent ${assignedAgentId}`
                : "";
            const closeInstruction = assignedAgentId
                ? ` If agent ${assignedAgentId} remains open and is no longer needed, use orchestrate with action "close" and taskId ${taskId}.`
                : "";
            this.#api.sendMessage({
                customType: TERMINAL_RESULT_MESSAGE_TYPE,
                content: `Managed task ${taskId} (${title}) reached ${state}${agentReference}. Use orchestrate with action "collect" and taskIds ["${taskId}"] to record its structured result if available.${closeInstruction} Continue the remaining work without waiting for a user prompt.`,
                display: true,
                details: {
                    schemaVersion: 1,
                    eventSeq: event.seq,
                    deliveryKey: key,
                    taskId,
                    state,
                    ...(resultId ? { resultId } : {}),
                    ...(assignedAgentId ? { assignedAgentId } : {}),
                },
            }, { deliverAs: "followUp", triggerTurn: true });
            this.#remember(key);
        }
        this.#advance(event.seq, key);
    }
    #restoreCursor(value) {
        const sequence = safeSequence(value);
        if (sequence !== undefined)
            this.#cursor = Math.max(this.#cursor ?? 0, sequence);
    }
    #advance(eventSeq, deliveredKey) {
        this.#cursor = Math.max(this.#cursor ?? 0, eventSeq);
        try {
            this.#api.appendEntry?.(TERMINAL_RESULT_STATE_TYPE, {
                schemaVersion: 1,
                eventSeq: this.#cursor,
                ...(deliveredKey ? { deliveryKey: deliveredKey } : {}),
            });
        }
        catch {
            // The custom message also stores terminal delivery state. Replaying a
            // nonterminal event after a session restart is harmless.
        }
    }
    #remember(key) {
        if (this.#delivered.has(key))
            this.#delivered.delete(key);
        this.#delivered.add(key);
        if (this.#delivered.size > MAX_DELIVERY_KEYS)
            this.#delivered.delete(this.#delivered.values().next().value);
    }
}
