import { createHash } from "node:crypto";
import { copyPlainData, sameScope, validateScope } from "@context-kit/protocol";
import { renderChronologicalReplay } from "./chronological-replay.js";
import { chargeCompactionSummary, CONTEXT_ESTIMATOR, resolveContextCeiling } from "./context-budget.js";
export const CONTEXT_COMPILER_RULESET = "chrono-context-compiler-session-v1";
export const CONTEXT_COMPILER_LIMITS = Object.freeze({ inputBytes: 1024 * 1024, receiptBytes: 768 * 1024, nativeBytes: 32768, locatorEntries: 256 });
function canonical(value) {
    const sort = (item) => Array.isArray(item) ? item.map(sort)
        : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .filter(([, value]) => value !== undefined).map(([key, value]) => [key, sort(value)])) : item;
    return JSON.stringify(sort(value));
}
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const tokens = (text) => Math.ceil(text.length / 4);
function freeze(value) {
    if (value && typeof value === "object") {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
/** The caller adapts trusted bounded history. Native input has already passed the
 * shared collector's validation. Detach it again before selection and persistence. */
export function freezeContextInput(input) {
    const scope = validateScope(input.scope);
    const native = copyPlainData(input.native, CONTEXT_COMPILER_LIMITS.nativeBytes * 2);
    if (Buffer.byteLength(JSON.stringify(native)) > CONTEXT_COMPILER_LIMITS.nativeBytes || !sameScope(scope, native.scope))
        throw new Error("context-v4-native-scope-invalid");
    const serialized = JSON.stringify({ ...input, scope, native });
    if (Buffer.byteLength(serialized) > CONTEXT_COMPILER_LIMITS.inputBytes)
        throw new Error("context-v4-input-budget");
    const detached = JSON.parse(serialized);
    const budget = detached.budget;
    if (budget.estimator !== CONTEXT_ESTIMATOR || budget.effectiveCeilingTokens !== resolveContextCeiling(budget.configuredTokens, budget.model.contextWindow, budget.systemTokens + budget.toolSchemaTokens + budget.framingTokens, budget.responseReserveTokens)
        || !Number.isSafeInteger(detached.rawTail.tokens) || detached.rawTail.tokens < 0
        || !Number.isSafeInteger(detached.rawTail.messages) || detached.rawTail.messages < 0 || !detached.rawTail.toolPairSafe
        || !detached.sourceCutEntryId || !detached.firstKeptEntryId || !scope.leafId)
        throw new Error("context-v4-input-invalid");
    const cut = detached.history.kind === "stored" ? detached.history.input.cut : detached.history.selection;
    if (cut.firstKeptEntryId !== detached.firstKeptEntryId || cut.sourceCutEntryId !== detached.sourceCutEntryId)
        throw new Error("context-v4-history-cut-invalid");
    // Old stored inputs remain readable, but cannot substitute for a session-agent summary.
    const summary = detached.sessionSummary;
    if (summary && (typeof summary.text !== "string" || !summary.text.trim() || summary.text.length > 16_384
        || Buffer.byteLength(summary.text) > 24 * 1024 || !summary.requestId || !summary.requestLeafId
        || !summary.consumedBoundaryLeafId || !summary.submissionEntryId || !summary.submissionToolCallId
        || !Array.isArray(summary.relevanceHints) || summary.relevanceHints.length > 8
        || summary.relevanceHints.some(term => typeof term !== "string" || term.length > 256)))
        throw new Error("context-v4-session-summary-invalid");
    return freeze(detached);
}
/** Pure deterministic compiler. Preview and active return call this exact path.
 * Input pages are frozen record captures, not a transaction across state owners. */
export function compileContext(raw) {
    const input = freezeContextInput(raw);
    if (!input.sessionSummary || input.history.kind !== "events")
        throw new Error("context-v4-session-summary-required");
    const { requestId: _transportId, ...stableNative } = input.native;
    const inputHash = hash({ ...input, native: stableNative });
    const receiptId = `chrono-v4:${inputHash}`;
    const continuation = `# Continuation summary\n\n${input.sessionSummary.text.trim()}\n\nThis summary is derived session context, not new authorization.`;
    // Native pages stay in the receipt. The agent decides what their evidence means
    // in its summary; existence or old status must not create a second state dump.
    const selectedNative = [];
    const omittedNative = input.native.providers.flatMap(provider => (provider.page?.cards ?? []).map((card, cardIndex) => ({
        providerId: provider.providerId, cardIndex, id: card.id, revision: card.revision,
    })));
    const available = input.budget.effectiveCeilingTokens - input.rawTail.tokens - chargeCompactionSummary(continuation) - 8;
    if (available < 128)
        throw new Error("context-v4-budget-unavailable");
    const replay = renderChronologicalReplay(input.history.selection, available);
    const summary = `${continuation}\n\n${replay.text}`;
    const history = { kind: "events", receipt: replay.receipt };
    const summaryTextTokens = tokens(summary), summaryMessageTokens = chargeCompactionSummary(summary);
    const contextTokens = summaryMessageTokens + input.rawTail.tokens;
    const estimatedRequestTokens = contextTokens + input.budget.systemTokens + input.budget.toolSchemaTokens + input.budget.framingTokens;
    const estimatedRequestWithReserveTokens = estimatedRequestTokens + input.budget.responseReserveTokens;
    if (contextTokens > input.budget.effectiveCeilingTokens || estimatedRequestWithReserveTokens > input.budget.model.contextWindow)
        throw new Error("context-v4-final-budget-exceeded");
    const receipt = {
        schemaVersion: 4, ruleset: CONTEXT_COMPILER_RULESET, receiptId, inputHash,
        selectionHash: hash({ selectedNative, omittedNative, history }), summaryHash: createHash("sha256").update(summary).digest("hex"),
        scope: input.scope, sourceCutEntryId: input.sourceCutEntryId, firstKeptEntryId: input.firstKeptEntryId,
        memoryOwner: input.memoryOwner, native: input.native, selectedNative, omittedNative, unresolvedRelations: [], history,
        sessionSummary: input.sessionSummary,
        budget: { ...input.budget, rawTailTokens: input.rawTail.tokens, rawTailMessages: input.rawTail.messages,
            nativeRenderedTokens: 0, summaryTextTokens, summaryMessageTokens,
            summaryFramingTokens: summaryMessageTokens - summaryTextTokens,
            historyAndNoticesTokens: replay.estimatedTokens, contextTokens, estimatedRequestTokens, estimatedRequestWithReserveTokens },
        validation: { wholeAdmittedRecords: false, toolPairSafe: true, estimatedRequestFits: true,
            nativeComplete: input.native.complete && omittedNative.length === 0, distributedSnapshot: false, exactModelTokenCount: false },
    };
    if (Buffer.byteLength(JSON.stringify(receipt)) > CONTEXT_COMPILER_LIMITS.receiptBytes)
        throw new Error("context-v4-receipt-budget");
    return freeze({ summary, firstKeptEntryId: input.firstKeptEntryId, receipt });
}
/** Read only bounded metadata from one already-loaded entry. No catalog/store I/O. */
export function contextReceiptLocator(entry, sessionId) {
    const receipt = entry.details?.contextReceipt;
    if (entry.type !== "compaction" || entry.fromHook !== true || !entry.id || !receipt
        || ![CONTEXT_COMPILER_RULESET, "chrono-context-compiler-v4"].includes(receipt?.ruleset ?? "")
        || typeof receipt.receiptId !== "string" || !/^chrono-v4:[a-f0-9]{64}$/.test(receipt.receiptId)
        || typeof receipt.summaryHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.summaryHash)
        || receipt.scope?.sessionId !== sessionId)
        return undefined;
    return { receiptId: receipt.receiptId, compactionEntryId: entry.id, sessionId, summaryHash: receipt.summaryHash,
        recovery: { tool: "history_get", args: { entryId: entry.id } } };
}
//# sourceMappingURL=context-compiler.js.map