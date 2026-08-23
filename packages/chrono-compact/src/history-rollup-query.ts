import { createHash } from "node:crypto";
import { historyDynamicValue, type HistoryDynamicContext, type HistoryValueRecord } from "./history-value.js";
import {
  loadHistoryNode,
  readCurrentHistorySnapshot,
  type HistoryNode,
  type HistoryRollupRuntime,
} from "./history-rollup-store.js";

export interface HistoryRollupQueryOptions {
  readonly context?: HistoryDynamicContext;
  readonly maximumNodes?: number;
  readonly maximumNodeBytes?: number;
  readonly maximumRecords?: number;
}

export interface HistoryRollupQueryResult {
  readonly records: readonly HistoryValueRecord[];
  readonly nodesVisited: number;
  readonly nodeBytesRead: number;
  readonly targetLeavesLoaded: number;
  readonly sourceOrderValid: boolean;
}

function hashTerm(salt: string, term: string): string {
  return createHash("sha256").update(`${salt}:${term.toLowerCase()}`).digest("hex");
}

function contextTermHashes(runtime: HistoryRollupRuntime, context: HistoryDynamicContext): Set<string> {
  const salt = runtime.manifest?.querySalt ?? "";
  const text = `${context.retentionHints ?? ""} ${(context.recentTailTerms ?? []).join(" ")}`;
  const terms = text.toLowerCase().match(/[a-z][a-z0-9_.:/-]{2,}/g) ?? [];
  return new Set(terms.map(term => hashTerm(salt, term)));
}

function nodeScore(
  runtime: HistoryRollupRuntime,
  node: HistoryNode,
  context: HistoryDynamicContext,
  termHashes: Set<string>,
): number {
  let score = node.queryIndex.hasCurrentState ? 20 : 0;
  score += node.queryIndex.termHashes.filter(hash => termHashes.has(hash)).length * 30;
  score += node.queryIndex.resourceIdentities.filter(id => context.currentResourceIdentities?.includes(id)).length * 30;
  score += node.queryIndex.taskIdentities.filter(id => context.openTaskIds?.includes(id)).length * 30;
  score += node.queryIndex.failureIdentities.filter(id => context.unresolvedFailureKeys?.includes(id)).length * 30;
  score += node.queryIndex.categories.filter(category => context.desiredCategories?.includes(category)).length * 15;
  score += node.branchOrderRange.end / Math.max(1, runtime.branchManifest?.sourceBranchEntryCount ?? 1);
  return score;
}

function recordsFromNode(node: HistoryNode): HistoryValueRecord[] {
  if (node.nodeType === "leaf") return [...node.valueRecords];
  return [
    ...node.currentStateRecords,
    ...node.conflictRecords,
    ...node.unresolvedFailureRecords,
    ...node.currentResourceRecords,
    ...node.openTaskRecords,
    ...node.selectedImportantEvidence,
    ...node.closedEpisodeCapsules,
  ];
}

export async function queryHistoryRollups(
  runtime: HistoryRollupRuntime,
  options: HistoryRollupQueryOptions = {},
): Promise<HistoryRollupQueryResult> {
  const context = options.context ?? {};
  const maximumNodes = options.maximumNodes ?? runtime.config.maximumQueryNodes;
  const maximumNodeBytes = options.maximumNodeBytes ?? runtime.config.maximumQueryNodeBytes;
  const maximumRecords = options.maximumRecords ?? runtime.config.maximumQueryRecords;
  const beforeBytes = runtime.nodeBytesRead;
  const root = await readCurrentHistorySnapshot(runtime);
  if (!root) return { records: [], nodesVisited: 0, nodeBytesRead: 0, targetLeavesLoaded: 0, sourceOrderValid: true };
  const termHashes = contextTermHashes(runtime, context);
  const queue: { id: string; node: HistoryNode; score: number }[] = [
    { id: root.nodeId, node: root, score: nodeScore(runtime, root, context, termHashes) },
  ];
  const records = new Map<string, HistoryValueRecord>();
  let nodesVisited = 0;
  let targetLeavesLoaded = 0;
  while (queue.length && nodesVisited < maximumNodes && runtime.nodeBytesRead - beforeBytes <= maximumNodeBytes) {
    queue.sort((a, b) => b.score - a.score || a.node.branchOrderRange.start - b.node.branchOrderRange.start || a.id.localeCompare(b.id));
    const current = queue.shift()!;
    nodesVisited++;
    for (const record of recordsFromNode(current.node)) records.set(record.id, record);
    if (current.node.nodeType === "leaf") {
      targetLeavesLoaded++;
      continue;
    }
    for (const childId of current.node.childNodeIds) {
      if (nodesVisited + queue.length >= maximumNodes) break;
      const child = await loadHistoryNode(runtime, childId);
      if (runtime.nodeBytesRead - beforeBytes > maximumNodeBytes) break;
      queue.push({ id: childId, node: child, score: nodeScore(runtime, child, context, termHashes) });
    }
  }
  const selected = [...records.values()]
    .sort((a, b) => historyDynamicValue(b, context) - historyDynamicValue(a, context) || a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id))
    .slice(0, maximumRecords)
    .sort((a, b) => a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id));
  return {
    records: selected,
    nodesVisited,
    nodeBytesRead: runtime.nodeBytesRead - beforeBytes,
    targetLeavesLoaded,
    sourceOrderValid: selected.every((record, index) => index === 0 || selected[index - 1]!.sourceOrder.start <= record.sourceOrder.start),
  };
}
