import { parseHistoricalBlocks } from "./blocks.js";
import { readSourceLedgerEntries } from "./ledger-branch.js";
import type { HistoryValueRecord } from "./history-value.js";
import type { HistoryRollupRuntime } from "./history-rollup-store.js";
import type { SourceLedger } from "./source-ledger.js";
import { directInstructionText, estimateTokensFromText } from "./utils.js";

export type HistoryRollupValidationIssueCode =
  | "invalid-source-reference"
  | "invalid-source-range"
  | "source-order"
  | "cut-line"
  | "loss-without-recovery"
  | "unsupported-identifier"
  | "unsupported-quotation"
  | "unsupported-number"
  | "unresolved-became-complete"
  | "failure-became-success"
  | "unlabeled-derived-state"
  | "hard-token-limit"
  | "duplicate-rendered-record"
  | "missing-current-restriction-route"
  | "exact-source-mismatch";

export interface HistoryRenderPlanLine {
  readonly id: string;
  readonly section: "current" | "recent" | "older" | "archive";
  readonly record?: HistoryValueRecord;
  readonly archiveIdentity?: string;
  readonly sourceRange: { readonly startEntryId: string; readonly endEntryId: string };
  readonly sourceOrder: { readonly start: number; readonly end: number };
  readonly lineType: "exact" | "structured" | "derived" | "heading" | "omission";
  readonly lossy: boolean;
  readonly recoveryRoute?: string;
  readonly text: string;
  readonly tokenEstimate: number;
  readonly priority: string;
  readonly included: boolean;
}

export interface HistoryRollupValidationResult {
  readonly ok: boolean;
  readonly issues: readonly HistoryRollupValidationIssueCode[];
  readonly exactSourceBytesRead: number;
}

function identifiers(text: string): Set<string> {
  return new Set(text.match(/(?:\/[A-Za-z0-9_.-]+)+|\b[A-Z][A-Z0-9_-]{2,}\b|\b[a-f0-9]{12,}\b/g) ?? []);
}

function quotations(text: string): Set<string> {
  return new Set([...text.matchAll(/["'`](.{2,120}?)["'`]/g)].map(match => match[1]!));
}

function numbers(text: string): Set<string> {
  return new Set(text.match(/\b\d+(?:\.\d+)?(?:ms|s|KiB|MiB|tokens?|bytes?)?\b/g) ?? []);
}

function unsupportedValues(line: string, source: string): HistoryRollupValidationIssueCode[] {
  const issues: HistoryRollupValidationIssueCode[] = [];
  if ([...identifiers(line)].some(value => !source.includes(value))) issues.push("unsupported-identifier");
  if ([...quotations(line)].some(value => !source.includes(value))) issues.push("unsupported-quotation");
  if ([...numbers(line)].some(value => !source.includes(value))) issues.push("unsupported-number");
  return issues;
}

export async function validateHistoryRollupPlan(
  runtime: HistoryRollupRuntime,
  ledger: SourceLedger,
  plan: readonly HistoryRenderPlanLine[],
  hardTokens = 25000,
): Promise<HistoryRollupValidationResult> {
  const included = plan.filter(line => line.included && line.lineType !== "heading");
  const issues: HistoryRollupValidationIssueCode[] = [];
  const order = new Map(ledger.sourceOrder.map((entry, index) => [entry.entryId, index]));
  const seen = new Set<string>();
  let exactSourceBytesRead = 0;
  if (included.reduce((sum, line) => sum + line.tokenEstimate, 0) > hardTokens) issues.push("hard-token-limit");
  for (const line of included) {
    if (seen.has(line.id)) issues.push("duplicate-rendered-record");
    seen.add(line.id);
    const start = order.get(line.sourceRange.startEntryId);
    const end = order.get(line.sourceRange.endEntryId);
    if (start === undefined || end === undefined) issues.push("invalid-source-reference");
    else if (start > end) issues.push("invalid-source-range");
    if (line.sourceOrder.start > line.sourceOrder.end) issues.push("source-order");
    if (line.text.endsWith("…") || line.text.includes("\n")) issues.push("cut-line");
    if (line.lossy && !line.recoveryRoute) issues.push("loss-without-recovery");
    if (line.record?.category === "restriction" && !line.recoveryRoute && line.lineType !== "exact") {
      issues.push("missing-current-restriction-route");
    }
    if (line.record?.lifecycle === "unresolved" && /\b(completed|resolved|passed|success)\b/i.test(line.text)) {
      issues.push("unresolved-became-complete");
    }
    if (line.record?.category === "failure" && /\bpassed|success\b/i.test(line.text)) issues.push("failure-became-success");
    if (line.lineType === "derived" && !/\b(derived|heuristic|reduced|omission|archive)\b/i.test(line.text)) {
      issues.push("unlabeled-derived-state");
    }
    if (!line.record) continue;
    if (line.lineType === "exact") {
      const ref = line.record.sourceRefs[0];
      const indexed = ref ? ledger.entryById.get(ref.entryId) : undefined;
      if (!ref || !indexed) {
        issues.push("invalid-source-reference");
        continue;
      }
      const loaded = await readSourceLedgerEntries(runtime.sessionPath, ledger, [indexed], { maximumGapBytes: 0 });
      exactSourceBytesRead += loaded.metrics.totalSourceBytesRead;
      const blocks = parseHistoricalBlocks(loaded.entries, { includeHistoricalCompactions: false, includeMetadata: false });
      const block = ref.blockIndex === undefined
        ? blocks.find(candidate => candidate.entryId === ref.entryId)
        : blocks.find(candidate => candidate.entryId === ref.entryId && candidate.blockIndex === ref.blockIndex);
      const exact = block ? directInstructionText(block.exactText) : undefined;
      if (!exact || !line.text.includes(JSON.stringify(exact))) issues.push("exact-source-mismatch");
    } else {
      const allowed = `${line.record.cue ?? ""} ${line.record.category} ${line.record.lifecycle} ${line.recoveryRoute ?? ""}`;
      issues.push(...unsupportedValues(line.text.replace(line.recoveryRoute ?? "", ""), allowed));
    }
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)], exactSourceBytesRead };
}

export function validateHistoryRollupPrototype(
  text: string,
  ledger: SourceLedger,
  records: readonly HistoryValueRecord[],
  hardTokens = 25000,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (estimateTokensFromText(text) > hardTokens) issues.push("hard-token-limit");
  const order = new Map(ledger.sourceOrder.map((entry, index) => [entry.entryId, index]));
  for (const record of records) {
    const start = order.get(record.sourceRange.startEntryId);
    const end = order.get(record.sourceRange.endEntryId);
    if (start === undefined || end === undefined) issues.push(`invalid-source-reference:${record.id}`);
    else if (start > end) issues.push(`invalid-source-range:${record.id}`);
  }
  for (const line of text.split("\n")) {
    if (line.endsWith("…")) issues.push("cut-line");
    if (line.includes("omitted detail") && !line.includes("Exact recovery:")) issues.push("loss-without-recovery");
    if (/\b(completed|resolved|passed)\b/i.test(line) && /\bunresolved\b/i.test(line)) issues.push("false-completion");
    if (line.includes("source fact") && !line.includes("Exact source:")) issues.push("unsupported-exact-fact");
  }
  return { ok: issues.length === 0, issues };
}
