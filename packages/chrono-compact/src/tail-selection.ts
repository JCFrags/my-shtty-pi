import type { SessionEntryLike } from "./types.js";
import { getArray, getRecord, getString } from "./utils.js";

export type RawTailMode = "pi" | "fixed" | "short" | "medium" | "long" | "dynamic";

export interface RawTailSelection {
  readonly mode: RawTailMode;
  readonly desiredTokens?: number;
  readonly actualTokens: number;
  readonly firstKeptEntryId: string;
  readonly cutIndex: number;
  readonly reason: string;
}

export const RAW_TAIL_PRESET_TOKENS = {
  short: 8_000,
  medium: 16_000,
  long: 24_000,
} as const;

export function isValidCompactionCut(entry: SessionEntryLike): boolean {
  if (entry.type === "message") {
    const role = getRecord(entry.message)?.role;
    return role === "user" || role === "assistant" || role === "bashExecution";
  }
  return entry.type === "custom_message" || entry.type === "branch_summary";
}

function toolCallIds(entry: SessionEntryLike): string[] {
  const message = entry.type === "message" ? getRecord(entry.message) : undefined;
  if (message?.role !== "assistant") return [];
  return (getArray(message.content) ?? []).flatMap((content) => {
    const block = getRecord(content);
    return block?.type === "toolCall" && typeof block.id === "string" ? [block.id] : [];
  });
}

function toolResultId(entry: SessionEntryLike): string | undefined {
  const message = entry.type === "message" ? getRecord(entry.message) : undefined;
  return message?.role === "toolResult" ? getString(message.toolCallId) : undefined;
}

function safeCutIndexes(entries: readonly SessionEntryLike[]): ReadonlySet<number> {
  const safe = new Set<number>();
  const callIndexById = new Map<string, number>();
  const resultIndexByCallId = new Map<string, number>();
  entries.forEach((entry, index) => {
    for (const callId of toolCallIds(entry)) callIndexById.set(callId, index);
    const resultId = toolResultId(entry);
    if (resultId) resultIndexByCallId.set(resultId, index);
  });
  let lastOrphanResultIndex = -1;
  entries.forEach((entry, index) => {
    const resultId = toolResultId(entry);
    if (!resultId) return;
    const callIndex = callIndexById.get(resultId);
    if (callIndex === undefined || callIndex >= index) lastOrphanResultIndex = index;
  });

  const crossingToolCalls = new Set<string>();
  for (let cutIndex = 1; cutIndex < entries.length; cutIndex += 1) {
    const previous = entries[cutIndex - 1];
    if (previous) {
      for (const toolCallId of toolCallIds(previous)) {
        const resultIndex = resultIndexByCallId.get(toolCallId);
        if (resultIndex !== undefined && resultIndex >= cutIndex) crossingToolCalls.add(toolCallId);
      }
      const resultId = toolResultId(previous);
      if (resultId) crossingToolCalls.delete(resultId);
    }
    const entry = entries[cutIndex];
    const orphanResultRemainsInTail = cutIndex <= lastOrphanResultIndex;
    if (
      entry
      && typeof entry.id === "string"
      && isValidCompactionCut(entry)
      && crossingToolCalls.size === 0
      && !orphanResultRemainsInTail
    ) {
      safe.add(cutIndex);
    }
  }
  return safe;
}

export function isSafeCompactionCut(entries: readonly SessionEntryLike[], cutIndex: number): boolean {
  return safeCutIndexes(entries).has(cutIndex);
}

export function selectRawTail(
  entries: readonly SessionEntryLike[],
  desiredTokens: number,
  estimateTokens: (entries: readonly SessionEntryLike[]) => number,
): RawTailSelection | undefined {
  const desired = Math.max(256, Math.floor(desiredTokens));
  const candidates: RawTailSelection[] = [];
  const safeCuts = safeCutIndexes(entries);
  for (let cutIndex = 1; cutIndex < entries.length; cutIndex += 1) {
    const entry = entries[cutIndex];
    if (!entry || typeof entry.id !== "string" || !safeCuts.has(cutIndex)) continue;
    const actualTokens = estimateTokens(entries.slice(cutIndex));
    candidates.push({
      mode: "fixed",
      desiredTokens: desired,
      actualTokens,
      firstKeptEntryId: entry.id,
      cutIndex,
      reason: "selected the smallest valid chronological tail that meets the configured raw-tail target",
    });
  }
  if (candidates.length === 0) return undefined;

  const meetingTarget = candidates
    .filter((candidate) => candidate.actualTokens >= desired)
    .sort((a, b) => a.actualTokens - b.actualTokens || b.cutIndex - a.cutIndex)[0];
  if (meetingTarget) return meetingTarget;

  const largestAvailable = [...candidates].sort(
    (a, b) => b.actualTokens - a.actualTokens || a.cutIndex - b.cutIndex,
  )[0]!;
  return {
    ...largestAvailable,
    reason: "the branch has less valid raw-tail content than the configured target, so the largest available tail was selected",
  };
}

export function selectRawTailWithinMaximum(
  entries: readonly SessionEntryLike[],
  maximumTokens: number,
  estimateTokens: (entries: readonly SessionEntryLike[]) => number,
): RawTailSelection | undefined {
  const maximum = Math.max(256, Math.floor(maximumTokens));
  const candidates: RawTailSelection[] = [];
  const safeCuts = safeCutIndexes(entries);
  for (let cutIndex = 1; cutIndex < entries.length; cutIndex += 1) {
    const entry = entries[cutIndex];
    if (!entry || typeof entry.id !== "string" || !safeCuts.has(cutIndex)) continue;
    const actualTokens = estimateTokens(entries.slice(cutIndex));
    if (actualTokens > maximum) continue;
    candidates.push({
      mode: "fixed",
      desiredTokens: maximum,
      actualTokens,
      firstKeptEntryId: entry.id,
      cutIndex,
      reason: "selected the largest valid chronological raw tail within the hard combined-context ceiling",
    });
  }
  return candidates.sort((a, b) => b.actualTokens - a.actualTokens || a.cutIndex - b.cutIndex)[0];
}

export function selectDynamicRawTail(
  entries: readonly SessionEntryLike[],
  minimumTokens: number,
  maximumTokens: number,
  estimateTokens: (entries: readonly SessionEntryLike[]) => number,
): RawTailSelection | undefined {
  const minimum = Math.max(256, Math.floor(Math.min(minimumTokens, maximumTokens)));
  const maximum = Math.max(minimum, Math.floor(Math.max(minimumTokens, maximumTokens)));
  let currentTurnStart = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && getRecord(entry.message)?.role === "user") {
      currentTurnStart = index;
      break;
    }
  }
  const currentTurnTokens = currentTurnStart < 0 ? 0 : estimateTokens(entries.slice(currentTurnStart));
  const continuityMarginTokens = 1_500;
  const desiredTokens = Math.min(maximum, Math.max(minimum, currentTurnTokens + continuityMarginTokens));
  let selected = selectRawTail(entries, desiredTokens, estimateTokens);
  if (!selected) return undefined;
  if (selected.actualTokens > maximum) {
    const safeCuts = safeCutIndexes(entries);
    const withinMaximum = entries
      .map((entry, cutIndex) => ({ entry, cutIndex }))
      .filter(({ entry, cutIndex }) => cutIndex > 0 && typeof entry.id === "string" && safeCuts.has(cutIndex))
      .map(({ entry, cutIndex }) => ({ entry, cutIndex, actualTokens: estimateTokens(entries.slice(cutIndex)) }))
      .filter((candidate) => candidate.actualTokens <= maximum)
      .sort((a, b) => b.actualTokens - a.actualTokens || a.cutIndex - b.cutIndex)[0];
    if (withinMaximum && typeof withinMaximum.entry.id === "string") {
      selected = {
        mode: "fixed",
        desiredTokens,
        actualTokens: withinMaximum.actualTokens,
        firstKeptEntryId: withinMaximum.entry.id,
        cutIndex: withinMaximum.cutIndex,
        reason: "selected the largest valid chronological tail within the dynamic maximum",
      };
    }
  }
  const boundaryNote = selected.actualTokens < minimum
    ? "; valid cut boundaries forced the actual tail below the minimum"
    : selected.actualTokens > maximum
      ? "; one indivisible valid tail exceeded the maximum"
      : "";
  return {
    ...selected,
    mode: "dynamic",
    reason: `dynamic raw tail selected ${desiredTokens} target tokens from a ${currentTurnTokens}-token current turn plus a ${continuityMarginTokens}-token continuity margin, bounded to ${minimum}–${maximum}; only boundaries with complete raw-tail tool structure were eligible${boundaryNote}`,
  };
}
