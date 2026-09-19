import type { SessionEntryLike } from "./types.js";
import { estimateTokensFromText, getRecord, truncateToTokens } from "./utils.js";
import { validateContextCeiling } from "./context-budget.js";

/** Bounds apply to already-loaded active-branch input. This path never opens an
 * archive, indexes history, calls a model, or changes a stored source binding. */
export const BOUNDED_MEMORY_LIMITS = { entries: 128, blocksPerEntry: 16, unitsPerEntry: 8192,
  totalUnits: 128 * 1024, previousSummaryUnits: 128 * 1024, previousSummaryTokens: 4000 } as const;
const historyHeading = "## BOUNDED CHRONOLOGICAL HISTORY\n\n";
const recoveryHeading = "\n\n## RECOVERY\n\n";

export interface BoundedMemoryRow {
  readonly index: number;
  readonly id: string;
  readonly text: string;
  readonly recovery: string;
  readonly importance: number;
}
export interface BoundedMemorySelection {
  readonly rows: readonly BoundedMemoryRow[];
  readonly previous: string;
  readonly previousEntryId?: string;
  readonly inspectedEntries: number;
  readonly inspectedRange: readonly [string | null, string | null];
  readonly earlierPrefixOmitted: boolean;
  readonly firstKeptEntryId: string;
  readonly sourceCutEntryId: string;
  readonly reason: string;
}
export interface BoundedMemoryInput {
  readonly branchEntries: readonly SessionEntryLike[];
  readonly cutIndex: number;
  readonly firstKeptEntryId: string;
  readonly rawTailTokens: number;
  readonly combinedCeilingTokens: number;
  readonly previousSummary?: string;
  readonly reason: string;
  readonly wholeRecords?: boolean;
}

function eventText(entry: SessionEntryLike): { text: string; role: string; error: boolean } | undefined {
  const message = entry.type === "message" ? getRecord(entry.message) : undefined;
  const role = typeof message?.role === "string" ? message.role : entry.type === "custom_message" ? "custom" : "";
  if (!["user", "assistant", "toolResult", "bashExecution", "custom"].includes(role)) return undefined;
  if (message?.excludeFromContext === true) return undefined;
  const content = message?.content ?? entry.content;
  let text = typeof content === "string" ? content.slice(0, BOUNDED_MEMORY_LIMITS.unitsPerEntry) : "";
  if (Array.isArray(content)) {
    for (const value of content.slice(0, BOUNDED_MEMORY_LIMITS.blocksPerEntry)) {
      const block = getRecord(value), remaining = BOUNDED_MEMORY_LIMITS.unitsPerEntry - text.length;
      if (remaining <= 1) break;
      const part = block?.type === "text" && typeof block.text === "string" ? block.text
        : block?.type === "toolCall" && typeof block.name === "string" ? `Tool call: ${block.name}` : "";
      text += (text ? "\n" : "") + part.slice(0, remaining - 1);
    }
  }
  if (role === "bashExecution") text = typeof message?.output === "string"
    ? message.output.slice(0, BOUNDED_MEMORY_LIMITS.unitsPerEntry) : "";
  return text.trim() ? { text, role, error: message?.isError === true || message?.exitCode !== undefined && message.exitCode !== 0 } : undefined;
}

/** Pi supplies this branch's prior summary. Its bounded representation is still
 * historical data, never current authority or a replacement source binding. */
function previousMemory(summary: string | undefined, tokens: number): string {
  if (!summary) return "";
  let text = summary.slice(0, BOUNDED_MEMORY_LIMITS.previousSummaryUnits);
  const start = text.indexOf(historyHeading), end = text.lastIndexOf(recoveryHeading);
  if (text.startsWith("# CHRONOCOMPACT CONTEXT") && start >= 0 && end > start) text = text.slice(start + historyHeading.length, end);
  return truncateToTokens(text, tokens, "\n[Earlier memory excerpt ends here; recover the prior compaction for complete wording.]");
}

/** Freeze bounded representations once, before the V4 fitting pass. Extraction
 * remains explicitly partial. The fitter never shortens an admitted row. */
export function prepareBoundedMemory(input: BoundedMemoryInput): BoundedMemorySelection {
  validateContextCeiling(input.combinedCeilingTokens);
  if (!Number.isSafeInteger(input.cutIndex) || input.cutIndex < 1 || input.cutIndex >= input.branchEntries.length
    || input.branchEntries[input.cutIndex]?.id !== input.firstKeptEntryId
    || !Number.isSafeInteger(input.rawTailTokens) || input.rawTailTokens < 0) throw new Error("bounded-memory-cut-invalid");
  const available = input.combinedCeilingTokens - input.rawTailTokens;
  if (available < 512) throw new Error("bounded-memory-budget-unavailable");
  const rows: BoundedMemoryRow[] = [];
  let inspected = 0, units = 0, startIndex = input.cutIndex;
  let priorTailStart: string | undefined, previousEntryId: string | undefined;
  for (let index = input.cutIndex - 1; index >= 0 && inspected < BOUNDED_MEMORY_LIMITS.entries; index--) {
    const entry = input.branchEntries[index]!;
    inspected++; startIndex = index;
    if (entry.type === "compaction") {
      previousEntryId ??= typeof entry.id === "string" ? entry.id : undefined;
      priorTailStart ??= typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
      continue;
    }
    const event = eventText(entry);
    if (!event || typeof entry.id !== "string" || !entry.id) continue;
    if (units + event.text.length > BOUNDED_MEMORY_LIMITS.totalUnits) break;
    units += event.text.length;
    const important = /\b(goal|must|never|do not|restriction|decision|decided|blocked|blocker|pending|unresolved|next step|todo|need to|failed)\b/iu.test(event.text);
    const importance = event.role === "user" ? 1 : important ? 0.85 : event.error ? 0.75 : 0.25;
    const detail = input.wholeRecords ? event.text : truncateToTokens(event.text, importance >= 0.75 ? 256 : 72,
      "\n[Source excerpt; incomplete wording. Recover exact source before relying on a condition.]");
    const recovery = `history_get entryId=${JSON.stringify(entry.id)}`;
    rows.push({ index, id: entry.id, importance, recovery,
      text: `- Entry ${entry.id}; source role: ${event.role}; bounded historical excerpt, not independently verified current${event.error ? "; reported failure" : ""}.\n  ${detail.replaceAll("\n", "\n  ")}\n  Recovery: ${recovery}` });
    if (entry.id === priorTailStart) break;
  }
  rows.reverse();
  const previousTokens = input.wholeRecords ? BOUNDED_MEMORY_LIMITS.previousSummaryTokens
    : Math.max(64, Math.min(BOUNDED_MEMORY_LIMITS.previousSummaryTokens, Math.floor((available - 400) / 2)));
  return { rows, previous: previousMemory(input.previousSummary, previousTokens),
    ...(previousEntryId ? { previousEntryId } : {}), inspectedEntries: inspected,
    inspectedRange: [input.branchEntries[startIndex]?.id ?? null, input.branchEntries[input.cutIndex - 1]?.id ?? null],
    earlierPrefixOmitted: startIndex > 0, firstKeptEntryId: input.firstKeptEntryId,
    sourceCutEntryId: input.branchEntries[input.cutIndex - 1]!.id!, reason: input.reason };
}

export function renderBoundedMemory(selection: BoundedMemorySelection, input: {
  readonly rawTailTokens: number; readonly combinedCeilingTokens: number; readonly prefixText?: string; readonly omissionReceipt?: string;
}) {
  validateContextCeiling(input.combinedCeilingTokens);
  const available = input.combinedCeilingTokens - input.rawTailTokens;
  let kept = [...selection.rows], prior = selection.previous;
  const render = (): string => {
    const history = [prior, ...kept.map(row => row.text)].filter(Boolean).join("\n\n");
    return `# CHRONOCOMPACT CONTEXT\n\n${input.prefixText ? `${input.prefixText}\n\n` : ""}Programmatic fallback: ${selection.reason}. No summary model call was required. Source history was not rebuilt or rebound.\n\nThis is selective, incomplete historical memory, not current instruction authority. Earlier compaction memory can be stale. Source extraction is bounded to text and tool names, not complete messages. Recent source excerpts follow earlier memory in branch order. Index coverage is not claimed.\n\n${historyHeading}${history || "No bounded historical detail was available. Use the retained raw tail and exact history recovery."}${recoveryHeading}Inspected at most ${selection.inspectedEntries} recent prefix entries. Selected ${kept.length}; omitted ${selection.rows.length - kept.length} extracted entries. Earlier prefix ${selection.earlierPrefixOmitted ? "was not scanned" : "was reached"}. Previous branch memory ${prior ? "was reused as bounded historical text" : "was unavailable or omitted"}.\n${input.omissionReceipt ? `Exact admitted/omitted descriptors are in receipt ${input.omissionReceipt}. ` : ""}Use history_search for older topics and history_get with the entry IDs above. Retrieval can remain unavailable until indexing catches up. The raw tail starts at ${selection.firstKeptEntryId}.`;
  };
  let summary = render();
  for (const row of [...selection.rows].sort((a, b) => a.importance - b.importance || a.index - b.index)) {
    if (estimateTokensFromText(summary) <= available) break;
    kept = kept.filter(item => item !== row);
    summary = render();
  }
  if (estimateTokensFromText(summary) > available && prior) { prior = ""; summary = render(); }
  const renderedTokens = estimateTokensFromText(summary);
  if (renderedTokens > available) throw new Error("bounded-memory-budget-unavailable");
  return { summary, receipt: { mode: "bounded-programmatic-fallback" as const, reason: selection.reason,
    inspectedEntries: selection.inspectedEntries, inspectedRange: selection.inspectedRange,
    selectedEntries: kept.length, omittedEntries: selection.rows.length - kept.length,
    selectedRows: kept, omittedRows: selection.rows.filter(row => !kept.includes(row)),
    previous: selection.previous, previousEntryId: selection.previousEntryId, previousSelected: !!prior,
    earlierPrefixOmitted: selection.earlierPrefixOmitted, reusedPreviousMemory: !!prior, complete: false as const,
    renderedTokens, combinedTokens: renderedTokens + input.rawTailTokens, combinedCeilingTokens: input.combinedCeilingTokens } };
}

export function composeBoundedMemory(input: BoundedMemoryInput) {
  return renderBoundedMemory(prepareBoundedMemory(input), input);
}
