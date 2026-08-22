import type { HistoricalBlock } from "../types.js";
import { reduceAssistantProse } from "./assistant.js";
import { looksLikeDiff, reduceDiff } from "./diff.js";
import { reduceFileRead } from "./file-read.js";
import { reduceGenericText } from "./generic.js";
import { parseStructuredJson, reduceStructuredJson } from "./json.js";
import { normalizeTerminalText } from "./normalize.js";
import { looksLikeSearchOutput, reduceSearchOutput } from "./search.js";
import { reduceTerminalOutput } from "./terminal.js";
import type { ReducerContext, ReducerResult } from "./types.js";

export const REDUCER_VERSIONS = Object.freeze({
  terminal: "2.0.0",
  "test-output": "1.0.0",
  "file-read": "1.0.0",
  "git-diff": "1.0.0",
  "search-results": "1.0.0",
  "structured-json": "2.0.0",
  "assistant-extractive": "1.0.0",
  "assistant-cleanup": "1.0.0",
  "generic-text": "1.0.0",
  "user-reference-segmentation": "1.0.0",
  "exact-repeat": "1.0.0",
  "observation-delta": "1.0.0",
  "resource-lineage": "2.0.1",
  "near-duplicate-template": "2.0.1",
  "history-editor-v1": "1.1.0",
});

export function normalizeBlock(block: HistoricalBlock): ReducerResult | undefined {
  const normalized = normalizeTerminalText(block.exactText);
  if (!normalized.changed) return undefined;
  return {
    text: normalized.text,
    reducer: "lossless-normalizer",
    version: "1.0.0",
    lossy: false,
    omissions: normalized.omissions,
    metadata: normalized.metadata,
  };
}

export function reducePersistentBlock(context: ReducerContext): ReducerResult | undefined {
  const { block } = context;
  if (block.kind === "assistant_reasoning" || block.kind === "assistant_text" || block.kind === "branch_summary") return undefined;
  if (block.kind === "tool_result" || block.kind === "bash_execution") {
    if (looksLikeDiff(block.exactText)) return reduceDiff(context);
    if (/^read$/i.test(block.toolName ?? "")) return undefined;
    if (/^(?:bash|shell|terminal|exec)$/i.test(block.toolName ?? "") || block.kind === "bash_execution") return reduceTerminalOutput(context);
    if (looksLikeSearchOutput(context)) return undefined;
    const parsed = parseStructuredJson(block.exactText);
    if (parsed !== undefined) return reduceStructuredJson(context, parsed) ?? reduceGenericText(context);
    return reduceGenericText(context);
  }
  if (block.kind === "custom_message" || block.kind === "user") return reduceAssistantProse(context);
  return reduceGenericText(context);
}

export function reduceBlock(context: ReducerContext): ReducerResult {
  const { block } = context;
  if (block.kind === "assistant_reasoning" || block.kind === "assistant_text" || block.kind === "branch_summary") {
    return reduceAssistantProse(context);
  }
  if (block.kind === "tool_result" || block.kind === "bash_execution") {
    if (looksLikeDiff(block.exactText)) return reduceDiff(context);
    if (/^read$/i.test(block.toolName ?? "")) return reduceFileRead(context);
    if (/^(?:bash|shell|terminal|exec)$/i.test(block.toolName ?? "") || block.kind === "bash_execution") {
      return reduceTerminalOutput(context);
    }
    if (looksLikeSearchOutput(context)) return reduceSearchOutput(context);
    const parsed = parseStructuredJson(block.exactText);
    if (parsed !== undefined) return reduceStructuredJson(context, parsed) ?? reduceGenericText(context);
    return reduceGenericText(context);
  }
  if (block.kind === "custom_message" || block.kind === "user") return reduceAssistantProse(context);
  return reduceGenericText(context);
}

export type { ReducerContext, ReducerResult } from "./types.js";
