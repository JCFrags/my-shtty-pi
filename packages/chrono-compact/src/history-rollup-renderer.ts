import { parseHistoricalBlocks } from "./blocks.js";
import { readSourceLedgerEntries } from "./ledger-branch.js";
import { queryHistoryRollups } from "./history-rollup-query.js";
import {
  loadRecentHistoryLeavesByTokens,
  readCurrentHistorySnapshot,
  type HistoryNode,
  type HistoryRollupRuntime,
} from "./history-rollup-store.js";
import {
  validateHistoryRollupPlan,
  validateHistoryRollupPrototype,
  type HistoryRenderPlanLine,
  type HistoryRollupValidationIssueCode,
} from "./history-rollup-validation.js";
import type { HistoryDynamicContext, HistoryValueRecord } from "./history-value.js";
import type { SourceLedger } from "./source-ledger.js";
import { directInstructionText, estimateTokensFromText } from "./utils.js";

export { validateHistoryRollupPrototype } from "./history-rollup-validation.js";
export type { HistoryRenderPlanLine } from "./history-rollup-validation.js";

export interface HistoryRollupRenderOptions {
  readonly targetTokens?: number;
  readonly hardTokens?: number;
  readonly currentTokens?: number;
  readonly recentTokens?: number;
  readonly olderTokens?: number;
  readonly archiveTokens?: number;
  readonly recentSourceTokens?: number;
  readonly dynamicContext?: HistoryDynamicContext;
}

export interface HistoryRollupQuality {
  outputTokens: number;
  currentRestrictionCount: number;
  exactCurrentRestrictions: number;
  recoveryOnlyRestrictions: number;
  omittedRestrictionsWithoutRoute: number;
  restrictionCueCoverage: number;
  restrictionExactCoverage: number;
  restrictionConflictCoverage: number;
  openTaskCoverage: number;
  blockerCoverage: number;
  nextActionCoverage: number;
  goalCoverage: number;
  decisionCoverage: number;
  unresolvedFailureCoverage: number;
  currentResourceCoverage: number;
  conflictCoverage: number;
  recentEventCoverage: number;
  recentSourceTokenCoverage: number;
  selectedOlderEvidenceCount: number;
  archiveRangeCoverage: number;
  lossyRecords: number;
  lossyRecordsWithRecovery: number;
  invalidSourceReferences: number;
  invalidSourceRanges: number;
  cutLines: number;
  missingRecoveryRoutes: number;
  falseCompletions: number;
  unsupportedIdentifiers: number;
  unsupportedQuotations: number;
  unsupportedNumbers: number;
  unsupportedFacts: number;
  sourceOrderErrors: number;
  duplicateRenderedRecords: number;
  sourceBytesReadDuringRender: number;
  exactSourceBytesLoaded: number;
  hardLimitReached: boolean;
  nodesReadDuringRender: number;
  nodeBytesReadDuringRender: number;
  queryNodesVisited: number;
  queryBytesRead: number;
  renderMs: number;
  peakRssKiB: number;
  timerDelayMs: number;
  integrityOk: boolean;
}

export interface HistoryRollupRenderResult {
  readonly text: string;
  readonly plan: readonly HistoryRenderPlanLine[];
  readonly validation: { readonly ok: boolean; readonly issues: readonly string[] };
  readonly quality: HistoryRollupQuality;
}

function rootRecords(root: HistoryNode): HistoryValueRecord[] {
  if (root.nodeType === "leaf") return [...root.valueRecords];
  return [
    ...root.currentStateRecords,
    ...root.conflictRecords,
    ...root.unresolvedFailureRecords,
    ...root.currentResourceRecords,
    ...root.openTaskRecords,
    ...root.selectedImportantEvidence,
    ...root.closedEpisodeCapsules,
    ...root.archiveRangeRecords,
  ];
}

function recovery(record: HistoryValueRecord): string {
  const start = record.sourceRange.startEntryId;
  const end = record.sourceRange.endEntryId;
  return start === end ? `history_get("${start}")` : `history_range("${start}", "${end}")`;
}

function planLine(
  section: HistoryRenderPlanLine["section"],
  record: HistoryValueRecord,
  text: string,
  lineType: HistoryRenderPlanLine["lineType"],
  lossy: boolean,
  included = false,
): HistoryRenderPlanLine {
  return {
    id: `${section}:${record.id}`,
    section,
    record,
    sourceRange: record.sourceRange,
    sourceOrder: record.sourceOrder,
    lineType,
    lossy,
    recoveryRoute: recovery(record),
    text,
    tokenEstimate: estimateTokensFromText(`${text}\n`),
    priority: record.priority,
    included,
  };
}

export function renderHistoryLossyCue(record: HistoryValueRecord): string {
  const cue = record.category === "failure"
    ? record.lifecycle === "unresolved"
      ? "Unresolved failure retained; source detail omitted."
      : "Failure state retained; source detail omitted."
    : record.lifecycle === "unresolved"
      ? "Unresolved blocker retained; source detail omitted."
      : record.cue ?? "Typed history record";
  return `[deterministic reduced ${record.category} ${record.lifecycle}; omitted detail] ${cue} — Exact recovery: ${recovery(record)}`;
}

async function restrictionLine(
  runtime: HistoryRollupRuntime,
  ledger: SourceLedger,
  record: HistoryValueRecord,
  budget: number,
): Promise<{ line: HistoryRenderPlanLine; bytes: number }> {
  const ref = record.sourceRefs[0];
  const indexed = ref ? ledger.entryById.get(ref.entryId) : undefined;
  const route = recovery(record);
  const recoveryText = (reason: string) =>
    `[derived recovery-only current restriction] ${reason} — Exact recovery: ${route}`;
  if (!ref || !indexed) return { line: planLine("current", record, recoveryText("Exact source required"), "derived", true), bytes: 0 };
  if (indexed.sourceByteLength > Math.max(4096, budget * 4)) {
    return { line: planLine("current", record, recoveryText("Exact instruction is larger than this section"), "derived", true), bytes: 0 };
  }
  try {
    const loaded = await readSourceLedgerEntries(runtime.sessionPath, ledger, [indexed], { maximumGapBytes: 0 });
    const blocks = parseHistoricalBlocks(loaded.entries, { includeHistoricalCompactions: false, includeMetadata: false });
    const block = ref.blockIndex === undefined
      ? blocks.find(candidate => candidate.entryId === ref.entryId)
      : blocks.find(candidate => candidate.entryId === ref.entryId && candidate.blockIndex === ref.blockIndex);
    const exact = block ? directInstructionText(block.exactText) : undefined;
    const text = exact
      ? `[exact current restriction; source fact] ${JSON.stringify(exact)} — Exact source: ${route}`
      : undefined;
    if (!text || estimateTokensFromText(text) > budget) {
      return { line: planLine("current", record, recoveryText("Exact instruction does not fit this section"), "derived", true), bytes: loaded.metrics.totalSourceBytesRead };
    }
    return { line: planLine("current", record, text, "exact", false), bytes: loaded.metrics.totalSourceBytesRead };
  } catch {
    return { line: planLine("current", record, recoveryText("Exact source unavailable"), "derived", true), bytes: 0 };
  }
}

function currentRank(record: HistoryValueRecord): number {
  if (record.category === "restriction" && record.sourceAuthority !== "assistant") return 0;
  if (record.category === "restriction" && record.lifecycle === "conflict") return 1;
  if (record.category === "blocker") return 2;
  if (record.category === "failure" && record.lifecycle === "unresolved") return 3;
  if (record.category === "next-action") return 4;
  if (record.lifecycle === "open") return 5;
  if (record.category === "goal") return 6;
  if (record.category === "decision") return 7;
  if (record.category === "resource-state") return 8;
  return 9;
}

function duplicateKey(record: HistoryValueRecord): string {
  return `${record.category}:${record.normalizedClaimHash}`;
}

function deduplicate(records: readonly HistoryValueRecord[]): HistoryValueRecord[] {
  const seen = new Set<string>();
  return records.filter(record => {
    const key = duplicateKey(record);
    if (seen.has(record.id) || seen.has(key)) return false;
    seen.add(record.id);
    seen.add(key);
    return true;
  });
}

function includeWithinBudget(
  lines: HistoryRenderPlanLine[],
  budget: number,
  protectedSections = false,
): HistoryRenderPlanLine[] {
  let used = 0;
  return lines.map(line => {
    if (used + line.tokenEstimate <= budget || protectedSections) {
      used += line.tokenEstimate;
      return { ...line, included: true };
    }
    return line;
  });
}

function finalReduction(plan: HistoryRenderPlanLine[], hardTokens: number): HistoryRenderPlanLine[] {
  let current = plan;
  const headingReserve = estimateTokensFromText("# CURRENT WORK\n# RECENT EVENTS\n# SELECTED OLDER EVIDENCE\n# ARCHIVE MAP\n");
  const total = () => headingReserve + current.filter(line => line.included).reduce((sum, line) => sum + line.tokenEstimate, 0);
  const removalOrder = [
    (line: HistoryRenderPlanLine) => line.section === "older" && line.record?.priority !== "A",
    (line: HistoryRenderPlanLine) => line.section === "recent" && line.record?.priority !== "A",
    (line: HistoryRenderPlanLine) => line.section === "archive" && line.lineType !== "omission",
    (line: HistoryRenderPlanLine) => line.section === "current" && line.record?.category === "status",
    (line: HistoryRenderPlanLine) => line.section === "current" && ["decision", "task-episode"].includes(line.record?.category ?? "") && line.record?.lifecycle === "closed",
    (line: HistoryRenderPlanLine) => line.section === "current" && line.record?.category === "goal",
    (line: HistoryRenderPlanLine) => line.section === "current" && line.record?.category === "task-episode" && line.record?.lifecycle === "open",
    (line: HistoryRenderPlanLine) => line.section === "current" && line.record?.category === "decision",
    (line: HistoryRenderPlanLine) => line.section === "current" && line.record?.category === "next-action" && line.record?.priority !== "A",
    (line: HistoryRenderPlanLine) => line.section === "current" && line.record?.category === "resource-state" && line.record?.priority !== "A",
    (line: HistoryRenderPlanLine) => line.section === "current" && ["blocker", "failure"].includes(line.record?.category ?? "") && line.record?.priority !== "A",
  ];
  for (const removable of removalOrder) {
    if (total() <= hardTokens) break;
    const candidates = current
      .filter(line => line.included && removable(line))
      .sort((a, b) => b.sourceOrder.start - a.sourceOrder.start || b.id.localeCompare(a.id));
    for (const candidate of candidates) {
      if (total() <= hardTokens) break;
      current = current.map(line => line.id === candidate.id ? { ...line, included: false } : line);
    }
  }
  return current;
}

function finalText(plan: readonly HistoryRenderPlanLine[]): string {
  const sections: { key: HistoryRenderPlanLine["section"]; heading: string }[] = [
    { key: "current", heading: "# CURRENT WORK" },
    { key: "recent", heading: "# RECENT EVENTS" },
    { key: "older", heading: "# SELECTED OLDER EVIDENCE" },
    { key: "archive", heading: "# ARCHIVE MAP" },
  ];
  return sections.map(section => {
    const lines = plan.filter(line => line.included && line.section === section.key).map(line => line.text);
    return `${section.heading}\n\n${lines.join("\n")}`;
  }).join("\n\n");
}

function coverage(records: readonly HistoryValueRecord[], plan: readonly HistoryRenderPlanLine[]): number {
  if (!records.length) return 1;
  const rendered = new Set(plan.filter(line => line.included).flatMap(line => line.record ? [line.record.id] : []));
  return records.filter(record => rendered.has(record.id)).length / records.length;
}

function issueCount(issues: readonly string[], code: HistoryRollupValidationIssueCode): number {
  return issues.filter(issue => issue === code).length;
}

export async function renderHistoryRollupPrototype(
  runtime: HistoryRollupRuntime,
  ledger: SourceLedger,
  options: HistoryRollupRenderOptions = {},
): Promise<HistoryRollupRenderResult> {
  const started = performance.now();
  let timerDelay = 0;
  let timerExpected = performance.now() + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    timerDelay = Math.max(timerDelay, now - timerExpected);
    timerExpected = now + 10;
  }, 10);
  timer.unref();
  const beforeNodes = runtime.nodesLoaded;
  const beforeBytes = runtime.nodeBytesRead;
  const target = Math.min(options.hardTokens ?? 25000, options.targetTokens ?? 20000);
  const hard = Math.min(25000, Math.max(target, options.hardTokens ?? 25000));
  const budgets = {
    current: options.currentTokens ?? Math.floor(target * 0.4),
    recent: options.recentTokens ?? Math.floor(target * 0.25),
    older: options.olderTokens ?? Math.floor(target * 0.25),
    archive: options.archiveTokens ?? Math.floor(target * 0.1),
  };
  const root = await readCurrentHistorySnapshot(runtime);
  if (!root) {
    const text = "# CURRENT WORK\n\nNo stored history.\n\n# RECENT EVENTS\n\n\n# SELECTED OLDER EVIDENCE\n\n\n# ARCHIVE MAP\n\n";
    clearInterval(timer);
    return {
      text,
      plan: [],
      validation: { ok: true, issues: [] },
      quality: emptyQuality(text, runtime, beforeNodes, beforeBytes, performance.now() - started),
    };
  }
  const rootSet = deduplicate(rootRecords(root));
  const current = rootSet.filter(record =>
    record.priority === "A" ||
    ["current", "unresolved", "open", "conflict"].includes(record.lifecycle) ||
    ["goal", "decision", "next-action", "blocker", "resource-state"].includes(record.category));
  let restrictions = deduplicate(current.filter(record => record.category === "restriction"));
  let sourceBytes = 0;
  const restrictionPlans: HistoryRenderPlanLine[] = [];
  for (const record of restrictions) {
    const result = await restrictionLine(runtime, ledger, record, Math.max(64, Math.floor(budgets.current / Math.max(1, restrictions.length))));
    restrictionPlans.push(result.line);
    sourceBytes += result.bytes;
  }
  const currentOther = deduplicate(current.filter(record => record.category !== "restriction"))
    .sort((a, b) => currentRank(a) - currentRank(b) || a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id))
    .map(record => planLine("current", record, renderHistoryLossyCue(record), "derived", true));
  const protectedCurrent = currentOther.filter(line =>
    line.record?.category === "blocker" ||
    line.record?.category === "next-action" ||
    line.record?.category === "resource-state" ||
    (line.record?.category === "failure" && line.record.lifecycle === "unresolved") ||
    line.record?.lifecycle === "conflict");
  const routineCurrent = currentOther.filter(line => !protectedCurrent.includes(line));
  const mandatoryTokens = [...restrictionPlans, ...protectedCurrent]
    .reduce((sum, line) => sum + line.tokenEstimate, 0);
  let plan: HistoryRenderPlanLine[] = [
    ...includeWithinBudget(restrictionPlans, budgets.current, true),
    ...includeWithinBudget(protectedCurrent, budgets.current, true),
    ...includeWithinBudget(routineCurrent, Math.max(0, budgets.current - mandatoryTokens)),
  ];
  const recentLeaves = await loadRecentHistoryLeavesByTokens(runtime, options.recentSourceTokens ?? 10000);
  const recentRecords = deduplicate(recentLeaves.flatMap(leaf => leaf.valueRecords).filter(record =>
    !plan.some(line => line.record && (line.record.id === record.id || duplicateKey(line.record) === duplicateKey(record)))));
  plan.push(...includeWithinBudget(
    recentRecords.sort((a, b) => a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id))
      .map(record => planLine("recent", record, renderHistoryLossyCue(record), "derived", true)),
    budgets.recent,
  ));
  const query = await queryHistoryRollups(runtime, { context: options.dynamicContext });
  const discoveredRestrictions = deduplicate([
    ...restrictions,
    ...recentRecords.filter(record => record.category === "restriction"),
    ...query.records.filter(record => record.category === "restriction"),
  ]);
  if (discoveredRestrictions.length > restrictions.length) {
    const known = new Set(restrictions.map(record => record.id));
    plan = plan.map(line => line.record?.category === "restriction" && line.section !== "current"
      ? { ...line, included: false }
      : line);
    for (const record of discoveredRestrictions) {
      if (known.has(record.id)) continue;
      const loaded = await restrictionLine(
        runtime,
        ledger,
        record,
        Math.max(48, Math.floor(budgets.current / Math.max(1, discoveredRestrictions.length))),
      );
      sourceBytes += loaded.bytes;
      plan.push({ ...loaded.line, included: true });
    }
    restrictions = discoveredRestrictions;
  }
  const olderRecords = deduplicate(query.records.filter(record =>
    record.category !== "archive-range" &&
    !plan.some(line => line.record && (line.record.id === record.id || duplicateKey(line.record) === duplicateKey(record)))));
  plan.push(...includeWithinBudget(
    olderRecords.map(record => planLine("older", record, renderHistoryLossyCue(record), "derived", true)),
    budgets.older,
  ));
  const archiveRecords = deduplicate(rootSet.filter(record => record.category === "archive-range"))
    .sort((a, b) => a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id));
  const archiveLines = archiveRecords.length
    ? archiveRecords.map(record => planLine("archive", record, renderHistoryLossyCue(record), "derived", true))
    : [planLine(
        "archive",
        {
          ...restrictions[0] ?? rootSet[0]!,
          id: `archive:${root.nodeId}`,
          category: "archive-range",
          sourceRange: root.sourceRange,
          sourceOrder: root.branchOrderRange,
          cue: "Stored branch archive range.",
        },
        `[archive map; derived] Stored branch range — Exact recovery: history_range("${root.sourceRange.startEntryId}", "${root.sourceRange.endEntryId}")`,
        "derived",
        true,
      )];
  plan.push(...includeWithinBudget(archiveLines, budgets.archive));
  plan = finalReduction(plan, hard);
  const text = finalText(plan);
  const validation = await validateHistoryRollupPlan(runtime, ledger, plan, hard);
  sourceBytes += validation.exactSourceBytesRead;
  const included = plan.filter(line => line.included);
  const includedRestrictions = included.filter(line => line.record?.category === "restriction");
  const exactRestrictions = includedRestrictions.filter(line => line.lineType === "exact").length;
  const directRecoveryRestrictions = includedRestrictions.filter(line => line.lineType !== "exact" && line.recoveryRoute).length;
  const aggregateRestrictionCount = root.nodeType === "rollup"
    ? root.aggregateCounts.restriction ?? restrictions.length
    : restrictions.length;
  const currentRestrictionCount = Math.max(aggregateRestrictionCount, restrictions.length);
  const archiveRestrictionRecovery = included.some(line => line.section === "archive" && line.recoveryRoute)
    ? Math.max(0, currentRestrictionCount - exactRestrictions - directRecoveryRestrictions)
    : 0;
  const recoveryRestrictions = directRecoveryRestrictions + archiveRestrictionRecovery;
  const restrictionConflicts = restrictions.filter(record => record.lifecycle === "conflict");
  const issues = validation.issues;
  const quality: HistoryRollupQuality = {
    outputTokens: estimateTokensFromText(text),
    currentRestrictionCount,
    exactCurrentRestrictions: exactRestrictions,
    recoveryOnlyRestrictions: recoveryRestrictions,
    omittedRestrictionsWithoutRoute: Math.max(0, currentRestrictionCount - exactRestrictions - recoveryRestrictions),
    restrictionCueCoverage: currentRestrictionCount ? Math.min(1, (exactRestrictions + recoveryRestrictions) / currentRestrictionCount) : 1,
    restrictionExactCoverage: currentRestrictionCount ? exactRestrictions / currentRestrictionCount : 1,
    restrictionConflictCoverage: coverage(restrictionConflicts, plan),
    openTaskCoverage: coverage(current.filter(record => record.lifecycle === "open"), plan),
    blockerCoverage: coverage(current.filter(record => record.category === "blocker"), plan),
    nextActionCoverage: coverage(current.filter(record => record.category === "next-action"), plan),
    goalCoverage: coverage(current.filter(record => record.category === "goal"), plan),
    decisionCoverage: coverage(current.filter(record => record.category === "decision"), plan),
    unresolvedFailureCoverage: coverage(current.filter(record => record.category === "failure" && record.lifecycle === "unresolved"), plan),
    currentResourceCoverage: coverage(current.filter(record => record.category === "resource-state"), plan),
    conflictCoverage: coverage(current.filter(record => record.lifecycle === "conflict"), plan),
    recentEventCoverage: coverage(recentRecords, plan),
    recentSourceTokenCoverage: Math.min(1, recentLeaves.reduce((sum, leaf) => sum + leaf.sourceTokenEstimate, 0) / Math.max(1, options.recentSourceTokens ?? 10000)),
    selectedOlderEvidenceCount: included.filter(line => line.section === "older").length,
    archiveRangeCoverage: included.some(line => line.section === "archive") ? 1 : 0,
    lossyRecords: included.filter(line => line.lossy).length,
    lossyRecordsWithRecovery: included.filter(line => line.lossy && line.recoveryRoute).length,
    invalidSourceReferences: issueCount(issues, "invalid-source-reference"),
    invalidSourceRanges: issueCount(issues, "invalid-source-range"),
    cutLines: issueCount(issues, "cut-line"),
    missingRecoveryRoutes: issueCount(issues, "loss-without-recovery") + issueCount(issues, "missing-current-restriction-route"),
    falseCompletions: issueCount(issues, "unresolved-became-complete") + issueCount(issues, "failure-became-success"),
    unsupportedIdentifiers: issueCount(issues, "unsupported-identifier"),
    unsupportedQuotations: issueCount(issues, "unsupported-quotation"),
    unsupportedNumbers: issueCount(issues, "unsupported-number"),
    unsupportedFacts: issueCount(issues, "unsupported-identifier") + issueCount(issues, "unsupported-quotation") + issueCount(issues, "unsupported-number"),
    sourceOrderErrors: issueCount(issues, "source-order"),
    duplicateRenderedRecords: issueCount(issues, "duplicate-rendered-record"),
    sourceBytesReadDuringRender: sourceBytes,
    exactSourceBytesLoaded: sourceBytes,
    hardLimitReached: estimateTokensFromText(text) >= hard,
    nodesReadDuringRender: runtime.nodesLoaded - beforeNodes,
    nodeBytesReadDuringRender: runtime.nodeBytesRead - beforeBytes,
    queryNodesVisited: query.nodesVisited,
    queryBytesRead: query.nodeBytesRead,
    renderMs: performance.now() - started,
    peakRssKiB: process.resourceUsage().maxRSS,
    timerDelayMs: timerDelay,
    integrityOk: validation.ok,
  };
  clearInterval(timer);
  return { text, plan, validation, quality };
}

function emptyQuality(
  text: string,
  runtime: HistoryRollupRuntime,
  beforeNodes: number,
  beforeBytes: number,
  renderMs: number,
): HistoryRollupQuality {
  return {
    outputTokens: estimateTokensFromText(text),
    currentRestrictionCount: 0,
    exactCurrentRestrictions: 0,
    recoveryOnlyRestrictions: 0,
    omittedRestrictionsWithoutRoute: 0,
    restrictionCueCoverage: 1,
    restrictionExactCoverage: 1,
    restrictionConflictCoverage: 1,
    openTaskCoverage: 1,
    blockerCoverage: 1,
    nextActionCoverage: 1,
    goalCoverage: 1,
    decisionCoverage: 1,
    unresolvedFailureCoverage: 1,
    currentResourceCoverage: 1,
    conflictCoverage: 1,
    recentEventCoverage: 1,
    recentSourceTokenCoverage: 1,
    selectedOlderEvidenceCount: 0,
    archiveRangeCoverage: 1,
    lossyRecords: 0,
    lossyRecordsWithRecovery: 0,
    invalidSourceReferences: 0,
    invalidSourceRanges: 0,
    cutLines: 0,
    missingRecoveryRoutes: 0,
    falseCompletions: 0,
    unsupportedIdentifiers: 0,
    unsupportedQuotations: 0,
    unsupportedNumbers: 0,
    unsupportedFacts: 0,
    sourceOrderErrors: 0,
    duplicateRenderedRecords: 0,
    sourceBytesReadDuringRender: 0,
    exactSourceBytesLoaded: 0,
    hardLimitReached: false,
    nodesReadDuringRender: runtime.nodesLoaded - beforeNodes,
    nodeBytesReadDuringRender: runtime.nodeBytesRead - beforeBytes,
    queryNodesVisited: 0,
    queryBytesRead: 0,
    renderMs,
    peakRssKiB: process.resourceUsage().maxRSS,
    timerDelayMs: 0,
    integrityOk: true,
  };
}
