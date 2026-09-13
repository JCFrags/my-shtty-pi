import { randomUUID } from "node:crypto";
import { captureStateTransfer, OWNER_BINDING_ENTRY, validateTransferEntries } from "@context-kit/protocol/transfer";
export const LOGICAL_CHECKPOINT_TYPE = "grounded-state-checkpoint-v1";
export const LOGICAL_CHECKPOINT_LIMITS = { providerBytes: 8 * 1024 * 1024, aggregateBytes: 16 * 1024 * 1024 };
const providers = new Set(["notes", "todo", "workplan"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => { throw new Error("logical-session-state-checkpoint-invalid"); };
export const isLogicalCheckpointType = (value) => value === LOGICAL_CHECKPOINT_TYPE || value === OWNER_BINDING_ENTRY;
/** Check transport shape, scope and exact byte bounds. Each provider validates
 * its own state before export and again when it restores the custom entry. */
export function validateLogicalStateCheckpoints(values, source) {
    try {
        const entries = validateTransferEntries(values);
        for (const entry of entries) {
            const data = entry.data;
            if (!data.sourceLeafId || source?.sourceSessionId !== undefined && data.sourceSessionId !== source.sourceSessionId
                || source?.sourceLeafId !== undefined && data.sourceLeafId !== source.sourceLeafId
                || entry.customType === LOGICAL_CHECKPOINT_TYPE && !object(entry.data.state))
                return fail();
        }
        return entries;
    }
    catch {
        return fail();
    }
}
/** Bounded async export includes the complete state of each installed native
 * owner. Memory transfers its verified logical-session binding, not Recall cards. */
export async function captureLogicalStateCheckpointsAsync(pi, ctx, options) {
    const tools = new Set(pi.getAllTools().map((tool) => tool.name));
    const selected = [...providers].filter((provider) => tools.has(provider));
    if (options.includeMemory) {
        if (!tools.has("memory_get"))
            return fail();
        selected.push("memory");
    }
    if (!selected.length)
        return [];
    const scope = { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() };
    if (!scope.leafId)
        return fail();
    try {
        const entries = await captureStateTransfer(pi.events, () => ({
            sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
        }), { providers: selected, signal: options.signal });
        return validateLogicalStateCheckpoints(entries, { sourceSessionId: scope.sessionId, sourceLeafId: scope.leafId });
    }
    catch {
        return fail();
    }
}
/** Legacy synchronous export. An async owner cannot be silently omitted. */
export function captureLogicalStateCheckpoints(pi, ctx) {
    const installed = new Set(pi.getAllTools().map(tool => tool.name).filter(name => providers.has(name)));
    if (installed.size === 0)
        return [];
    const sourceSessionId = ctx.sessionManager.getSessionId(), sourceLeafId = ctx.sessionManager.getLeafId();
    if (!sourceLeafId)
        return fail();
    const requestId = randomUUID(), entries = [], responded = new Set();
    let refused = false;
    const unsubscribe = pi.events.on("grounded-state:checkpoint-response-v1", (reply) => {
        if (!object(reply) || reply.requestId !== requestId)
            return;
        if (reply.version !== 1 || typeof reply.provider !== "string" || !installed.has(reply.provider) || responded.has(reply.provider)) {
            refused = true;
            return;
        }
        responded.add(reply.provider);
        if (reply.ok !== true || !object(reply.entry) || !object(reply.entry.data) || reply.entry.data.provider !== reply.provider) {
            refused = true;
            return;
        }
        try {
            entries.push(JSON.parse(JSON.stringify(reply.entry)));
        }
        catch {
            refused = true;
        }
    });
    try {
        pi.events.emit("grounded-state:checkpoint-request-v1", { version: 1, requestId, sourceSessionId, sourceLeafId,
            maxBytes: LOGICAL_CHECKPOINT_LIMITS.providerBytes });
    }
    finally {
        unsubscribe();
    }
    if (refused || responded.size !== installed.size || ctx.sessionManager.getSessionId() !== sourceSessionId
        || ctx.sessionManager.getLeafId() !== sourceLeafId)
        return fail();
    return validateLogicalStateCheckpoints(entries, { sourceSessionId, sourceLeafId });
}
//# sourceMappingURL=logical-session-checkpoints.js.map