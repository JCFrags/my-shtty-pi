import { randomUUID } from "node:crypto";
export const LOGICAL_CHECKPOINT_TYPE = "grounded-state-checkpoint-v1";
export const LOGICAL_CHECKPOINT_LIMITS = { providerBytes: 8 * 1024 * 1024, aggregateBytes: 16 * 1024 * 1024 };
const providers = new Set(["notes", "todo", "workplan"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => { throw new Error("logical-session-state-checkpoint-invalid"); };
/** Check transport shape, scope and exact byte bounds. Each provider validates
 * its own state before export and again when it restores the custom entry. */
export function validateLogicalStateCheckpoints(values, source) {
    const seen = new Set();
    let totalBytes = 0;
    if (values.length > providers.size)
        return fail();
    for (const value of values) {
        if (!object(value) || value.customType !== LOGICAL_CHECKPOINT_TYPE || !object(value.data))
            return fail();
        const data = value.data;
        if (data.version !== 1 || typeof data.provider !== "string" || !providers.has(data.provider) || seen.has(data.provider)
            || typeof data.sourceSessionId !== "string" || !data.sourceSessionId || data.sourceSessionId.length > 1024
            || typeof data.sourceLeafId !== "string" || !data.sourceLeafId || data.sourceLeafId.length > 1024 || !object(data.state)
            || source?.sourceSessionId !== undefined && data.sourceSessionId !== source.sourceSessionId
            || source?.sourceLeafId !== undefined && data.sourceLeafId !== source.sourceLeafId)
            return fail();
        seen.add(data.provider);
        const bytes = Buffer.byteLength(JSON.stringify({ customType: value.customType, data }));
        totalBytes += bytes;
        if (bytes > LOGICAL_CHECKPOINT_LIMITS.providerBytes || totalBytes > LOGICAL_CHECKPOINT_LIMITS.aggregateBytes)
            return fail();
    }
    return values;
}
/** Synchronous export at safe idle. No archive replay or model-visible prose is
 * accepted as a replacement for an installed provider's exact active state. */
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