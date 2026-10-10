import { createHash } from "node:crypto";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import { CONTEXT_COMPILER_LIMITS, INTERVAL_CONTEXT_COMPILER_RULESET, type CompiledContext, type ContextSelectionReceipt,
  type FrozenContextInput, type NativeSelectionRef } from "./context-compiler.js";
import { chargeCompactionSummary, chargeRawTail, type ContextBudget } from "./context-budget.js";
import { deriveIntervalBudget, INTERVAL_POLICY, type IntervalLayerBudget } from "./interval-policy.js";
import { selectIntervalPartition, readyIntervalPartitions, INTERVAL_READY_PREFIX_CANDIDATE_LIMIT,
  type IntervalCutHint, type IntervalPartition, type IntervalPartitionUnit } from "./interval-partition.js";
import { renderIntervalHistory, type IntervalHistoryRendering, type IntervalRenderUnit } from "./interval-render.js";
import { partitionIntervalSource, projectIntervalSource, type IntervalSourceSnapshot, type IntervalSourceView,
  type IntervalSourcePartition } from "./interval-source.js";
import { intervalContinuationMessage } from "./interval-runtime.js";
import { renderHistorySynopsisPart, type HistoryHelperInput, type HistoryHelperArtifact } from "./history-helper.js";
import { validateIntervalReadyProduct, validateIntervalEventProduct, applyIntervalEventAlternatives } from "./interval-helper-adapter.js";
import { stableStringify } from "./utils.js";

export interface IntervalReadyAlternative {
  readonly input: HistoryHelperInput;
  readonly artifact: HistoryHelperArtifact;
}
export interface IntervalReadyPrefixCandidate extends IntervalReadyAlternative {
  /** H in the current original-source snapshot, recreated from pinned anchors. */
  readonly compressedStart: number;
}
/** Ready products are source-bound candidates, never a dependency to await. */
export interface IntervalReadyHistory {
  readonly activePrefix?: IntervalReadyAlternative;
  readonly activePrefixCandidates?: readonly IntervalReadyPrefixCandidate[];
  readonly eventAlternatives: readonly IntervalReadyAlternative[];
}
type RenderingReceipt = Omit<IntervalHistoryRendering, "text">;
export interface IntervalHistoryReceipt {
  readonly ruleset: "chrono-interval-compiler-v1";
  readonly snapshotId: string;
  readonly sourceHash: string;
  readonly projectionHash: string;
  readonly ranges: IntervalSourcePartition;
  readonly coverage: IntervalSourceSnapshot["coverage"];
  readonly exclusions: IntervalSourceSnapshot["exclusions"];
  readonly policy: IntervalLayerBudget;
  readonly activePrefix: RenderingReceipt & { readonly method: "empty" | "deterministic-fallback" | "range-synopsis" | "independent-original-parts";
    readonly artifactKey?: string; readonly modelIdentity?: string; readonly helperCoverage?: "full" | "partial" };
  readonly compressedHistory: RenderingReceipt & { readonly eventArtifactKeys: readonly string[] };
  readonly continuationTokens: number;
  readonly technicalBoundaryTokens: number;
}
const hash = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex");
const textHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const tokens = (text: string): number => Math.ceil(text.length / 4);
function fail(code: string): never { throw new Error(`context-v4-interval-${code}`); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function cutHints(snapshot: IntervalSourceSnapshot): IntervalCutHint[] {
  return snapshot.hints.map((hint, index) => {
    let kind: IntervalCutHint["kind"] = "context";
    if (hint.kind === "checkpoint") kind = "saved-position";
    else if (["blocked", "paused"].includes(hint.to ?? "")) kind = "wait";
    else if (["completed", "done"].includes(hint.to ?? "") && snapshot.hints.slice(index + 1).some(next =>
      next.provider === hint.provider && next.to === "in_progress" && next.position.index >= hint.position.index
      && (next.taskId !== hint.taskId || next.milestoneId !== hint.milestoneId))) kind = "phase-transition";
    return { gap: hint.position.index, kind, sourceEntryId: hint.resultEntryId };
  });
}
function unitsFromView(snapshot: IntervalSourceSnapshot, view: IntervalSourceView): IntervalRenderUnit[] {
  const events = new Map(view.events.map(event => [event.index, event]));
  return snapshot.units.filter(unit => unit.start >= view.start.index && unit.end <= view.end.index)
    .map(unit => ({ id: unit.id, events: unit.eventIndexes.map(index => {
      const event = events.get(index); if (!event) return fail("view-unit-incomplete"); return event;
    }) }));
}
/** The same source-unit plan is available to early preparation and final capture.
 * Required C can expand beyond its nominal allowance, never beyond request fit. */
export function planIntervalContext(snapshot: IntervalSourceSnapshot, budget: ContextBudget): {
  readonly partition: IntervalPartition; readonly layers: IntervalLayerBudget; readonly units: readonly IntervalPartitionUnit[];
} {
  const layers = deriveIntervalBudget({ model: budget.model, systemTokens: budget.systemTokens,
    toolSchemaTokens: budget.toolSchemaTokens, framingTokens: budget.framingTokens,
    effectiveAvailableTokens: budget.effectiveCeilingTokens });
  if (!layers.available) fail(layers.reasons[0] ?? "policy-unavailable");
  const units: IntervalPartitionUnit[] = snapshot.units.map(unit => ({ id: unit.id, start: unit.start,
    endExclusive: unit.end, complete: unit.status === "complete",
    assistantTurns: unit.eventIndexes.filter(index => snapshot.events[index]!.role === "assistant").length,
    events: unit.eventIndexes.map(index => snapshot.events[index]!) }));
  const maximum = Math.max(0, layers.effectiveAvailableTokens - layers.handoffTokens - layers.continuationTokens - 1536);
  const partition = selectIntervalPartition({ units, hints: cutHints(snapshot),
    exactTailTokens: Math.min(layers.exactTailTokens, maximum), exactTailMaximumTokens: maximum,
    exactTailMinimumTurns: INTERVAL_POLICY.exactTailMinimumTurns, compressedHistoryTokens: layers.compressedHistoryTokens });
  partitionIntervalSource(snapshot, partition.compressedStart, partition.rawStart);
  return freeze({ partition, layers, units });
}
function label(name: string, view: IntervalSourceView): string {
  const first = view.events[0], last = view.events.at(-1);
  const range = first && last ? `history_range startEntryId=${JSON.stringify(first.entryId)} endEntryId=${JSON.stringify(last.entryId)}` : "empty";
  return `${name}: current-interval original positions [${view.start.index},${view.end.index}). Source: ${range}.\n`
    + `Coverage: ${view.coverage.complete ? "eligible source captured" : "partial"}; ${view.exclusions.length} source/projection exclusions, ${view.coverage.unsupportedBlocks} unsupported blocks. Historical statements apply only through this range, not to later work.`;
}
function renderingReceipt(value: IntervalHistoryRendering): RenderingReceipt {
  const { text: _text, ...receipt } = value; return receipt;
}
/** Fit whole coherent original-source accounts. Never trim their statements,
 * recursively summarize them, or assemble range accounts from legacy items. */
function renderPrefix(candidate: IntervalReadyAlternative, view: IntervalSourceView,
  units: readonly IntervalRenderUnit[], maximum: number): IntervalHistoryRendering | undefined {
  const synopsis = candidate.artifact.synopsis;
  if (!synopsis?.parts.length) return undefined;
  const description = synopsis.mode === "whole-range" ? "Whole-range original A synopsis" : "Composite of disjoint original-source accounts";
  const notices = candidate.artifact.notices.map(notice => `[Coverage notice ${notice.code}; sources ${notice.entryRefs.map(ref => JSON.stringify(ref)).join(", ")}]`);
  const prefix = [`# Active interval synopsis\n\n[${description}. History helper output, not current task state. Structural checks do not prove semantic fidelity. Helper input coverage: ${candidate.artifact.coverage}.]`,
    label("A", view), ...notices].join("\n\n");
  const output: string[] = [], represented = new Set<string>();
  let omittedParts = 0, used = tokens(prefix) + 96;
  for (const part of synopsis.parts) {
    const body = `${synopsis.mode === "disjoint-original-parts" ? `### Independent original-source account ${part.id}\n\n` : ""}${renderHistorySynopsisPart(part)}`;
    const cost = tokens(body) + 2;
    if (used + cost > maximum) { omittedParts++; continue; }
    used += cost; output.push(body); part.unitIds.forEach(id => represented.add(id));
  }
  const text = [prefix, ...output, ...(omittedParts ? [`[${omittedParts} whole synopsis accounts omitted from this bounded rendering. Original source recovery remains available.]`] : [])].join("\n\n");
  if (tokens(text) > maximum || !output.length) return undefined;
  return { ruleset: "chrono-interval-render-v1", text, tokens: tokens(text),
    representedUnitIds: units.filter(unit => represented.has(unit.id)).map(unit => unit.id),
    omittedUnitIds: units.filter(unit => !represented.has(unit.id)).map(unit => unit.id),
    sourceEntryIds: view.events.map(event => event.entryId), lossy: true };
}

/** Original interval compiler. Persist only source bindings, selected C and
 * derived products. The public runtime adds C and the distinct continuation. */
export function compileIntervalContext(input: FrozenContextInput): CompiledContext {
  const snapshot = input.interval, submitted = input.sessionSummary;
  if (!snapshot || !submitted?.handoff || !submitted.continuation || !submitted.authorship || input.history.kind !== "interval") fail("handoff-required");
  const plan = planIntervalContext(snapshot, input.budget), { layers } = plan;
  let partition = plan.partition;
  const c = projectIntervalSource(snapshot, "exact", partition.rawStart, partition.endExclusive);
  const exact = chargeRawTail(c.events.map(event => event.projectedEntry));
  if (exact.tokens !== partition.exactTokens || exact.messages !== partition.exactMessages) fail("exact-charge-changed");
  const continuationMessage = intervalContinuationMessage(submitted.continuation, submitted.authorship);
  const continuationTokens = convertToLlm([continuationMessage]).reduce((sum, message) => sum + estimateTokens(message) + 32, 0);
  const handoff = `# Current task handoff\n\n[Authorship: ${submitted.authorship}. Derived session context, not new authorization.]\n\n${submitted.handoff.trim()}`;
  const technicalBoundaryTokens = input.rawTail.tokens;
  // Technical native boundary is removed by the public projection. Charge it
  // anyway so the native stored form and the expanded form both fit.
  const remaining = layers.effectiveAvailableTokens - exact.tokens - continuationTokens - technicalBoundaryTokens - chargeCompactionSummary(handoff) - 64;
  if (remaining < 512) fail("required-content-oversized");
  const aMaximum = Math.max(256, Math.min(layers.activePrefixTokens, Math.floor(remaining / 3)));
  const bMaximum = Math.max(256, Math.min(layers.compressedHistoryTokens, remaining - aMaximum));
  const relevance = input.history.relevance, ready = input.history.ready;
  const renderHistory = (selected: IntervalPartition, prefixCandidate?: IntervalReadyAlternative) => {
    const a = projectIntervalSource(snapshot, "synopsis", selected.start, selected.compressedStart);
    const b = projectIntervalSource(snapshot, "event", selected.compressedStart, selected.rawStart);
    const candidates = (ready?.eventAlternatives ?? []).slice(0, 32).filter(product =>
      validateIntervalEventProduct(snapshot, product, selected.compressedStart, selected.rawStart));
    const alternatives = applyIntervalEventAlternatives(b, candidates);
    const helperEntryIds = new Set(alternatives.events.filter((event, index) => event.projectedEntry !== b.events[index]?.projectedEntry)
      .map(event => event.entryId));
    const aUnits = unitsFromView(snapshot, a), bUnits = unitsFromView(snapshot, { ...b, events: alternatives.events });
    const compatible = a.events.length > 0 && !!prefixCandidate && validateIntervalReadyProduct(snapshot, prefixCandidate,
      { role: "activePrefix", start: selected.start, endExclusive: selected.compressedStart,
        modelIdentity: prefixCandidate.input.derivation.modelIdentity });
    const helperPrefix = compatible ? renderPrefix(prefixCandidate!, a, aUnits, aMaximum) : undefined;
    if (prefixCandidate && !helperPrefix) return undefined;
    const prefix = helperPrefix ?? renderIntervalHistory({ kind: "active-prefix-fallback", units: aUnits, maxTokens: aMaximum,
      coverageLabel: label("A", a), relevance });
    const usedPrefix = !!helperPrefix;
    const compressed = renderIntervalHistory({ kind: "compressed-history", units: bUnits, maxTokens: bMaximum,
      coverageLabel: label("B", b), relevance, helperEntryIds });
    const eventArtifactKeys = alternatives.acceptedArtifactKeys.filter(key => candidates.some(product =>
      product.artifact.key === key && product.input.eventUnit && compressed.representedUnitIds.includes(product.input.eventUnit.id)));
    return { a, prefix, compressed, usedPrefix, prefixCandidate, eventArtifactKeys,
      summary: [handoff, prefix.text, compressed.text].join("\n\n") };
  };
  const requestFits = (summary: string): boolean => {
    const context = chargeCompactionSummary(summary) + exact.tokens + continuationTokens + technicalBoundaryTokens;
    return context <= layers.effectiveAvailableTokens && context + input.budget.systemTokens + input.budget.toolSchemaTokens
      + input.budget.framingTokens + Math.max(input.budget.responseReserveTokens, layers.reserveTokens) + layers.safetyTokens <= input.budget.model.contextWindow;
  };
  // Enumerate exact-compatible ready ranges before committing to a newly planned
  // H. Later appended work belongs to B/C, never to the pinned A derivation.
  const prefixCandidates = [...(ready?.activePrefixCandidates ?? []).slice(0, INTERVAL_READY_PREFIX_CANDIDATE_LIMIT)];
  if (ready?.activePrefix && !prefixCandidates.some(candidate => candidate.artifact.key === ready.activePrefix!.artifact.key)
    && prefixCandidates.length < INTERVAL_READY_PREFIX_CANDIDATE_LIMIT) prefixCandidates.push({ ...ready.activePrefix, compressedStart: partition.compressedStart });
  const readyPartitions = readyIntervalPartitions({ partition, units: plan.units, hints: cutHints(snapshot),
    compressedHistoryTokens: layers.compressedHistoryTokens, compressedStarts: prefixCandidates.map(candidate => candidate.compressedStart) });
  let selectedHistory: ReturnType<typeof renderHistory> | undefined;
  for (const candidatePartition of readyPartitions) {
    for (const candidate of prefixCandidates.filter(product => product.compressedStart === candidatePartition.compressedStart)) {
      try {
        const rendered = renderHistory(candidatePartition, candidate);
        if (!rendered) continue;
        const newestB = plan.units[candidatePartition.prefixUnitCount + candidatePartition.compressedUnitCount - 1];
        const usefulB = candidatePartition.compressedUnitCount === 0
          ? plan.partition.compressedUnitCount === 0 : !!newestB && rendered.compressed.representedUnitIds.includes(newestB.id);
        if (!rendered.usedPrefix || !usefulB || !requestFits(rendered.summary)) continue;
        partition = candidatePartition; selectedHistory = rendered; break;
      } catch { /* Optional invalid or oversized products do not block deterministic history. */ }
    }
    if (selectedHistory) break;
  }
  // A/B may be empty. Reuse at the planned cut can still be valid when B is
  // absent, but it must not discard a nonempty recent window for a cache hit.
  const rendered = selectedHistory
    ?? (partition.compressedUnitCount === 0 && ready?.activePrefix ? renderHistory(partition, ready.activePrefix) : undefined)
    ?? renderHistory(partition)!;
  const { a, prefix, compressed, usedPrefix, prefixCandidate, eventArtifactKeys, summary } = rendered;
  const ranges = partitionIntervalSource(snapshot, partition.compressedStart, partition.rawStart);
  const summaryTextTokens = tokens(summary), summaryMessageTokens = chargeCompactionSummary(summary);
  const contextTokens = summaryMessageTokens + exact.tokens + continuationTokens + technicalBoundaryTokens;
  const estimatedRequestTokens = contextTokens + input.budget.systemTokens + input.budget.toolSchemaTokens + input.budget.framingTokens;
  const estimatedRequestWithReserveTokens = estimatedRequestTokens + Math.max(input.budget.responseReserveTokens, layers.reserveTokens) + layers.safetyTokens;
  if (contextTokens > layers.effectiveAvailableTokens || estimatedRequestWithReserveTokens > input.budget.model.contextWindow) fail("final-budget-exceeded");
  const activePrefix: IntervalHistoryReceipt["activePrefix"] = { ...renderingReceipt(prefix),
    method: a.events.length === 0 ? "empty" : usedPrefix
      ? prefixCandidate!.artifact.synopsis!.mode === "whole-range" ? "range-synopsis" : "independent-original-parts"
      : "deterministic-fallback",
    ...(usedPrefix ? { artifactKey: prefixCandidate!.artifact.key, modelIdentity: prefixCandidate!.artifact.derivation.modelIdentity,
      helperCoverage: prefixCandidate!.artifact.coverage } : {}) };
  const history: ContextSelectionReceipt["history"] = { kind: "interval", receipt: {
    ruleset: "chrono-interval-compiler-v1", snapshotId: snapshot.identity, sourceHash: snapshot.sourceHash,
    projectionHash: snapshot.projectionHash, ranges, coverage: snapshot.coverage, exclusions: snapshot.exclusions,
    policy: layers, activePrefix, compressedHistory: { ...renderingReceipt(compressed), eventArtifactKeys },
    continuationTokens, technicalBoundaryTokens,
  } };
  const source = { source: snapshot.source, origin: snapshot.origin, endEntryId: snapshot.endEntryId,
    sourceHash: snapshot.sourceHash, projectionHash: snapshot.projectionHash, bounds: snapshot.bounds,
    controlIdentities: snapshot.controlIdentities, segments: snapshot.segments };
  const restart = { schemaVersion: 1 as const, snapshotId: snapshot.identity, source, partition, exactTail: c.events,
    ...(input.logicalSource ? { logicalSource: input.logicalSource } : {}),
    continuation: { text: submitted.continuation, authorship: submitted.authorship },
    ...(input.rawTail.messages > 0 ? { technicalBoundaryEntryId: input.firstKeptEntryId } : {}) };
  const selectedNative: NativeSelectionRef[] = [];
  const omittedNative = input.native.providers.flatMap(provider => (provider.page?.cards ?? []).map((card, cardIndex) => ({
    providerId: provider.providerId, cardIndex, id: card.id, revision: card.revision,
  })));
  const { requestId: _transportId, ...stableNative } = input.native;
  const inputHash = hash({ ruleset: "chrono-interval-compiler-v1", scope: input.scope, source, snapshotId: snapshot.identity,
    firstKeptEntryId: input.firstKeptEntryId, nativeRetention: input.nativeRetention, logicalSource: input.logicalSource,
    sessionSummary: submitted, native: stableNative, budget: input.budget,
    memoryOwner: input.memoryOwner, rawTail: input.rawTail, history, renderedSummaryHash: textHash(summary) });
  const receipt: ContextSelectionReceipt = {
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
  if (Buffer.byteLength(JSON.stringify(receipt)) > CONTEXT_COMPILER_LIMITS.intervalReceiptBytes) fail("receipt-transport-bound");
  return freeze({ summary, firstKeptEntryId: input.firstKeptEntryId, receipt });
}
