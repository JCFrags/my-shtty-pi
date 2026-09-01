import { createHash } from "node:crypto";
import type { HistoricalBlock, SourceRef } from "./types.js";
import {
  compactWhitespace,
  estimateTokensFromText,
  hasRestrictionLanguage,
} from "./utils.js";

export const HISTORY_VALUE_SCHEMA_VERSION = 2;

export type HistoryValueCategory =
  | "restriction"
  | "goal"
  | "decision"
  | "next-action"
  | "blocker"
  | "status"
  | "failure"
  | "resource-state"
  | "task-episode"
  | "activity"
  | "metric"
  | "evidence"
  | "archive-range";
export type HistorySourceAuthority = "user" | "assistant" | "tool" | "project" | "derived";
export type HistoryLifecycle =
  | "current"
  | "conflict"
  | "superseded"
  | "unresolved"
  | "resolved"
  | "open"
  | "closed"
  | "unknown";
export type HistoryPriority = "A" | "B" | "C" | "D" | "E";
export type HistoryEvidenceType = "exact-source" | "structured-source" | "deterministic-derived";
export type HistoryConfidence = "source-fact" | "deterministic-inference" | "heuristic-inference";
export type HistoryUniqueness = "unique" | "duplicate" | "unknown";
export type HistoryRelationKind =
  | "duplicate"
  | "correction"
  | "supersession"
  | "conflict"
  | "resolution"
  | "validation"
  | "task-continuation"
  | "resource-update"
  | "unrelated";

export interface HistoryRelation {
  readonly kind: HistoryRelationKind;
  readonly targetRecordId?: string;
  readonly basis: string;
}

export interface HistoryValueRecord {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly category: HistoryValueCategory;
  readonly sourceAuthority: HistorySourceAuthority;
  readonly lifecycle: HistoryLifecycle;
  readonly priority: HistoryPriority;
  readonly sourceRefs: readonly SourceRef[];
  readonly sourceRange: { readonly startEntryId: string; readonly endEntryId: string };
  readonly sourceOrder: { readonly start: number; readonly end: number };
  readonly sourceTokens: number;
  readonly renderedTokenEstimate: number;
  readonly evidenceType: HistoryEvidenceType;
  readonly uniqueness: HistoryUniqueness;
  readonly recoveryCost: number;
  readonly reproductionCost: number;
  readonly compressionRisk: number;
  readonly staticImportance: number;
  readonly staticSignals: readonly string[];
  readonly stateKey: string;
  readonly normalizedClaimHash: string;
  readonly subjectFingerprint?: string;
  readonly correctionIntent?: boolean;
  readonly successEvidence?: boolean;
  readonly failureIdentity?: string;
  readonly failureSignature?: string;
  readonly commandIdentity?: string;
  readonly resourceIdentity?: string;
  readonly resourceRole?: "read" | "write" | "validation" | "observed";
  readonly taskIdentity?: string;
  readonly duplicateGroupIdentity?: string;
  readonly relations: readonly HistoryRelation[];
  readonly conflictSources?: readonly SourceRef[];
  readonly confidence: HistoryConfidence;
  readonly cue?: string;
  readonly exactSourceRequired: boolean;
}

export interface HistoryDynamicContext {
  readonly retentionHints?: string;
  readonly recentTailTerms?: readonly string[];
  readonly currentResourceIdentities?: readonly string[];
  readonly openTaskIds?: readonly string[];
  readonly retrievalEntryIds?: readonly string[];
  readonly unresolvedFailureKeys?: readonly string[];
  readonly desiredCategories?: readonly HistoryValueCategory[];
}

export interface HistoryValueExtractionContext {
  readonly toolName?: string;
  readonly toolArguments?: Record<string, unknown>;
  readonly relation?: HistoryRelation;
}

export function fullHistoryHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalized(text: string): string {
  return compactWhitespace(text).replace(/\s+/g, " ").trim().toLowerCase();
}

function bounded(text: string, maximum = 240): string {
  const clean = compactWhitespace(text).replace(/\s+/g, " ").trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}

function terms(text: string): string[] {
  return normalized(text).match(/[a-z][a-z0-9_.:/-]{2,}/g)?.slice(0, 32) ?? [];
}

function authority(block: HistoricalBlock): HistorySourceAuthority {
  if (block.kind === "user") return "user";
  if (block.kind === "tool_call" || block.kind === "tool_result" || block.kind === "bash_execution") {
    return "tool";
  }
  if (block.kind === "custom_message") return "project";
  return "assistant";
}

function category(block: HistoricalBlock): HistoryValueCategory {
  const text = normalized(block.exactText);
  if (block.protectedExact && hasRestrictionLanguage(block.exactText)) return "restriction";
  if (
    block.isError ||
    block.unresolved ||
    (!/\b(no|zero)\s+(errors?|failures?)\b/.test(text) && /\b(failed|failure|error)\b/.test(text))
  ) return "failure";
  if (/\b(blocked|blocker|cannot continue|waiting for)\b/.test(text)) return "blocker";
  if (/\b(next|todo|must|should)\b/.test(text) && /\b(action|step|implement|run|fix|continue)\b/.test(text)) {
    return "next-action";
  }
  if (/\b(goal|objective|purpose)\b/.test(text)) return "goal";
  if (/\b(decided|decision|choose|selected)\b/.test(text)) return "decision";
  if (/\b(task|implementation|work item|milestone)\b/.test(text)) return "task-episode";
  if (block.toolName || block.attributes.resourceKey) return "resource-state";
  if (/\b(test|metric|tokens|bytes|milliseconds| ms\b|rss)\b/.test(text)) return "metric";
  return block.kind === "assistant_text" ? "status" : "evidence";
}

function resourceIdentity(block: HistoricalBlock, context: HistoryValueExtractionContext): string | undefined {
  const key = block.attributes.resourceKey;
  if (typeof key === "string") return normalized(key);
  const args = context.toolArguments ?? block.toolArguments;
  for (const name of ["path", "file", "url", "resource"]) {
    if (typeof args?.[name] === "string") return normalized(args[name] as string);
  }
  return undefined;
}

function resourceRole(block: HistoricalBlock): HistoryValueRecord["resourceRole"] {
  const tool = normalized(block.toolName ?? "");
  if (/write|edit|patch/.test(tool)) return "write";
  if (/test|validat|check/.test(tool)) return "validation";
  if (/read|grep|find|search/.test(tool)) return "read";
  return "observed";
}

function commandIdentity(block: HistoricalBlock, context: HistoryValueExtractionContext): string | undefined {
  const tool = context.toolName ?? block.toolName;
  const command = typeof (context.toolArguments ?? block.toolArguments)?.command === "string"
    ? String((context.toolArguments ?? block.toolArguments)?.command)
    : "";
  if (!tool || !command.trim()) return undefined;
  return fullHistoryHash(`${normalized(tool)}:${normalized(command)}`);
}

function stableTaskIdentity(block: HistoricalBlock): string | undefined {
  const text = normalized(block.exactText);
  const explicit = text.match(/(?:task|goal|objective|milestone)\s*[:#-]?\s*([a-z0-9_.:/-]{2,120})/i)?.[1];
  if (!explicit) return undefined;
  return fullHistoryHash(normalized(explicit));
}

function identity(
  valueCategory: HistoryValueCategory,
  block: HistoricalBlock,
  context: HistoryValueExtractionContext,
): {
  stateKey: string;
  resource?: string;
  command?: string;
  task?: string;
  failure?: string;
  failureSignature?: string;
  subject?: string;
} {
  const resource = resourceIdentity(block, context);
  const command = commandIdentity(block, context);
  const task = stableTaskIdentity(block);
  const failureTerms = terms(block.exactText)
    .filter(term => !/^(?:failed?|failure|errors?|fixed|resolved|passed|success|successful|corrected|unresolved|remains?)$/.test(term));
  const signature = fullHistoryHash(failureTerms.slice(0, 12).join(" "));
  if (valueCategory === "failure") {
    const failure = fullHistoryHash(`${signature}:${resource ?? ""}:${command ?? ""}:${task ?? ""}`);
    return { stateKey: `failure:${failure}`, resource, command, task, failure, failureSignature: signature };
  }
  if (valueCategory === "restriction") {
    const subject = fullHistoryHash(terms(block.exactText)
      .filter(term => !/(?:must|never|always|should|correction|corrected|replace|replacement|instead|allow|deny|not|you|please)/.test(term))
      .slice(0, 3).join(" "));
    return { stateKey: `restriction:${subject}`, subject };
  }
  if (valueCategory === "resource-state") {
    const successful = /\b(pass(?:ed)?|fixed|resolved|corrected|success(?:ful)?)\b/i.test(block.exactText);
    const failure = successful ? fullHistoryHash(`${signature}:${resource ?? ""}:${command ?? ""}:${task ?? ""}`) : undefined;
    return {
      stateKey: `resource:${resource ?? command ?? signature}:${resourceRole(block)}`,
      resource,
      command,
      task,
      failure,
      ...(successful ? { failureSignature: signature } : {}),
    };
  }
  if (valueCategory === "task-episode" || valueCategory === "goal" || valueCategory === "next-action") {
    const taskIdentity = task ?? fullHistoryHash(terms(block.exactText).slice(0, 12).join(" "));
    return { stateKey: `task:${taskIdentity}`, task: taskIdentity };
  }
  return { stateKey: `${valueCategory}:${resource ?? signature}`, resource, command, task };
}

function lifecycle(valueCategory: HistoryValueCategory, block: HistoricalBlock): HistoryLifecycle {
  if (valueCategory === "failure") return "unresolved";
  if (valueCategory === "task-episode") {
    const validation = resourceRole(block) === "validation" && /\b(pass(?:ed)?|success(?:ful)?|validated)\b/i.test(block.exactText);
    return validation ? "closed" : "open";
  }
  if (["restriction", "blocker", "next-action", "resource-state"].includes(valueCategory)) return "current";
  return "unknown";
}

export function createHistoryValueRecord(
  block: HistoricalBlock,
  index = 0,
  context: HistoryValueExtractionContext = {},
): HistoryValueRecord {
  const valueCategory = category(block);
  const sourceAuthority = authority(block);
  const relationIdentity = identity(valueCategory, block, context);
  const restriction = valueCategory === "restriction";
  const failure = valueCategory === "failure";
  const blocker = valueCategory === "blocker";
  const priority: HistoryPriority = restriction
    ? "A"
    : failure || blocker
      ? "B"
      : ["resource-state", "goal", "decision", "next-action"].includes(valueCategory)
        ? "B"
        : ["metric", "evidence"].includes(valueCategory)
          ? "C"
          : "D";
  const cue = restriction && block.protectedExact
    ? "Protected current restriction; load exact source before use."
    : block.kind === "tool_call"
      ? `Tool ${context.toolName ?? block.toolName ?? "unknown"} call observed; complete arguments omitted.`
      : block.kind === "tool_result" && !failure
        ? `Tool ${context.toolName ?? block.toolName ?? "unknown"} result observed; complete output omitted.`
        : bounded(block.exactText);
  const exactRefs = block.sourceRefs.filter(ref => ref.entryId === block.entryId);
  const normalizedClaimHash = fullHistoryHash(normalized(block.exactText));
  return {
    schemaVersion: 2,
    id: fullHistoryHash(`history-value-v2:${block.id}:${index}:${valueCategory}`),
    category: valueCategory,
    sourceAuthority,
    lifecycle: lifecycle(valueCategory, block),
    priority,
    sourceRefs: exactRefs.length ? exactRefs : [{ entryId: block.entryId }],
    sourceRange: { startEntryId: block.entryId, endEntryId: block.entryId },
    sourceOrder: { start: block.entryIndex, end: block.entryIndex },
    sourceTokens: block.rawTokens,
    renderedTokenEstimate: estimateTokensFromText(cue),
    evidenceType: block.protectedExact
      ? "exact-source"
      : sourceAuthority === "tool"
        ? "structured-source"
        : "deterministic-derived",
    uniqueness: "unknown",
    recoveryCost: block.reproducible ? 20 : 80,
    reproductionCost: block.reproducible ? 20 : 80,
    compressionRisk: restriction ? 100 : failure ? 85 : 40,
    staticImportance: Math.min(100, priority === "A" ? 95 : priority === "B" ? 75 : priority === "C" ? 50 : 25),
    staticSignals: [sourceAuthority, valueCategory, ...(block.protectedExact ? ["protected"] : [])],
    stateKey: relationIdentity.stateKey,
    normalizedClaimHash,
    ...(relationIdentity.subject ? {
      subjectFingerprint: relationIdentity.subject,
      correctionIntent: /\b(correct(?:ion|ed)?|replac(?:e|ed|ement)|supersed(?:e|ed|es|ing)|instead)\b/i.test(block.exactText),
    } : {}),
    ...(relationIdentity.failure ? { failureIdentity: relationIdentity.failure } : {}),
    ...(relationIdentity.failureSignature ? { failureSignature: relationIdentity.failureSignature } : {}),
    ...(relationIdentity.command ? { commandIdentity: relationIdentity.command } : {}),
    ...(relationIdentity.resource ? { resourceIdentity: relationIdentity.resource } : {}),
    ...(block.toolName ? { resourceRole: resourceRole(block) } : {}),
    ...(relationIdentity.task ? { taskIdentity: relationIdentity.task } : {}),
    relations: context.relation ? [context.relation] : [],
    successEvidence: /\b(pass(?:ed)?|fixed|resolved|corrected|success(?:ful)?|validated|accepted)\b/i.test(block.exactText),
    confidence: sourceAuthority === "user" || sourceAuthority === "tool" ? "source-fact" : "heuristic-inference",
    cue,
    exactSourceRequired: restriction,
  };
}

export function historyStaticValue(record: HistoryValueRecord): number {
  return record.staticImportance + record.compressionRisk * 0.15 + record.recoveryCost * 0.1 +
    (record.lifecycle === "unresolved" ? 20 : 0) +
    (record.uniqueness === "unique" ? 10 : record.uniqueness === "duplicate" ? -10 : 0);
}

export function historyDynamicValue(record: HistoryValueRecord, context: HistoryDynamicContext = {}): number {
  let value = historyStaticValue(record);
  const hintTerms = terms(`${context.retentionHints ?? ""} ${(context.recentTailTerms ?? []).join(" ")}`);
  const cue = normalized(record.cue ?? "");
  if (hintTerms.some(term => cue.includes(term))) value += 25;
  if (record.resourceIdentity && context.currentResourceIdentities?.includes(record.resourceIdentity)) value += 30;
  if (record.taskIdentity && context.openTaskIds?.includes(record.taskIdentity)) value += 30;
  if (context.retrievalEntryIds?.some(id => record.sourceRefs.some(ref => ref.entryId === id))) value += 20;
  if (context.unresolvedFailureKeys?.includes(record.failureIdentity ?? record.stateKey)) value += 30;
  if (context.desiredCategories?.includes(record.category)) value += 15;
  return value;
}

export function orderHistoryValues(
  records: readonly HistoryValueRecord[],
  context: HistoryDynamicContext = {},
): HistoryValueRecord[] {
  return [...records].sort((a, b) =>
    historyDynamicValue(b, context) - historyDynamicValue(a, context) ||
    a.sourceOrder.start - b.sourceOrder.start ||
    a.id.localeCompare(b.id));
}

export function extractHistoryValues(
  blocks: readonly HistoricalBlock[],
  contexts: ReadonlyMap<string, HistoryValueExtractionContext> = new Map(),
): HistoryValueRecord[] {
  const seen = new Map<string, string>();
  return blocks.map((block, index) => {
    let value = createHistoryValueRecord(block, index, contexts.get(block.id));
    const signature = `${value.category}:${value.normalizedClaimHash}`;
    const prior = seen.get(signature);
    if (prior) {
      value = {
        ...value,
        uniqueness: "duplicate",
        duplicateGroupIdentity: fullHistoryHash(signature),
        relations: [...value.relations, { kind: "duplicate", targetRecordId: prior, basis: "exact-normalized-claim" }],
      };
    } else {
      seen.set(signature, value.id);
      value = { ...value, uniqueness: "unique" };
    }
    return value;
  });
}
