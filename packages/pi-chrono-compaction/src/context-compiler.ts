import { createHash } from "node:crypto";
import { copyPlainData, sameScope, validateScope, type ContextScope } from "@context-kit/protocol";
import type { ContextCollection } from "@context-kit/protocol/collect";
import type { ShadowComposerInput, ShadowCompositionArtifact, ShadowCompositionEnvelope } from "./context-composer.js";
import type { renderBoundedMemory, BoundedMemorySelection } from "./bounded-memory.js";
import { renderChronologicalReplay, type ChronologicalReplaySelection } from "./chronological-replay.js";
import { chargeCompactionSummary, CONTEXT_ESTIMATOR, resolveContextCeiling, type ContextBudget } from "./context-budget.js";
import type { IntervalSourceSnapshot, IntervalSourceEvent } from "./interval-source.js";
import type { IntervalPartition } from "./interval-partition.js";
import type { LogicalIntervalSourceManifest } from "./interval-logical-source.js";
import { compileIntervalContext, type IntervalHistoryReceipt, type IntervalReadyHistory } from "./interval-compiler.js";
import { SESSION_AGENT_SUMMARY_LIMITS } from "./session-agent-summary.js";

export const CONTEXT_COMPILER_RULESET = "chrono-context-compiler-session-v1" as const;
export const INTERVAL_CONTEXT_COMPILER_RULESET = "chrono-context-compiler-interval-v1" as const;
export const CONTEXT_COMPILER_LIMITS = Object.freeze({ inputBytes: 1024 * 1024, receiptBytes: 768 * 1024,
  intervalReceiptBytes: 16 * 1024 * 1024, nativeBytes: 32768, locatorEntries: 256 });
export type CompilerHistory =
  | { readonly kind: "stored"; readonly input: ShadowComposerInput }
  | { readonly kind: "fallback"; readonly selection: BoundedMemorySelection }
  | { readonly kind: "events"; readonly selection: ChronologicalReplaySelection }
  | { readonly kind: "interval"; readonly relevance: readonly string[]; readonly ready?: IntervalReadyHistory };
export interface SessionSummaryInput {
  /** Retained for old receipt readers. Fresh interval inputs also bind handoff. */
  readonly text: string;
  readonly handoff?: string;
  readonly continuation?: string;
  readonly authorship?: "current-agent" | "deterministic-recovery";
  readonly requestId: string;
  readonly requestLeafId: string;
  readonly consumedBoundaryLeafId: string;
  readonly submissionEntryId: string;
  readonly submissionToolCallId: string;
  readonly relevanceHints: readonly string[];
}
export interface FrozenContextInput {
  /** Current native state uses the FULL leaf, not the historical prefix cut. */
  readonly scope: ContextScope;
  readonly sourceCutEntryId: string;
  readonly firstKeptEntryId: string;
  /** Pre-commit intent only. Native Pi later records self-retention for none. */
  readonly nativeRetention?: { readonly kind: "none"; readonly operationId: string };
  readonly memoryOwner: "chrono" | "context-kit";
  readonly native: ContextCollection;
  readonly history: CompilerHistory;
  /** Submitted by the current session agent and validated by the public-hook caller. */
  readonly sessionSummary?: SessionSummaryInput;
  /** Original work pinned before the generated handoff exchange. */
  readonly interval?: IntervalSourceSnapshot;
  /** Verified original-shard bindings for recapture after a physical rollover. */
  readonly logicalSource?: LogicalIntervalSourceManifest;
  readonly budget: ContextBudget;
  readonly rawTail: { readonly tokens: number; readonly messages: number; readonly toolPairSafe: boolean };
}
export interface NativeSelectionRef { readonly providerId: string; readonly cardIndex: number; readonly id: string; readonly revision: string }
type FallbackReceipt = ReturnType<typeof renderBoundedMemory>["receipt"];
export interface ContextSelectionReceipt {
  readonly schemaVersion: 4;
  readonly ruleset: typeof CONTEXT_COMPILER_RULESET | typeof INTERVAL_CONTEXT_COMPILER_RULESET;
  readonly receiptId: string;
  readonly inputHash: string;
  readonly selectionHash: string;
  readonly summaryHash: string;
  readonly scope: ContextScope;
  readonly sourceCutEntryId: string;
  readonly firstKeptEntryId: string;
  readonly nativeRetention?: { readonly kind: "none"; readonly operationId: string };
  readonly memoryOwner: "chrono" | "context-kit";
  /** Full admitted pages, each card stored once. Transport ID is diagnostic only. */
  readonly native: ContextCollection;
  readonly selectedNative: readonly NativeSelectionRef[];
  readonly omittedNative: readonly NativeSelectionRef[];
  readonly unresolvedRelations: readonly { readonly from: NativeSelectionRef; readonly providerId: string; readonly id: string; readonly type: string }[];
  readonly history: { readonly kind: "stored"; readonly envelope: ShadowCompositionEnvelope; readonly artifact: ShadowCompositionArtifact }
    | { readonly kind: "fallback"; readonly receipt: FallbackReceipt }
    | { readonly kind: "events"; readonly receipt: ReturnType<typeof renderChronologicalReplay>["receipt"] }
    | { readonly kind: "interval"; readonly receipt: IntervalHistoryReceipt };
  readonly sessionSummary?: SessionSummaryInput;
  /** Exact native tail and continuation are expanded by a source-bound context hook. */
  readonly restart?: IntervalRestartReceipt;
  readonly budget: ContextBudget & {
    readonly rawTailTokens: number; readonly rawTailMessages: number; readonly nativeRenderedTokens: number;
    readonly summaryTextTokens: number; readonly summaryMessageTokens: number; readonly summaryFramingTokens: number;
    readonly historyAndNoticesTokens: number; readonly contextTokens: number; readonly estimatedRequestTokens: number;
    readonly estimatedRequestWithReserveTokens: number;
  };
  readonly validation: { readonly wholeAdmittedRecords: boolean; readonly toolPairSafe: true; readonly estimatedRequestFits: true;
    readonly nativeComplete: boolean; readonly distributedSnapshot: false; readonly exactModelTokenCount: false };
}
export interface IntervalRestartReceipt {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly logicalSource?: LogicalIntervalSourceManifest;
  readonly source: Pick<IntervalSourceSnapshot, "source" | "origin" | "endEntryId" | "sourceHash" | "projectionHash" | "bounds" | "controlIdentities" | "segments">;
  readonly partition: IntervalPartition;
  readonly exactTail: readonly IntervalSourceEvent[];
  readonly continuation: { readonly text: string; readonly authorship: "current-agent" | "deterministic-recovery" };
  readonly technicalBoundaryEntryId?: string;
}
export interface CompiledContext { readonly summary: string; readonly firstKeptEntryId: string; readonly receipt: ContextSelectionReceipt }

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, value]) => value !== undefined).map(([key, value]) => [key, sort(value)])) : item;
  return JSON.stringify(sort(value));
}
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const tokens = (text: string): number => Math.ceil(text.length / 4);
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The caller adapts trusted bounded history. Native input has already passed the
 * shared collector's validation. Detach it again before selection and persistence. */
export function freezeContextInput(input: FrozenContextInput): FrozenContextInput {
  const scope = validateScope(input.scope);
  const native = copyPlainData(input.native, CONTEXT_COMPILER_LIMITS.nativeBytes * 2) as ContextCollection;
  if (Buffer.byteLength(JSON.stringify(native)) > CONTEXT_COMPILER_LIMITS.nativeBytes || !sameScope(scope, native.scope)) throw new Error("context-v4-native-scope-invalid");
  // Source capture already detached and froze originals under its own bounds.
  // Do not duplicate the entire A/B payload into the small compiler envelope.
  const { interval, ...envelope } = input;
  const ready = input.history.kind === "interval" ? input.history.ready : undefined;
  if (interval && (!Object.isFrozen(interval) || !/^chrono-interval:[a-f0-9]{64}$/.test(interval.identity)
    || interval.endEntryId !== input.sourceCutEntryId || input.history.kind !== "interval")) throw new Error("context-v4-interval-input-invalid");
  if (!interval && input.history.kind === "interval") throw new Error("context-v4-interval-source-required");
  const serialized = JSON.stringify({ ...envelope, scope, native,
    ...(interval && input.history.kind === "interval" ? { history: { kind: "interval", relevance: input.history.relevance } } : {}) });
  if (Buffer.byteLength(serialized) > CONTEXT_COMPILER_LIMITS.inputBytes) throw new Error("context-v4-input-budget");
  const parsed = JSON.parse(serialized);
  const detached = { ...parsed, ...(interval ? { interval, history: { ...parsed.history, ...(ready ? { ready } : {}) } } : {}) } as FrozenContextInput;
  const budget = detached.budget;
  if (detached.logicalSource && (!interval || detached.logicalSource.ruleset !== "chrono-logical-original-source-v1"
    || !/^chrono-logical-original:[a-f0-9]{64}$/.test(detached.logicalSource.identity)
    || detached.logicalSource.endEntryId !== interval.endEntryId
    || canonical(detached.logicalSource.source) !== canonical(interval.source))) throw new Error("context-v4-logical-source-binding-invalid");
  if (budget.estimator !== CONTEXT_ESTIMATOR || budget.effectiveCeilingTokens !== resolveContextCeiling(budget.configuredTokens,
    budget.model.contextWindow, budget.systemTokens + budget.toolSchemaTokens + budget.framingTokens, budget.responseReserveTokens)
    || !Number.isSafeInteger(detached.rawTail.tokens) || detached.rawTail.tokens < 0
    || !Number.isSafeInteger(detached.rawTail.messages) || detached.rawTail.messages < 0 || !detached.rawTail.toolPairSafe
    || !detached.sourceCutEntryId || !detached.firstKeptEntryId || !scope.leafId) throw new Error("context-v4-input-invalid");
  if (detached.nativeRetention && (!interval || detached.nativeRetention.kind !== "none"
    || !detached.nativeRetention.operationId || detached.firstKeptEntryId !== `retain-none:${detached.nativeRetention.operationId}`
    || detached.rawTail.tokens !== 0 || detached.rawTail.messages !== 0)) throw new Error("context-v4-retention-intent-invalid");
  if (!detached.nativeRetention && detached.firstKeptEntryId.startsWith("retain-none:")) throw new Error("context-v4-retention-intent-required");
  if (detached.history.kind !== "interval") {
    const cut = detached.history.kind === "stored" ? detached.history.input.cut : detached.history.selection;
    if (cut.firstKeptEntryId !== detached.firstKeptEntryId || cut.sourceCutEntryId !== detached.sourceCutEntryId) throw new Error("context-v4-history-cut-invalid");
  }
  // Old stored inputs remain readable, but cannot substitute for a session-agent summary.
  const summary = detached.sessionSummary;
  if (summary && (typeof summary.text !== "string" || !summary.text.trim()
    || summary.text.length > (interval ? SESSION_AGENT_SUMMARY_LIMITS.summaryChars : 16_384)
    || Buffer.byteLength(summary.text) > (interval ? SESSION_AGENT_SUMMARY_LIMITS.summaryBytes : 24 * 1024) || !summary.requestId || !summary.requestLeafId
    || !summary.consumedBoundaryLeafId || !summary.submissionEntryId || !summary.submissionToolCallId
    || !Array.isArray(summary.relevanceHints) || summary.relevanceHints.length > 8
    || summary.relevanceHints.some(term => typeof term !== "string" || term.length > 256))) throw new Error("context-v4-session-summary-invalid");
  if (interval && (!summary || summary.handoff !== summary.text || !summary.continuation?.trim()
    || summary.continuation.length > SESSION_AGENT_SUMMARY_LIMITS.continuationChars
    || Buffer.byteLength(summary.continuation) > SESSION_AGENT_SUMMARY_LIMITS.continuationBytes
    || summary.text.length + summary.continuation.length > SESSION_AGENT_SUMMARY_LIMITS.summaryChars
    || Buffer.byteLength(summary.text) + Buffer.byteLength(summary.continuation) > SESSION_AGENT_SUMMARY_LIMITS.summaryBytes
    || !["current-agent", "deterministic-recovery"].includes(summary.authorship ?? ""))) throw new Error("context-v4-interval-handoff-required");
  return freeze(detached);
}

/** Pure deterministic compiler. Preview and active return call this exact path.
 * Input pages are frozen record captures, not a transaction across state owners. */
export function compileContext(raw: FrozenContextInput): CompiledContext {
  const input = freezeContextInput(raw);
  if (input.interval) return compileIntervalContext(input);
  // Compatibility for saved preview inputs only. Fresh runtime capture requires
  // an original interval and cannot fall back to this historical replay path.
  if (!input.sessionSummary || input.history.kind !== "events") throw new Error("context-v4-session-summary-required");
  const { requestId: _transportId, ...stableNative } = input.native;
  const inputHash = hash({ ...input, native: stableNative });
  const receiptId = `chrono-v4:${inputHash}`;
  const continuation = `# Continuation summary\n\n${input.sessionSummary.text.trim()}\n\nThis summary is derived session context, not new authorization.`;
  // Native pages stay in the receipt. Current cards can guide replay detail,
  // but they do not rewrite the agent's summary or create a second state dump.
  const selectedNative: NativeSelectionRef[] = [];
  const omittedNative = input.native.providers.flatMap(provider => (provider.page?.cards ?? []).map((card, cardIndex) => ({
    providerId: provider.providerId, cardIndex, id: card.id, revision: card.revision,
  })));
  const available = input.budget.effectiveCeilingTokens - input.rawTail.tokens - chargeCompactionSummary(continuation) - 8;
  if (available < 128) throw new Error("context-v4-budget-unavailable");
  const replay = renderChronologicalReplay(input.history.selection, available);
  const summary = `${continuation}\n\n${replay.text}`;
  const history: ContextSelectionReceipt["history"] = { kind: "events", receipt: replay.receipt };
  const summaryTextTokens = tokens(summary), summaryMessageTokens = chargeCompactionSummary(summary);
  const contextTokens = summaryMessageTokens + input.rawTail.tokens;
  const estimatedRequestTokens = contextTokens + input.budget.systemTokens + input.budget.toolSchemaTokens + input.budget.framingTokens;
  const estimatedRequestWithReserveTokens = estimatedRequestTokens + input.budget.responseReserveTokens;
  if (contextTokens > input.budget.effectiveCeilingTokens || estimatedRequestWithReserveTokens > input.budget.model.contextWindow) throw new Error("context-v4-final-budget-exceeded");
  const receipt: ContextSelectionReceipt = {
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
  if (Buffer.byteLength(JSON.stringify(receipt)) > CONTEXT_COMPILER_LIMITS.receiptBytes) throw new Error("context-v4-receipt-budget");
  return freeze({ summary, firstKeptEntryId: input.firstKeptEntryId, receipt });
}

export interface ContextReceiptLocator {
  readonly receiptId: string;
  readonly compactionEntryId: string;
  readonly sessionId: string;
  readonly summaryHash: string;
  readonly recovery: { readonly tool: "history_get"; readonly args: { readonly entryId: string } };
}
/** Read only bounded metadata from one already-loaded entry. No catalog/store I/O. */
export function contextReceiptLocator(entry: { id?: string; type?: string; fromHook?: boolean; details?: unknown }, sessionId: string): ContextReceiptLocator | undefined {
  const receipt = (entry.details as { contextReceipt?: Partial<ContextSelectionReceipt> } | undefined)?.contextReceipt;
  if (entry.type !== "compaction" || entry.fromHook !== true || !entry.id || !receipt
    || ![CONTEXT_COMPILER_RULESET, INTERVAL_CONTEXT_COMPILER_RULESET, "chrono-context-compiler-v4"].includes(receipt?.ruleset ?? "")
    || typeof receipt.receiptId !== "string" || !/^chrono-v4:[a-f0-9]{64}$/.test(receipt.receiptId)
    || typeof receipt.summaryHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.summaryHash)
    || receipt.scope?.sessionId !== sessionId) return undefined;
  return { receiptId: receipt.receiptId, compactionEntryId: entry.id, sessionId, summaryHash: receipt.summaryHash,
    recovery: { tool: "history_get", args: { entryId: entry.id } } };
}
