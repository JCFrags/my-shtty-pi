import { createHash } from "node:crypto";
import { isScopedRawSourceRef, type ReducerEnvelope, type ScopedBodySourceRef, type ScopedRawSourceRef } from "./capsule-contract.js";
import {
  EPISODE_STATE_LIMITS,
  EPISODE_STATE_RULESET_VERSION,
  type EpisodeStateAuthority,
  type EpisodeStateBatchCursor,
  type EpisodeStateConfidence,
  type EpisodeStateKind,
} from "./episode-state-contract.js";

export interface ExactStateEvidence {
  readonly source: ScopedBodySourceRef;
  readonly decodedUtf16: { readonly start: number; readonly end: number };
  readonly structuralSource?: ScopedRawSourceRef;
  readonly exactText: string;
  readonly omissions: readonly { readonly beforeUtf16: number; readonly afterUtf16: number }[];
}
export interface ReducedStateItem {
  readonly stableKey: string;
  /** Exact normalized proposition identity; paths alone never identify an obligation. */
  readonly propositionKey: string;
  /** Exact source-span identity prevents two claims at one path from collapsing. */
  readonly spanKey: string;
  readonly subject: string;
  readonly revision: string;
  readonly kind: EpisodeStateKind;
  readonly authority: EpisodeStateAuthority;
  readonly confidence: EpisodeStateConfidence;
  readonly status: "current" | "unresolved";
  readonly evidence: ExactStateEvidence;
  readonly transition?: { readonly action: "revoke" | "replace"; readonly targetPropositionKey: string };
}
export interface ReducedResourceObservation {
  readonly stableKey: string;
  readonly resourceKind: "file" | "url" | "command" | "test" | "service" | "package" | "unknown";
  readonly resourceKey: string;
  readonly relation: "read" | "write" | "edit" | "run" | "observe";
  readonly revision: string | null;
  readonly revisionBasis: "declared" | "full-content-hash" | "unknown";
  readonly currentRevision: "known" | "unknown";
  readonly knownThrough: number;
  readonly failed: boolean | null;
  readonly executionOutcome: "failed" | "cancelled" | "completed-without-reported-error" | "unknown";
  readonly evidence: ExactStateEvidence;
}
export interface VerifiedEventStructuralFacts {
  /** Exact top-level record type. This never supplies a message role or instruction authority. */
  readonly recordType?: { readonly value: "custom_message"; readonly source: ScopedRawSourceRef };
  /** Catalog metadata is structurally verified but does not invent a raw coordinate. */
  readonly role?: { readonly value: string; readonly source?: ScopedRawSourceRef };
  readonly toolName?: { readonly value: string; readonly source?: ScopedRawSourceRef };
  readonly exitCode?: { readonly value: number; readonly source?: ScopedRawSourceRef };
  readonly isError?: { readonly value: boolean; readonly source?: ScopedRawSourceRef };
  readonly cancelled?: { readonly value: boolean; readonly source?: ScopedRawSourceRef };
}
export interface ReducedEpisodeEvent {
  readonly source: ScopedBodySourceRef;
  readonly role: string | null;
  readonly original: boolean;
  readonly startsEpisode: boolean;
  readonly boundaryKind: "user-request" | "compaction-continuation" | "none";
  readonly objective?: ExactStateEvidence;
  readonly states: readonly ReducedStateItem[];
  /** Drain this exact window before advancing decoded or completed-body progress. */
  readonly nextBatch?: EpisodeStateBatchCursor;
  /** Existing bounded capsule action/outcome text, retained in chronology for episode recall. */
  readonly capsuleCue: string;
  readonly resources: readonly ReducedResourceObservation[];
  readonly partial: boolean;
  readonly coverage: { readonly restrictionGap: boolean; readonly openWorkGap: boolean };
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const normalized = (text: string): string => text.trim().replace(/\s+/g, " ");
function structural(envelope: ReducerEnvelope, name: string, verified?: VerifiedEventStructuralFacts): { value: unknown; source?: ScopedRawSourceRef } | undefined {
  const exact = verified?.[name as keyof VerifiedEventStructuralFacts];
  if (exact) return exact;
  for (const alternative of envelope.alternatives) {
    const fact = alternative.facts.find(item => item.kind === "structural" && item.name === name && item.source.coordinateKind === "raw-json");
    if (fact) return { value: fact.value, source: fact.source as ScopedRawSourceRef };
  }
  return undefined;
}
function neighborhoods(text: string): { text: string; start: number; end: number }[] {
  const output: { text: string; start: number; end: number }[] = [];
  const pattern = /[^\n]+/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]!, leading = raw.length - raw.trimStart().length, value = raw.trim();
    if (value.length < 4) continue;
    const start = match.index + leading;
    for (let at = 0; at < value.length; at += EPISODE_STATE_LIMITS.clauseUtf16Units) {
      const part = value.slice(at, at + EPISODE_STATE_LIMITS.clauseUtf16Units);
      output.push({ text: part, start: start + at, end: start + at + part.length });
      // Input remains bounded by wholeBodyUtf16Units; scan beyond the first 32 lines.
    }
  }
  return output;
}
function evidence(source: ScopedBodySourceRef, structuralSource: ScopedRawSourceRef | undefined, text: string,
  clause: { text: string; start: number; end: number }, decodedStart = source.decodedUtf16.start): ExactStateEvidence {
  const start = decodedStart + clause.start, end = decodedStart + clause.end;
  return { source, decodedUtf16: { start, end }, ...(structuralSource ? { structuralSource } : {}), exactText: clause.text,
    omissions: [{ beforeUtf16: start - source.decodedUtf16.start, afterUtf16: Math.max(0, source.decodedUtf16.end - end) }] };
}
function subjectOf(text: string, context = text): string {
  const pattern = /(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|\/)[\w@.+\-~]+(?:[\\/][\w@.+\-~]+)+/gu;
  const path = text.match(pattern)?.[0]?.replaceAll("\\", "/");
  if (path) return `path:${path}`;
  const contextualPaths = [...new Set((context.match(pattern) ?? []).map(value => value.replaceAll("\\", "/")))];
  if (contextualPaths.length === 1) return `path:${contextualPaths[0]}`;
  const quoted = text.match(/[`“"]([^`”"]{3,160})[`”"]/u)?.[1];
  const words = normalized(quoted ?? text).toLowerCase().match(/[\p{L}\p{N}_+.-]{3,}/gu)?.filter(word =>
    !["the", "and", "that", "this", "with", "must", "should", "please", "only", "not", "from", "into"].includes(word)).slice(0, 8) ?? [];
  return `topic:${words.join(":") || sha(text).slice(0, 16)}`;
}
function propositionOf(kind: EpisodeStateKind, text: string): string {
  const normalizedText = normalized(text).replace(/^./u, character => character.toLowerCase())
    .replace(/^(?:explicitly\s+)?(?:revoke|revoked|remove|removed|replace|replaced|supersede|superseded)\s+(?:the\s+)?(?:restriction|requirement|obligation)?\s*(?:that|to|:)?\s*/u, "")
    .replace(/\s*[.;]+$/u, "");
  return sha(`${kind}\n${normalizedText}`);
}
function transitionOf(kind: EpisodeStateKind, text: string): ReducedStateItem["transition"] {
  if (kind !== "restriction" || /(?:^|\s)[>"'`]\s*(?:never|must not|do not)/iu.test(text)) return undefined;
  const match = text.match(/^\s*(?:explicitly\s+)?(revoke|revoked|remove|removed|replace|replaced|supersede|superseded)\s+(?:the\s+)?(?:restriction|requirement|obligation)?\s*(?:that|to|:)?\s*(.+?)\s*$/iu);
  if (!match || /\b(?:if|when|unless|would|may|might|quoted|says?)\b/iu.test(text)) return undefined;
  const action = /replace|supersed/iu.test(match[1]!) ? "replace" : "revoke";
  return { action, targetPropositionKey: propositionOf("restriction", match[2]!) };
}
function revisionOf(text: string): string {
  const explicit = text.match(/\b(?:revision|rev|commit|version|sha(?:256)?)\s*[:=#]?\s*([A-Za-z0-9_.+-]{3,128})\b/iu)?.[1]
    ?? text.match(/\b[a-f0-9]{40,64}\b/iu)?.[0];
  return explicit?.toLowerCase() ?? "unspecified";
}
function classifyUser(text: string): EpisodeStateKind | undefined {
  if (/\b(?:do not|don't|must|never|only|constraint|restriction|except|unless|required|preserve|keep)\b/iu.test(text)) return "restriction";
  if (/\b(?:not|never|without|pending|request(?:ing|ed)?|need)\s+(?:\w+\s+){0,2}(?:approve|approved|authorization|permission)\b/iu.test(text)) return "openwork";
  if (!/\b(?:if|when|once|pending|would|may|request|quoted|says)\b/iu.test(text) && /^(?:I approve|I authorize|approved\b|authorized\b|permission (?:is )?granted)/iu.test(text.trim())) return "approval";
  if (/\b(?:decide|decided|decision|choose|selected|instead)\b/iu.test(text)) return "decision";
  if (/\b(?:blocked|blocker|cannot continue|can't continue|waiting for)\b/iu.test(text)) return "blocker";
  if (/\b(?:was|is|has been|successfully)\s+(?:deployed|released|published)\b/iu.test(text)) return "deployment";
  if (/\b(?:goal|objective|need|want|implement|fix|add|remove|create|update|investigate|verify|test|deploy|release|publish)\b/iu.test(text)) return "goal";
  return undefined;
}
function classifyAssistant(text: string): EpisodeStateKind | undefined {
  if (/\b(?:implemented|changed|created|updated|fixed|removed|deployed|published)\b/iu.test(text))
    return /\b(?:deployed|published|production)\b/iu.test(text) ? "deployment" : "reportedimplementation";
  if (/\b(?:remaining|next action|still need|todo|unresolved)\b/iu.test(text)) return "openwork";
  return undefined;
}
function toolOutcome(envelope: ReducerEnvelope, verified?: VerifiedEventStructuralFacts): ReducedResourceObservation["executionOutcome"] {
  const exit = structural(envelope, "exitCode", verified)?.value;
  if (typeof exit === "number" && exit !== 0) return "failed";
  const cancelled = structural(envelope, "cancelled", verified)?.value;
  if (cancelled === true) return "cancelled";
  for (const alternative of envelope.alternatives) {
    if (alternative.outcome.status !== "supported") continue;
    if (alternative.outcome.value === "failure") return "failed";
    if (alternative.outcome.value === "cancelled") return "cancelled";
  }
  const isError = structural(envelope, "isError", verified)?.value;
  if (isError === true) return "failed";
  if ((typeof exit === "number" && exit === 0) || isError === false) return "completed-without-reported-error";
  return "unknown";
}
function toolFailure(envelope: ReducerEnvelope, verified?: VerifiedEventStructuralFacts): boolean | null {
  const outcome = toolOutcome(envelope, verified);
  return outcome === "failed" || outcome === "cancelled" ? true : outcome === "completed-without-reported-error" ? false : null;
}
function resource(text: string, envelope: ReducerEnvelope, ev: ExactStateEvidence, verified?: VerifiedEventStructuralFacts): ReducedResourceObservation | undefined {
  const toolName = String(structural(envelope, "toolName", verified)?.value ?? "");
  const path = text.match(/(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|\/)[\w@.+\-~]+(?:[\\/][\w@.+\-~]+)+/u)?.[0]?.replaceAll("\\", "/");
  const url = text.match(/https?:\/\/[^\s<>'"]{3,512}/u)?.[0];
  const relation = /edit|patch|replace/iu.test(toolName) ? "edit" : /write|create|save/iu.test(toolName) ? "write"
    : /read|open|view|cat/iu.test(toolName) ? "read" : /bash|exec|run|test/iu.test(toolName) ? "run" : "observe";
  const resourceKind = path ? "file" : url ? "url" : /test/iu.test(toolName) ? "test" : /bash|exec|run/iu.test(toolName) ? "command" : "unknown";
  if (!path && !url && resourceKind === "unknown") return undefined;
  const key = path ? `file:${path}` : url ? `url:${url}` : `${resourceKind}:tool:${toolName.toLowerCase()}`;
  const declared = revisionOf(text);
  // A complete tool-result body is still only an observation, never the full resource bytes.
  const revision = declared !== "unspecified" ? declared : null;
  const basis = declared !== "unspecified" ? "declared" : "unknown";
  return { stableKey: sha(`${key}\n${envelope.source.eventSeq}\n${envelope.source.descriptor}`).slice(0, 32), resourceKind, resourceKey: key,
    relation, revision, revisionBasis: basis, currentRevision: "unknown", knownThrough: envelope.source.eventSeq,
    failed: toolFailure(envelope, verified), executionOutcome: toolOutcome(envelope, verified), evidence: ev };
}

/** A source-verified extension record is not a message with an unknown role. */
export function isVerifiedCustomMessage(envelope: ReducerEnvelope, verified?: VerifiedEventStructuralFacts): boolean {
  const fact = verified?.recordType;
  return envelope.provenance === "original" && fact?.value === "custom_message" && isScopedRawSourceRef(fact.source)
    && fact.source.field === "type"
    && (["catalogStoreKey", "sessionKey", "catalogGeneration", "shardKey", "segment", "eventSeq", "ordinal", "descriptor"] as const)
      .every(key => fact.source[key] === envelope.source[key]);
}

/** Extract only source-local, bounded claims. Lifecycle transitions are store-owned. */
export function reduceEpisodeStateEnvelope(envelope: ReducerEnvelope, body?: string, verified?: VerifiedEventStructuralFacts,
  window?: { readonly decodedStart: number; readonly final: boolean; readonly after?: EpisodeStateBatchCursor }): ReducedEpisodeEvent {
  const customMessage = isVerifiedCustomMessage(envelope, verified);
  const roleFact = customMessage ? undefined : structural(envelope, "role", verified), role = typeof roleFact?.value === "string" ? roleFact.value.toLowerCase() : null;
  const original = envelope.provenance === "original";
  const decodedStart = window?.decodedStart ?? envelope.source.decodedUtf16.start;
  const analyzable = body !== undefined && body.length <= EPISODE_STATE_LIMITS.wholeBodyUtf16Units;
  const sourceComplete = analyzable && decodedStart === envelope.source.decodedUtf16.start
    && decodedStart + body!.length === envelope.source.decodedUtf16.end;
  const text = analyzable ? body! : "";
  const clauses = analyzable && !customMessage ? neighborhoods(text) : [];
  const startsEpisode = original && role === "user" && decodedStart === envelope.source.decodedUtf16.start
    && (envelope.source.blockIndex === undefined || envelope.source.blockIndex === 0);
  const compaction = role === "assistant" && /compaction|branch-summary/iu.test(envelope.family);
  const states: ReducedStateItem[] = [];
  for (const clause of clauses) {
    let kind: EpisodeStateKind | undefined;
    let authority: EpisodeStateAuthority = "assistant-report", confidence: EpisodeStateConfidence = "qualified";
    if (original && role === "user") { kind = classifyUser(clause.text); authority = "user"; confidence = "verified"; }
    else if (role === "custom" && original) { kind = classifyUser(clause.text) ?? classifyAssistant(clause.text); authority = "ordinary-memory"; confidence = "advisory"; }
    else if (role === "assistant" && original) { kind = classifyAssistant(clause.text); }
    else if ((role === "toolresult" || role === "tool" || structural(envelope, "toolName", verified)) && original) {
      // Tool execution success is not task or resource verification. Only explicit failure/cancellation creates state.
      const outcome = toolOutcome(envelope, verified);
      if (outcome === "failed" || outcome === "cancelled") { kind = "blocker"; authority = "verified-tool"; confidence = "verified"; }
    }
    if (!kind) continue;
    // Quoted/mixed/generated text never grants approval. Original provenance alone is not user authority.
    if (kind === "approval" && (!startsEpisode || /^\s*(?:>|["'`])/u.test(clause.text))) continue;
    const subject = subjectOf(clause.text, text), clauseRevision = revisionOf(clause.text), contextualRevision = revisionOf(text);
    const revision = clauseRevision !== "unspecified" ? clauseRevision : contextualRevision;
    const propositionKey = propositionOf(kind, clause.text);
    const sourceOffset = decodedStart - envelope.source.decodedUtf16.start;
    const spanKey = sha(`${JSON.stringify(envelope.source)}\n${sourceOffset + clause.start}\n${sourceOffset + clause.end}`);
    const transition = transitionOf(kind, clause.text), effectiveKind: EpisodeStateKind = transition ? "decision" : kind;
    states.push({ stableKey: sha(`${propositionKey}\n${spanKey}`).slice(0, 32), propositionKey, spanKey,
      subject, revision, kind: effectiveKind, authority, confidence, status: effectiveKind === "blocker" || effectiveKind === "openwork" ? "unresolved" : "current",
      evidence: evidence(envelope.source, roleFact?.source, text, clause, decodedStart), ...(transition ? { transition } : {}) });
  }
  // Source order is stable across batches. No category can permanently displace another.
  const prefixHash = (end: number): string => sha(JSON.stringify(states.slice(0, end).map(item => item.stableKey)));
  const after = window?.after, offset = after?.afterState ?? 0;
  if (after && (!Number.isSafeInteger(offset) || offset < 1 || offset >= states.length
    || offset % EPISODE_STATE_LIMITS.stateItemsPerBatch !== 0 || prefixHash(offset) !== after.prefixHash))
    throw Object.assign(new Error("search-v3-state-checkpoint-corrupt"), { code: "search-v3-state-checkpoint-corrupt" });
  const end = Math.min(states.length, offset + EPISODE_STATE_LIMITS.stateItemsPerBatch);
  const selectedStates = states.slice(offset, end), pending = states.slice(end);
  const nextBatch = pending.length ? { afterState: end, prefixHash: prefixHash(end) } : undefined;
  const unknownOriginal = original && !role && !customMessage;
  const coverage = {
    restrictionGap: unknownOriginal || original && role === "user" && !analyzable || pending.some(item => item.kind === "restriction"),
    openWorkGap: unknownOriginal || original && ["user", "assistant", "tool", "toolresult"].includes(role ?? "") && !analyzable
      || pending.some(item => ["goal", "openwork", "blocker"].includes(item.kind)),
  };
  selectedStates.sort((a, b) => a.evidence.decodedUtf16.start - b.evidence.decodedUtf16.start);
  const wholeEvidence = sourceComplete ? evidence(envelope.source, roleFact?.source, text, { text, start: 0, end: text.length }, decodedStart) : undefined;
  const objectiveClause = startsEpisode ? neighborhoods(text)[0] : undefined;
  const objective = objectiveClause ? evidence(envelope.source, roleFact?.source, text, objectiveClause, decodedStart) : undefined;
  const resourceClause = clauses.find(clause => /(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|\/|https?:\/\/|\brevision\b)/u.test(clause.text)) ?? clauses[0];
  const resourceEvidence = resourceClause ? evidence(envelope.source, roleFact?.source, text, resourceClause, decodedStart) : wholeEvidence;
  const observed = resourceEvidence && !customMessage ? resource(text, envelope, resourceEvidence, verified) : undefined;
  const capsuleCue = envelope.alternatives.map(alternative => alternative.text).filter(Boolean).join("\n").slice(0, 2048);
  return { source: envelope.source, role, original, startsEpisode, boundaryKind: startsEpisode ? "user-request" : compaction ? "compaction-continuation" : "none",
    ...(objective ? { objective } : {}), states: selectedStates, ...(nextBatch ? { nextBatch } : {}), capsuleCue,
    resources: observed ? [observed] : [], coverage, partial: !analyzable || !role && !customMessage || pending.length > 0 };
}

export function episodeStateRulesetIdentity(): string { return EPISODE_STATE_RULESET_VERSION; }
