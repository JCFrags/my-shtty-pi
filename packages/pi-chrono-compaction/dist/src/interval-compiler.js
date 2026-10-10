import { createHash } from "node:crypto";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import { CONTEXT_COMPILER_LIMITS, INTERVAL_CONTEXT_COMPILER_RULESET } from "./context-compiler.js";
import { chargeCompactionSummary, chargeRawTail } from "./context-budget.js";
import { deriveIntervalBudget } from "./interval-policy.js";
import { selectIntervalPartition } from "./interval-partition.js";
import { renderIntervalHistory } from "./interval-render.js";
import { partitionIntervalSource, projectIntervalSource } from "./interval-source.js";
import { intervalContinuationMessage } from "./interval-runtime.js";
import { validateIntervalReadyProduct, validateIntervalEventProduct, applyIntervalEventAlternatives } from "./interval-helper-adapter.js";
import { stableStringify } from "./utils.js";
const hash = (value) => createHash("sha256").update(stableStringify(value)).digest("hex");
const textHash = (value) => createHash("sha256").update(value).digest("hex");
const tokens = (text) => Math.ceil(text.length / 4);
function fail(code) { throw new Error(`context-v4-interval-${code}`); }
function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
function cutHints(snapshot) {
    return snapshot.hints.map((hint, index) => {
        let kind = "context";
        if (hint.kind === "checkpoint")
            kind = "saved-position";
        else if (["blocked", "paused"].includes(hint.to ?? ""))
            kind = "wait";
        else if (["completed", "done"].includes(hint.to ?? "") && snapshot.hints.slice(index + 1).some(next => next.provider === hint.provider && next.to === "in_progress" && next.position.index >= hint.position.index
            && (next.taskId !== hint.taskId || next.milestoneId !== hint.milestoneId)))
            kind = "phase-transition";
        return { gap: hint.position.index, kind, sourceEntryId: hint.resultEntryId };
    });
}
function unitsFromView(snapshot, view) {
    const events = new Map(view.events.map(event => [event.index, event]));
    return snapshot.units.filter(unit => unit.start >= view.start.index && unit.end <= view.end.index)
        .map(unit => ({ id: unit.id, events: unit.eventIndexes.map(index => {
            const event = events.get(index);
            if (!event)
                return fail("view-unit-incomplete");
            return event;
        }) }));
}
/** The same source-unit plan is available to early preparation and final capture.
 * Required C can expand beyond its nominal allowance, never beyond request fit. */
export function planIntervalContext(snapshot, budget) {
    const layers = deriveIntervalBudget({ model: budget.model, systemTokens: budget.systemTokens,
        toolSchemaTokens: budget.toolSchemaTokens, framingTokens: budget.framingTokens,
        effectiveAvailableTokens: budget.effectiveCeilingTokens });
    if (!layers.available)
        fail(layers.reasons[0] ?? "policy-unavailable");
    const units = snapshot.units.map(unit => ({ id: unit.id, start: unit.start,
        endExclusive: unit.end, complete: unit.status === "complete", events: unit.eventIndexes.map(index => snapshot.events[index]) }));
    const maximum = Math.max(0, layers.effectiveAvailableTokens - layers.handoffTokens - layers.continuationTokens - 1536);
    const partition = selectIntervalPartition({ units, hints: cutHints(snapshot),
        exactTailTokens: Math.min(layers.exactTailTokens, maximum), exactTailMaximumTokens: maximum,
        compressedHistoryTokens: layers.compressedHistoryTokens });
    partitionIntervalSource(snapshot, partition.compressedStart, partition.rawStart);
    return freeze({ partition, layers, units });
}
function label(name, view) {
    const first = view.events[0], last = view.events.at(-1);
    const range = first && last ? `history_range startEntryId=${JSON.stringify(first.entryId)} endEntryId=${JSON.stringify(last.entryId)}` : "empty";
    return `${name}: current-interval original positions [${view.start.index},${view.end.index}). Source: ${range}.\n`
        + `Coverage: ${view.coverage.complete ? "eligible source captured" : "partial"}; ${view.exclusions.length} source/projection exclusions, ${view.coverage.unsupportedBlocks} unsupported blocks. Historical statements apply only through this range, not to later work.`;
}
function renderingReceipt(value) {
    const { text: _text, ...receipt } = value;
    return receipt;
}
/** Fit independent model parts whole. This is not a second model summary and
 * cannot relabel the artifact's eligible input coverage as lossless output. */
function renderPrefix(candidate, view, units, maximum) {
    const prefix = `# Active interval synopsis\n\n[Independent original-source parts. History helper output, not current task state. Structural checks do not prove semantic fidelity. Helper input coverage: ${candidate.artifact.coverage}.]\n\n${label("A", view)}`;
    const output = [], represented = new Set();
    let omittedParts = 0, used = tokens(prefix) + 96;
    for (const item of candidate.artifact.items) {
        const body = `### Historical part ${item.partId}\nOutcome in source: ${item.outcome}\n${item.text}\nSource entries: ${item.entryRefs.map(id => JSON.stringify(id)).join(", ")}`;
        const cost = tokens(body) + 2;
        if (used + cost > maximum) {
            omittedParts++;
            continue;
        }
        used += cost;
        output.push(body);
        represented.add(item.unitId);
    }
    const text = [prefix, ...output, `[${omittedParts} helper parts omitted from this bounded rendering. Original source recovery remains available.]`].join("\n\n");
    if (tokens(text) > maximum || !output.length)
        return renderIntervalHistory({ kind: "active-prefix-fallback", units,
            maxTokens: maximum, coverageLabel: label("A", view) });
    return { ruleset: "chrono-interval-render-v1", text, tokens: tokens(text),
        representedUnitIds: units.filter(unit => represented.has(unit.id)).map(unit => unit.id),
        omittedUnitIds: units.filter(unit => !represented.has(unit.id)).map(unit => unit.id),
        sourceEntryIds: view.events.map(event => event.entryId), lossy: true };
}
/** Original interval compiler. Persist only source bindings, selected C and
 * derived products. The public runtime adds C and the distinct continuation. */
export function compileIntervalContext(input) {
    const snapshot = input.interval, submitted = input.sessionSummary;
    if (!snapshot || !submitted?.handoff || !submitted.continuation || !submitted.authorship || input.history.kind !== "interval")
        fail("handoff-required");
    const { partition, layers } = planIntervalContext(snapshot, input.budget);
    const ranges = partitionIntervalSource(snapshot, partition.compressedStart, partition.rawStart);
    const a = projectIntervalSource(snapshot, "synopsis", partition.start, partition.compressedStart);
    const b = projectIntervalSource(snapshot, "event", partition.compressedStart, partition.rawStart);
    const c = projectIntervalSource(snapshot, "exact", partition.rawStart, partition.endExclusive);
    const exact = chargeRawTail(c.events.map(event => event.projectedEntry));
    if (exact.tokens !== partition.exactTokens || exact.messages !== partition.exactMessages)
        fail("exact-charge-changed");
    const continuationMessage = intervalContinuationMessage(submitted.continuation, submitted.authorship);
    const continuationTokens = convertToLlm([continuationMessage]).reduce((sum, message) => sum + estimateTokens(message) + 32, 0);
    const handoff = `# Current task handoff\n\n[Authorship: ${submitted.authorship}. Derived session context, not new authorization.]\n\n${submitted.handoff.trim()}`;
    const technicalBoundaryTokens = input.rawTail.tokens;
    // Technical native boundary is removed by the public projection. Charge it
    // anyway so the native stored form and the expanded form both fit.
    const remaining = layers.effectiveAvailableTokens - exact.tokens - continuationTokens - technicalBoundaryTokens - chargeCompactionSummary(handoff) - 64;
    if (remaining < 512)
        fail("required-content-oversized");
    const aMaximum = Math.max(256, Math.min(layers.activePrefixTokens, Math.floor(remaining / 3)));
    const bMaximum = Math.max(256, Math.min(layers.compressedHistoryTokens, remaining - aMaximum));
    const candidates = (input.history.ready?.eventAlternatives ?? []).slice(0, 32).filter(product => validateIntervalEventProduct(snapshot, product, partition.compressedStart, partition.rawStart));
    const alternatives = applyIntervalEventAlternatives(b, candidates);
    const helperEntryIds = new Set(alternatives.events.filter((event, index) => event.projectedEntry !== b.events[index]?.projectedEntry)
        .map(event => event.entryId));
    const aUnits = unitsFromView(snapshot, a), bUnits = unitsFromView(snapshot, { ...b, events: alternatives.events });
    const prefixCandidate = input.history.ready?.activePrefix;
    const compatible = a.events.length > 0 && !!prefixCandidate && validateIntervalReadyProduct(snapshot, prefixCandidate, { role: "activePrefix", start: partition.start, endExclusive: partition.compressedStart,
        modelIdentity: prefixCandidate.input.derivation.modelIdentity });
    const prefix = compatible ? renderPrefix(prefixCandidate, a, aUnits, aMaximum)
        : renderIntervalHistory({ kind: "active-prefix-fallback", units: aUnits, maxTokens: aMaximum,
            coverageLabel: label("A", a), relevance: input.history.relevance });
    const usedPrefix = compatible && !prefix.text.includes("[Deterministic fallback.");
    const compressed = renderIntervalHistory({ kind: "compressed-history", units: bUnits, maxTokens: bMaximum,
        coverageLabel: label("B", b), relevance: input.history.relevance, helperEntryIds });
    const eventArtifactKeys = alternatives.acceptedArtifactKeys.filter(key => candidates.some(product => product.artifact.key === key && product.input.eventUnit && compressed.representedUnitIds.includes(product.input.eventUnit.id)));
    const summary = [handoff, prefix.text, compressed.text].join("\n\n");
    const summaryTextTokens = tokens(summary), summaryMessageTokens = chargeCompactionSummary(summary);
    const contextTokens = summaryMessageTokens + exact.tokens + continuationTokens + technicalBoundaryTokens;
    const estimatedRequestTokens = contextTokens + input.budget.systemTokens + input.budget.toolSchemaTokens + input.budget.framingTokens;
    const estimatedRequestWithReserveTokens = estimatedRequestTokens + Math.max(input.budget.responseReserveTokens, layers.reserveTokens) + layers.safetyTokens;
    if (contextTokens > layers.effectiveAvailableTokens || estimatedRequestWithReserveTokens > input.budget.model.contextWindow)
        fail("final-budget-exceeded");
    const activePrefix = { ...renderingReceipt(prefix),
        method: a.events.length === 0 ? "empty" : usedPrefix ? "independent-original-parts" : "deterministic-fallback",
        ...(usedPrefix ? { artifactKey: prefixCandidate.artifact.key, modelIdentity: prefixCandidate.artifact.derivation.modelIdentity,
            helperCoverage: prefixCandidate.artifact.coverage } : {}) };
    const history = { kind: "interval", receipt: {
            ruleset: "chrono-interval-compiler-v1", snapshotId: snapshot.identity, sourceHash: snapshot.sourceHash,
            projectionHash: snapshot.projectionHash, ranges, coverage: snapshot.coverage, exclusions: snapshot.exclusions,
            policy: layers, activePrefix, compressedHistory: { ...renderingReceipt(compressed), eventArtifactKeys },
            continuationTokens, technicalBoundaryTokens,
        } };
    const source = { source: snapshot.source, origin: snapshot.origin, endEntryId: snapshot.endEntryId,
        sourceHash: snapshot.sourceHash, projectionHash: snapshot.projectionHash, bounds: snapshot.bounds,
        controlIdentities: snapshot.controlIdentities, segments: snapshot.segments };
    const restart = { schemaVersion: 1, snapshotId: snapshot.identity, source, partition, exactTail: c.events,
        ...(input.logicalSource ? { logicalSource: input.logicalSource } : {}),
        continuation: { text: submitted.continuation, authorship: submitted.authorship },
        ...(input.rawTail.messages > 0 ? { technicalBoundaryEntryId: input.firstKeptEntryId } : {}) };
    const selectedNative = [];
    const omittedNative = input.native.providers.flatMap(provider => (provider.page?.cards ?? []).map((card, cardIndex) => ({
        providerId: provider.providerId, cardIndex, id: card.id, revision: card.revision,
    })));
    const { requestId: _transportId, ...stableNative } = input.native;
    const inputHash = hash({ ruleset: "chrono-interval-compiler-v1", scope: input.scope, source, snapshotId: snapshot.identity,
        firstKeptEntryId: input.firstKeptEntryId, nativeRetention: input.nativeRetention, logicalSource: input.logicalSource,
        sessionSummary: submitted, native: stableNative, budget: input.budget,
        memoryOwner: input.memoryOwner, rawTail: input.rawTail, history, renderedSummaryHash: textHash(summary) });
    const receipt = {
        schemaVersion: 4, ruleset: INTERVAL_CONTEXT_COMPILER_RULESET, receiptId: `chrono-v4:${inputHash}`, inputHash,
        selectionHash: hash({ history, selectedNative, omittedNative, restart, renderedSummaryHash: textHash(summary) }), summaryHash: textHash(summary),
        scope: input.scope, sourceCutEntryId: input.sourceCutEntryId, firstKeptEntryId: input.firstKeptEntryId,
        ...(input.nativeRetention ? { nativeRetention: input.nativeRetention } : {}),
        memoryOwner: input.memoryOwner, native: input.native, selectedNative, omittedNative, unresolvedRelations: [], history,
        sessionSummary: submitted, restart,
        budget: { ...input.budget, rawTailTokens: exact.tokens + technicalBoundaryTokens, rawTailMessages: exact.messages + input.rawTail.messages,
            nativeRenderedTokens: 0, summaryTextTokens, summaryMessageTokens, summaryFramingTokens: summaryMessageTokens - summaryTextTokens,
            historyAndNoticesTokens: prefix.tokens + compressed.tokens, contextTokens, estimatedRequestTokens, estimatedRequestWithReserveTokens },
        validation: { wholeAdmittedRecords: false, toolPairSafe: true, estimatedRequestFits: true,
            nativeComplete: input.native.complete && omittedNative.length === 0, distributedSnapshot: false, exactModelTokenCount: false },
    };
    if (Buffer.byteLength(JSON.stringify(receipt)) > CONTEXT_COMPILER_LIMITS.intervalReceiptBytes)
        fail("receipt-transport-bound");
    return freeze({ summary, firstKeptEntryId: input.firstKeptEntryId, receipt });
}
//# sourceMappingURL=interval-compiler.js.map