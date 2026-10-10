import { createHash } from "node:crypto";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { stableStringify } from "./utils.js";
export const INTERVAL_CONTINUATION_RECORD = "chrono-interval-continuation-v1";
export const INTERVAL_CONTINUATION_MESSAGE = "chrono-interval-immediate-continuation";
export const INTERVAL_RECOVERY_OPERATION = "chrono-interval-recovery-v1";
export function intervalContinuationMessage(text, authorship, timestamp = 0, details) {
    return { role: "custom", customType: INTERVAL_CONTINUATION_MESSAGE, display: false,
        content: `[Immediate continuation. Authorship: ${authorship}. Derived context, not new permission.]\n${text}`, details, timestamp };
}
/** Pure public-message expansion shared by precommit admission and restart.
 * No commit ID is invented and no source entry is changed. */
export function intervalRestartContentMessages(restart, timestamp = 0, details) {
    return [...restart.exactTail.flatMap(event => sessionEntryToContextMessages(event.projectedEntry)),
        intervalContinuationMessage(restart.continuation.text, restart.continuation.authorship, timestamp, details)];
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fail(code) { throw new Error(`context-v4-${code}`); }
/** JSONL preserves values, not shared object references. Compare the persisted
 * representation without changing the serializer used by existing hashes. */
export function samePersistedIntervalValue(left, right) {
    const persisted = (value) => stableStringify(JSON.parse(JSON.stringify(value)));
    return persisted(left) === persisted(right);
}
export function continuationRecord(input) {
    const { continuation, ...fields } = input;
    if (!continuation.trim() || !fields.operationId || !fields.sessionId || !fields.compactionEntryId
        || !/^chrono-v4:[a-f0-9]{64}$/.test(fields.receiptId) || !/^[a-f0-9]{64}$/.test(fields.summaryHash))
        fail("continuation-record-invalid");
    return Object.freeze({ ...fields, schemaVersion: 1, continuationHash: sha(continuation), authority: "derived",
        executionGuarantee: "duplicate-local-dispatch-suppression-only" });
}
export function hasContinuationDispatch(entries, expected) {
    return entries.some(entry => {
        if (entry.type !== "custom" || entry.customType !== INTERVAL_CONTINUATION_RECORD)
            return false;
        const data = entry.data;
        return data?.schemaVersion === 1 && data.state === "dispatched" && data.operationId === expected.operationId
            && data.sessionId === expected.sessionId && data.compactionEntryId === expected.compactionEntryId
            && data.receiptId === expected.receiptId && data.summaryHash === expected.summaryHash
            && data.continuationHash === expected.continuationHash;
    });
}
/** Verify the selected persisted commit before any committed-suffix recapture.
 * This checks native identity/retention. The caller still verifies exact source. */
export function committedIntervalRestartReceipt(entry, sessionId) {
    const receipt = entry.details?.contextReceipt;
    const restart = receipt?.restart;
    if (!restart)
        return undefined;
    if (entry.type !== "compaction" || entry.fromHook !== true || typeof entry.id !== "string" || typeof entry.summary !== "string"
        || receipt.schemaVersion !== 4 || receipt.scope?.sessionId !== sessionId
        || !/^[a-f0-9]{64}$/.test(receipt.inputHash) || receipt.receiptId !== `chrono-v4:${receipt.inputHash}`
        || sha(entry.summary) !== receipt.summaryHash || !Number.isFinite(Date.parse(String(entry.timestamp)))
        || restart.schemaVersion !== 1 || !Array.isArray(restart.exactTail)
        || receipt.sourceCutEntryId !== restart.source?.endEntryId || !restart.continuation?.text?.trim()
        || !["current-agent", "deterministic-recovery"].includes(restart.continuation.authorship))
        fail("restart-binding-invalid");
    if (receipt.nativeRetention?.kind === "none") {
        if (entry.firstKeptEntryId !== entry.id || restart.technicalBoundaryEntryId !== undefined
            || receipt.firstKeptEntryId !== `retain-none:${receipt.nativeRetention.operationId}`
            || receipt.sessionSummary?.requestId !== receipt.nativeRetention.operationId
            || receipt.sessionSummary.authorship !== restart.continuation.authorship)
            fail("restart-native-retention-invalid");
        if (restart.continuation.authorship === "current-agent") {
            const details = entry.details;
            if (details.kind !== "chrono-v4-current-agent" || details.summaryOperation?.operationId !== receipt.nativeRetention.operationId
                || details.summaryOperation.sourceSnapshotId !== restart.snapshotId)
                fail("restart-native-retention-invalid");
        }
    }
    else if (entry.firstKeptEntryId !== receipt.firstKeptEntryId)
        fail("restart-native-retention-invalid");
    return receipt;
}
/** Expand only one exact committed packet. C remains supported native messages,
 * including images and complete tool batches. Never stringify or shorten C.
 * The caller validates original-source association and the frozen projection.
 * A changed packet, boundary, or source refuses instead of replaying stale text. */
export function projectCommittedIntervalRestart(input) {
    const entry = input.compaction;
    const receipt = committedIntervalRestartReceipt(entry, input.sessionId);
    const restart = receipt?.restart;
    if (!receipt || !restart)
        return undefined;
    const compactionEntryId = entry.id;
    input.validateSources(receipt);
    const candidates = input.messages.flatMap((message, index) => {
        const value = message;
        return value.role === "compactionSummary" && value.summary === entry.summary
            && value.timestamp === Date.parse(String(entry.timestamp)) ? [index] : [];
    });
    if (candidates.length !== 1)
        fail("restart-summary-projection-changed");
    const summaryIndex = candidates[0];
    let boundaryMessage;
    if (restart.technicalBoundaryEntryId !== undefined) {
        if (restart.technicalBoundaryEntryId !== entry.firstKeptEntryId)
            fail("restart-boundary-invalid");
        const boundary = input.getEntry(restart.technicalBoundaryEntryId);
        if (!boundary || boundary.type !== "custom_message")
            fail("restart-boundary-unavailable");
        const converted = sessionEntryToContextMessages(boundary);
        if (converted.length !== 1)
            fail("restart-boundary-invalid");
        boundaryMessage = converted[0];
        if (stableStringify(input.messages[summaryIndex + 1]) !== stableStringify(boundaryMessage))
            fail("restart-boundary-projection-changed");
    }
    const restartMessages = intervalRestartContentMessages(restart, Date.parse(String(entry.timestamp)), { compactionEntryId, receiptId: receipt.receiptId, authority: "derived" });
    const result = [];
    for (let index = 0; index < input.messages.length; index++) {
        const message = input.messages[index];
        if (index === summaryIndex) {
            result.push(message, ...restartMessages);
            continue;
        }
        if (boundaryMessage !== undefined && index === summaryIndex + 1)
            continue;
        const value = message;
        // Only the correlated dispatch marker is hidden. New input and other resource
        // messages retain their normal order after the receipt-bound continuation.
        if (value.role === "custom" && value.customType === input.wakeCustomType
            && value.details?.compactionEntryId === compactionEntryId && value.details?.receiptId === receipt.receiptId)
            continue;
        result.push(message);
    }
    return result;
}
/** Current-agent and recovery proposals do not emit session_compact in Pi 1.1. A later
 * public boundary/context observation must find this exact persisted entry.
 * A returned proposal is not a commit and cannot release a provider barrier. */
export function correlatedBoundaryCompaction(input) {
    const matches = input.entries.filter(entry => {
        if (entry.type !== "compaction" || entry.fromHook !== true || entry.parentId !== input.parentId || typeof entry.summary !== "string")
            return false;
        const details = entry.details;
        const currentAgent = details?.contextReceipt?.sessionSummary?.authorship === "current-agent";
        const operation = currentAgent ? details?.summaryOperation : details?.recoveryOperation;
        return operation?.operationId === input.operationId && details?.contextReceipt?.scope.sessionId === input.sessionId
            && (!currentAgent || details.kind === "chrono-v4-current-agent"
                && details.summaryOperation?.sourceSnapshotId === details.contextReceipt.restart?.snapshotId)
            && details.contextReceipt.nativeRetention?.kind === "none"
            && details.contextReceipt.nativeRetention.operationId === input.operationId
            && details.contextReceipt.firstKeptEntryId === `retain-none:${input.operationId}`
            && details.contextReceipt.restart?.technicalBoundaryEntryId === undefined
            && details.contextReceipt.receiptId === input.receiptId && details.contextReceipt.summaryHash === input.summaryHash
            && sha(entry.summary) === input.summaryHash && entry.firstKeptEntryId === entry.id
            && (!input.expectedReceipt || samePersistedIntervalValue(details.contextReceipt, input.expectedReceipt));
    });
    if (matches.length > 1)
        fail("recovery-commit-ambiguous");
    return matches[0];
}
//# sourceMappingURL=interval-runtime.js.map