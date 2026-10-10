const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const text = (value) => typeof value === "string" && value.length > 0 ? value : undefined;
const revision = (value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
const association = (event) => JSON.stringify([event.source.sessionId, event.source.shardId ?? null]);
/** Consume only source-bound, persisted successful results in complete units.
 * Missing typed fields omit an optional hint. Never read a provider's private store. */
export function collectIntervalBoundaryHints(events, units) {
    const hints = [];
    for (const unit of units) {
        if (unit.status !== "complete")
            continue;
        const calls = new Map();
        for (const index of unit.eventIndexes) {
            const event = events[index];
            for (const call of event.toolCalls)
                calls.set(`${association(event)}\0${call.id}`, { event, call });
        }
        for (const index of unit.eventIndexes) {
            const event = events[index], result = event.toolResult;
            if (!result || result.isError !== false)
                continue;
            const joined = calls.get(`${association(event)}\0${result.callId}`);
            if (!joined || result.toolName && result.toolName !== joined.call.name)
                continue;
            const message = record(event.projectedEntry.message), details = record(message?.details);
            const args = joined.call.arguments, action = text(args.action), owner = record(details?.owner);
            const commitId = text(owner?.commitId);
            if (!details || !action || details.action !== action || !commitId)
                continue;
            const base = { position: unit.endPosition, unitId: unit.id, action, callEntryId: joined.event.entryId,
                toolCallId: joined.call.id, resultEntryId: event.entryId, commitId };
            if (joined.call.name === "todo" && details.protocol === "context-kit-todo-result/v1") {
                const providerRevision = revision(owner?.revision);
                if (providerRevision === undefined)
                    continue;
                const taskId = text(args.id);
                if (taskId && (action === "start" || action === "done")) {
                    hints.push({ ...base, provider: "todo", kind: "transition", taskId, providerRevision,
                        to: action === "start" ? "in_progress" : "done" });
                }
                if (Array.isArray(details.statusChanges)) {
                    for (const item of details.statusChanges) {
                        const change = record(item), id = text(change?.id), from = text(change?.from), to = text(change?.to);
                        if (id && from && to)
                            hints.push({ ...base, provider: "todo", kind: "transition", taskId: id, providerRevision, from, to });
                    }
                }
            }
            else if (joined.call.name === "workplan" && details.protocol === "grounded-state-result/v1"
                && details.ownerProtocol === "context-kit:workplan-result/v1") {
                const data = record(record(details.event)?.data), receipt = record(details.result);
                const planId = text(data?.planId) ?? text(receipt?.planId);
                const planRevision = revision(data?.revision) ?? revision(receipt?.revision);
                if (!planId || planRevision === undefined || args.planId !== undefined && args.planId !== planId)
                    continue;
                if (action === "update_milestone") {
                    const milestoneId = text(data?.milestoneId) ?? text(args.milestoneId);
                    const to = text(record(data?.changes)?.status) ?? text(record(args.content)?.status);
                    if (milestoneId && to && ["pending", "in_progress", "blocked", "completed"].includes(to)
                        && (args.milestoneId === undefined || args.milestoneId === milestoneId)) {
                        hints.push({ ...base, provider: "workplan", kind: "transition", planId, milestoneId, planRevision, to });
                    }
                }
                else if (action === "checkpoint") {
                    hints.push({ ...base, provider: "workplan", kind: "checkpoint", planId, planRevision });
                }
                else if (["complete", "pause", "resume", "archive", "restore"].includes(action)) {
                    const from = text(data?.from), to = text(data?.to);
                    // A normalized native transition is stronger than a prose receipt.
                    if (from && to)
                        hints.push({ ...base, provider: "workplan", kind: "transition", planId, planRevision, from, to });
                }
            }
            else if (joined.call.name === "notes" && details.protocol === "grounded-state-result/v1"
                && ["add", "append", "update", "archive", "remove"].includes(action)) {
                const providerRevision = revision(owner?.revision);
                if (providerRevision !== undefined)
                    hints.push({ ...base, provider: "notes", kind: "saved-state", providerRevision });
            }
        }
    }
    return hints;
}
//# sourceMappingURL=interval-boundary-hints.js.map