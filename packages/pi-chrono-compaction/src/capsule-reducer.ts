import { createHash } from "node:crypto";
import {
  CAPSULE_LIMITS,
  CAPSULE_SCHEMA_VERSION,
  isReducerEnvelope,
  isSourceBlockReducerInput,
  type CapsuleAlternative,
  type CapsuleFact,
  type CapsuleOmission,
  type CapsuleReductionOptions,
  type PairedCallContext,
  type ProtectedCue,
  type ProtectedCueKind,
  type ReducerEnvelope,
  type ScopedBodySourceRef,
  type SourceBlockReducerBaseInput,
  type SourceBlockReducerInput,
  type SourceReducerFamily,
  type SourceStructuralField,
} from "./capsule-contract.js";
import { reduceAssistantProse } from "./reducers/assistant.js";
import { reduceDiff } from "./reducers/diff.js";
import { reduceGenericText } from "./reducers/generic.js";
import { parseStructuredJson, reduceStructuredJson } from "./reducers/json.js";
import { normalizeTerminalText } from "./reducers/normalize.js";
import { reduceTerminalOutput } from "./reducers/terminal.js";
import { reduceTestOutput } from "./reducers/test-output.js";
import type { ReducerContext, ReducerResult } from "./reducers/types.js";
import type { HistoricalBlock, OmissionNotice } from "./types.js";
import { estimateTokensFromText, stableStringify } from "./utils.js";

export const CAPSULE_REDUCER_FAMILY_VERSIONS: Readonly<Record<SourceReducerFamily, string>> = Object.freeze({
  terminal: "7.0.0",
  "test-output": "6.0.0",
  "git-diff": "6.0.0",
  "generic-text": "6.0.0",
  "assistant-extractive": "6.0.0",
  "assistant-cleanup": "6.0.0",
  "lossless-normalizer": "6.0.0",
  "small-json": "7.0.0",
});

export interface CapsuleReducerOptions extends CapsuleReductionOptions {
  /** Supplied only after the caller has verified earlier ancestry. No lookup occurs here. */
  readonly pair?: PairedCallContext;
}

export const CAPSULE_REDUCER_DEFAULT_BUDGET = Object.freeze({
  maxTokens: 4_096,
  maxUtf16Units: 16 * 1024,
  maxAlternatives: 3,
});

const CUE_PATTERNS: readonly { readonly kind: ProtectedCueKind; readonly regex: RegExp }[] = [
  { kind: "pending-approval", regex: /\b(?:pending approval|awaiting approval|requires? approval|approval (?:is )?(?:pending|required))\b/giu },
  { kind: "cancelled", regex: /\b(?:cancelled|canceled|cancellation|was aborted)\b/giu },
  { kind: "condition", regex: /\b(?:if|unless|when|whenever|provided that|only if)\b/giu },
  { kind: "exception", regex: /\b(?:except|exception|however|but not|other than)\b/giu },
  { kind: "negation", regex: /\b(?:not|never|no|cannot|can't|must not|do not|don't|without)\b/giu },
  { kind: "failure", regex: /\b(?:failed|failure|error|fatal|panic|exception|timed out|timeout|exit code\s*[1-9][0-9]*(?![\p{L}\p{N}_]))\b/giu },
  { kind: "unknown", regex: /\b(?:unknown|unresolved|uncertain|not yet|still pending|open question)\b/giu },
  { kind: "restriction", regex: /\b(?:must|must not|only|required|prohibited|forbidden|do not|don't|never)\b/giu },
  { kind: "identifier", regex: /(?:https?:\/\/[^\s)\]}>"']{1,240}(?![^\s)\]}>"'])|(?:\.{0,2}\/|~\/)[A-Za-z0-9_.@+\-/]{2,240}(?![A-Za-z0-9_.@+\-/])|\b[0-9a-f]{8}-[0-9a-f-]{27,56}\b|\b[A-Fa-f0-9]{12,64}\b)/gu },
];

export function extractProtectedCues(
  text: string,
  absoluteStart: number,
  source: ScopedBodySourceRef,
): ProtectedCue[] {
  const cues: ProtectedCue[] = [];
  for (const pattern of CUE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      if (match.index === undefined || match[0].length === 0) continue;
      const start = absoluteStart + match.index;
      cues.push({
        kind: pattern.kind,
        source,
        decodedUtf16: { start, end: start + match[0].length },
        exactText: match[0],
      });
    }
  }
  return cues.sort((a, b) => a.decodedUtf16.start - b.decodedUtf16.start
    || a.decodedUtf16.end - b.decodedUtf16.end || a.kind.localeCompare(b.kind));
}

function capsuleFacts(base: SourceBlockReducerBaseInput, cues: readonly ProtectedCue[]): CapsuleFact[] {
  const facts: CapsuleFact[] = [];
  const add = (name: SourceStructuralField, value: string | number | boolean): void => {
    const source = base.structural.sources?.[name];
    if (source === undefined) throw new Error("capsule-reducer-missing-structural-source");
    facts.push({ kind: "structural", name, value, source });
  };
  if (base.structural.role !== undefined) add("role", base.structural.role);
  if (base.structural.toolName !== undefined) add("toolName", base.structural.toolName);
  if (base.structural.toolCallId !== undefined) add("toolCallId", base.structural.toolCallId);
  if (base.structural.exitCode !== undefined) add("exitCode", base.structural.exitCode);
  if (base.structural.isError !== undefined) add("isError", base.structural.isError);
  if (base.structural.cancelled !== undefined) add("cancelled", base.structural.cancelled);
  if (base.structural.originallyTruncated !== undefined) add("originallyTruncated", base.structural.originallyTruncated);
  for (const cue of cues) {
    if (cue.kind !== "pending-approval") continue;
    facts.push({ kind: "extractive", name: "pendingApproval", value: cue.exactText, source: base.source, decodedUtf16: cue.decodedUtf16 });
  }
  return facts;
}

function outcome(facts: readonly CapsuleFact[]): CapsuleAlternative["outcome"] {
  const index = (name: string, predicate: (value: CapsuleFact["value"]) => boolean): number | undefined => {
    const found = facts.findIndex((fact) => fact.kind === "structural" && fact.name === name && predicate(fact.value));
    return found < 0 ? undefined : found;
  };
  const cancelled = index("cancelled", (value) => value === true);
  if (cancelled !== undefined) return { status: "supported", value: "cancelled", facts: [cancelled] };
  const isError = index("isError", (value) => value === true);
  if (isError !== undefined) return { status: "supported", value: "failure", facts: [isError] };
  const failedExit = index("exitCode", (value) => typeof value === "number" && value !== 0);
  if (failedExit !== undefined) return { status: "supported", value: "failure", facts: [failedExit] };
  const successExit = index("exitCode", (value) => value === 0);
  if (successExit !== undefined) return { status: "supported", value: "success", facts: [successExit] };
  // Extractive pending-approval text can be negated, quoted, or superseded later.
  // Keep it recoverable as a cue/fact, but do not promote it to an outcome.
  return { status: "unknown" };
}

function historicalBlock(base: SourceBlockReducerBaseInput, text: string): HistoricalBlock {
  return {
    id: `capsule:${base.source.eventSeq}:${base.source.descriptor}`,
    entryId: base.source.entryId ?? "",
    entryIndex: base.source.eventSeq,
    ...(base.source.blockIndex === undefined ? {} : { blockIndex: base.source.blockIndex }),
    kind: base.kind.replaceAll("-", "_") as HistoricalBlock["kind"],
    label: base.kind,
    exactText: text,
    rawTokens: estimateTokensFromText(text),
    sourceRefs: [{ entryId: base.source.entryId ?? "", ...(base.source.blockIndex === undefined ? {} : { blockIndex: base.source.blockIndex }) }],
    ...(base.structural.toolCallId === undefined ? {} : { toolCallId: base.structural.toolCallId }),
    ...(base.structural.toolName === undefined ? {} : { toolName: base.structural.toolName }),
    ...(base.structural.isError === true ? { isError: true } : {}),
    protectedExact: false,
    reproducible: false,
    unresolved: false,
    exactIdentifiers: [],
    attributes: {
      ...(base.structural.exitCode === undefined ? {} : { exitCode: base.structural.exitCode }),
      ...(base.structural.originallyTruncated === undefined ? {} : { truncated: base.structural.originallyTruncated }),
    },
  };
}

function runFamily(base: SourceBlockReducerBaseInput, text: string, options: CapsuleReducerOptions): ReducerResult {
  const block = historicalBlock(base, text);
  const context: ReducerContext = { block, maxTokens: options.budget.maxTokens, laterText: "" };
  switch (options.family) {
    case "terminal": return reduceTerminalOutput(context);
    case "test-output": return reduceTestOutput(context);
    case "git-diff": return reduceDiff(context);
    case "assistant-extractive": return reduceAssistantProse(context);
    case "assistant-cleanup": return reduceAssistantProse({ ...context, maxTokens: Math.max(options.budget.maxTokens, estimateTokensFromText(text)) });
    case "lossless-normalizer": {
      const normalized = normalizeTerminalText(text);
      return { text: normalized.text, reducer: "lossless-normalizer", version: "1.0.0", lossy: normalized.changed,
        omissions: normalized.omissions, metadata: normalized.metadata };
    }
    case "small-json": return reduceStructuredJson(context, parseStructuredJson(text)) ?? reduceGenericText(context);
    case "generic-text": return reduceGenericText(context);
  }
}

function transformationOmissions(
  notices: readonly OmissionNotice[],
  source: ScopedBodySourceRef,
  range: { readonly start: number; readonly end: number },
): CapsuleOmission[] {
  return notices.map((notice) => {
    const description = notice.description.slice(0, 512);
    const reason: Extract<CapsuleOmission, { kind: "transformation-loss" }>["reason"] = /repeat/i.test(description)
      ? "repeated"
      : /normaliz|ANSI|progress frame/i.test(description)
        ? "normalization"
        : /middle|hunk/i.test(description)
          ? "middle"
          : /budget|truncat|additional/i.test(description)
            ? "budget"
            : "routine";
    return {
      kind: "transformation-loss",
      reason,
      affectedSource: source,
      affectedDecodedUtf16: range,
      omittedUnits: "unknown",
      description,
    };
  });
}

function capText(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const marker = "\n…[capsule text budget omitted]…\n";
  const available = Math.max(0, maximum - marker.length);
  return `${text.slice(0, Math.ceil(available * 0.7))}${marker}${text.slice(-Math.floor(available * 0.3))}`;
}

function postReducerCapOmission(
  uncappedText: string,
  limit: number,
  source: ScopedBodySourceRef,
  affectedDecodedUtf16: { readonly start: number; readonly end: number },
): CapsuleOmission[] {
  if (uncappedText.length <= limit) return [];
  return [{
    kind: "transformation-loss",
    reason: "budget",
    affectedSource: source,
    affectedDecodedUtf16,
    omittedUnits: "unknown",
    description: "Post-reducer capsule text exceeded the fixed output budget; exact transformed omission count is unknown.",
  }];
}

function canonicalInputHash(base: SourceBlockReducerBaseInput, options: CapsuleReducerOptions): string {
  const identity = {
    capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION,
    catalogStoreKey: base.identity.catalogStoreKey,
    catalogGeneration: base.identity.catalogGeneration,
    derivedStoreKey: base.identity.storeKey,
    derivedSchemaVersion: base.identity.derivedSchemaVersion,
    reducerSetVersion: options.reducerSetVersion,
    configHash: options.configHash,
    eventSeq: base.source.eventSeq,
    ordinal: base.source.ordinal,
    descriptor: base.source.descriptor,
    blockIndex: base.source.blockIndex,
    field: base.source.field,
    raw: base.source.raw,
    decodedUtf16: base.source.decodedUtf16,
    bodyHashAlgorithm: base.source.bodyHashAlgorithm,
    bodyHash: base.source.bodyHash,
    kind: base.kind,
    provenance: base.provenance,
    structural: base.structural,
    family: options.family,
    familyVersion: options.familyVersion,
    budget: options.budget,
    pair: options.pair,
  };
  return createHash("sha256").update(stableStringify(identity), "utf8").digest("hex");
}

export interface CapsuleSelectedInput {
  readonly text: string;
  readonly decodedUtf16: { readonly start: number; readonly end: number };
  readonly protectedCues: readonly ProtectedCue[];
  readonly omissions: readonly CapsuleOmission[];
  readonly completeBody: boolean;
  /** Exact source-to-render mappings. Synthetic separators have no mapping. */
  readonly coverage?: readonly {
    readonly source: { readonly start: number; readonly end: number };
    readonly output: { readonly start: number; readonly end: number };
  }[];
  /** The mapped selection is itself the primary representation. */
  readonly preserveExactSelection?: boolean;
}

interface ExactCoverage {
  readonly source: { readonly start: number; readonly end: number };
  readonly output: { readonly start: number; readonly end: number };
}

function capMappedText(text: string, maximum: number, coverage: readonly ExactCoverage[]): {
  readonly text: string;
  readonly coverage: readonly ExactCoverage[];
  readonly capped: boolean;
} {
  if (text.length <= maximum) return { text, coverage, capped: false };
  const marker = "\n…[capsule text budget omitted]…\n";
  const available = Math.max(0, maximum - marker.length);
  const prefix = Math.ceil(available * 0.7), suffix = Math.floor(available * 0.3), suffixStart = text.length - suffix;
  const kept: ExactCoverage[] = [];
  const retain = (item: ExactCoverage, start: number, end: number, outputShift: number): void => {
    const from = Math.max(item.output.start, start), to = Math.min(item.output.end, end);
    if (to <= from) return;
    kept.push({ source: { start: item.source.start + from - item.output.start, end: item.source.start + to - item.output.start },
      output: { start: outputShift + from - start, end: outputShift + to - start } });
  };
  for (const item of coverage) { retain(item, 0, prefix, 0); retain(item, suffixStart, text.length, prefix + marker.length); }
  return { text: `${text.slice(0, prefix)}${marker}${text.slice(suffixStart)}`, coverage: kept, capped: true };
}

function exactCoverageOmissions(source: ScopedBodySourceRef, coverage: readonly ExactCoverage[]): CapsuleOmission[] {
  const ranges = coverage.map(item => item.source).filter(item => item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const item of ranges) {
    const previous = merged.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  const omissions: CapsuleOmission[] = [];
  let cursor = source.decodedUtf16.start;
  for (const item of merged) {
    if (item.start > cursor) omissions.push({ kind: "exact-range", reason: "middle", source,
      decodedUtf16: { start: cursor, end: item.start }, omittedUnits: item.start - cursor,
      description: "Source interval absent from the final exact capsule representation; exact source remains recoverable." });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < source.decodedUtf16.end) omissions.push({ kind: "exact-range", reason: "middle", source,
    decodedUtf16: { start: cursor, end: source.decodedUtf16.end }, omittedUnits: source.decodedUtf16.end - cursor,
    description: "Source interval absent from the final exact capsule representation; exact source remains recoverable." });
  return omissions;
}

/** Internal integration point shared with the bounded streaming reducer. */
export function buildReducerEnvelope(
  base: SourceBlockReducerBaseInput,
  options: CapsuleReducerOptions,
  selected: CapsuleSelectedInput,
): ReducerEnvelope {
  if (options.familyVersion !== CAPSULE_REDUCER_FAMILY_VERSIONS[options.family]) throw new Error("capsule-reducer-family-version");
  if (options.reducerSetVersion !== base.identity.reducerSetVersion || options.configHash !== base.identity.configHash) {
    throw new Error("capsule-reducer-identity-mismatch");
  }
  const result = runFamily(base, selected.text, options);
  const facts = capsuleFacts(base, selected.protectedCues);
  const structuralSourceRefs = Object.values(base.structural.sources ?? {});
  const sourceRefs = [
    ...(options.pair === undefined ? [] : [options.pair.call]),
    base.source,
    ...structuralSourceRefs,
  ];
  const cueText = selected.protectedCues.length === 0 ? "" : `\n\nProtected exact cues:\n${selected.protectedCues.map((cue) => cue.exactText).join("\n")}`;
  // Streaming selections can exceed the old 8 KiB convenience target while
  // remaining below the frozen wire and caller budgets. Their exact mapping is
  // clipped together with the text, so omission ranges describe final bytes.
  const textLimit = Math.min(options.budget.maxUtf16Units, CAPSULE_LIMITS.reducerOutputUnits,
    selected.preserveExactSelection ? 16 * 1024 : 8 * 1024);
  const uncappedPrimary = selected.preserveExactSelection ? selected.text : `${result.text}${cueText}`;
  const mapped = selected.preserveExactSelection
    ? capMappedText(uncappedPrimary, textLimit, selected.coverage ?? [])
    : { text: capText(uncappedPrimary, textLimit), coverage: [] as readonly ExactCoverage[], capped: uncappedPrimary.length > textLimit };
  const primaryOmissions = selected.preserveExactSelection
    ? [...exactCoverageOmissions(base.source, mapped.coverage), ...selected.omissions,
      ...(mapped.capped ? postReducerCapOmission(uncappedPrimary, textLimit, base.source, selected.decodedUtf16) : [])]
    : [...selected.omissions, ...transformationOmissions(result.omissions, base.source, selected.decodedUtf16),
      ...postReducerCapOmission(uncappedPrimary, textLimit, base.source, selected.decodedUtf16)];
  const alternatives: CapsuleAlternative[] = [{
    alternative: 0,
    family: options.family,
    familyVersion: options.familyVersion,
    maxTokens: options.budget.maxTokens,
    text: mapped.text,
    lossy: true,
    facts,
    protectedCues: selected.protectedCues,
    omissions: primaryOmissions,
    outcome: outcome(facts),
    sourceRefs,
  }];
  const normalized = normalizeTerminalText(selected.text);
  if (!selected.preserveExactSelection && options.budget.maxAlternatives > 1 && normalized.text !== result.text) {
    const uncappedNormalized = `${normalized.text}${cueText}`;
    alternatives.push({
      ...alternatives[0]!,
      alternative: 1,
      text: capText(uncappedNormalized, textLimit),
      omissions: [
        ...selected.omissions,
        ...transformationOmissions(normalized.omissions, base.source, selected.decodedUtf16),
        ...postReducerCapOmission(uncappedNormalized, textLimit, base.source, selected.decodedUtf16),
      ],
    });
  }
  if (!selected.preserveExactSelection && selected.completeBody && alternatives.length < options.budget.maxAlternatives && selected.text.length > 1_024) {
    const edge = Math.min(512, Math.floor(selected.text.length / 2));
    const middleStart = selected.decodedUtf16.start + edge;
    const middleEnd = selected.decodedUtf16.end - edge;
    const markerOmissions: CapsuleOmission[] = middleEnd > middleStart ? [{
      kind: "exact-range",
      reason: "middle",
      source: base.source,
      decodedUtf16: { start: middleStart, end: middleEnd },
      omittedUnits: middleEnd - middleStart,
      description: "Marker representation omits the exact middle interval; source remains recoverable.",
    }] : [];
    alternatives.push({
      ...alternatives[0]!,
      alternative: alternatives.length,
      text: `${selected.text.slice(0, edge)}\n…[exact middle omitted]…\n${selected.text.slice(-edge)}${cueText}`,
      omissions: [...selected.omissions, ...markerOmissions],
    });
  }
  const envelope: ReducerEnvelope = {
    v: 1,
    capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION,
    identity: base.identity,
    source: base.source,
    provenance: base.provenance,
    family: options.family,
    familyVersion: options.familyVersion,
    reducerSetVersion: options.reducerSetVersion,
    configHash: options.configHash,
    budget: options.budget,
    inputHash: canonicalInputHash(base, options),
    ...(options.pair === undefined ? {} : { pair: options.pair }),
    alternatives,
  };
  // Preserve as many representation choices as fit the frozen wire contract.
  // Source references, escaped text, facts, cues, and omissions all count.
  while (alternatives.length > 1 && !isReducerEnvelope(envelope)) alternatives.pop();
  if (!isReducerEnvelope(envelope)) throw new Error("capsule-reducer-invalid-envelope");
  return envelope;
}

export function reduceSourceBlock(input: SourceBlockReducerInput, options: CapsuleReducerOptions): ReducerEnvelope {
  if (!isSourceBlockReducerInput(input) || !input.window.completeBody) throw new Error("capsule-reducer-complete-input-required");
  const found = extractProtectedCues(input.window.text, input.window.decodedUtf16.start, input.source);
  const cues: ProtectedCue[] = [];
  let cueUnits = 0;
  for (const cue of found) {
    if (cues.length >= 16 || cueUnits + cue.exactText.length > 2 * 1024) continue;
    cues.push(cue);
    cueUnits += cue.exactText.length;
  }
  const overflow = found.length - cues.length;
  const omissions: CapsuleOmission[] = overflow === 0 ? [] : [{
    kind: "transformation-loss",
    reason: "budget",
    affectedSource: input.source,
    affectedDecodedUtf16: input.source.decodedUtf16,
    omittedUnits: "unknown",
    description: `${overflow} additional protected-cue match(es) exceeded the fixed cue budget.`,
  }];
  return buildReducerEnvelope(input, options, {
    text: input.window.text,
    decodedUtf16: input.window.decodedUtf16,
    protectedCues: cues,
    omissions,
    completeBody: true,
  });
}
