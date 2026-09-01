import type {
  HistoricalBlock,
  ImageContent,
  MessageContentBlock,
  SessionEntryLike,
  SourceRef,
  TextContent,
  ToolCallContent,
} from "./types.js";
import {
  directInstructionText,
  estimateTokensFromText,
  extractIdentifiers,
  getArray,
  getBoolean,
  getNumber,
  getRecord,
  getString,
  hasRestrictionLanguage,
  hasUnresolvedLanguage,
  stableStringify,
} from "./utils.js";

interface MutableBlock {
  id: string;
  entryId: string;
  entryIndex: number;
  blockIndex?: number;
  kind: HistoricalBlock["kind"];
  label: string;
  exactText: string;
  rawTokens: number;
  sourceRefs: SourceRef[];
  timestamp?: string;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: Readonly<Record<string, unknown>>;
  isError?: boolean;
  protectedExact: boolean;
  reproducible: boolean;
  unresolved: boolean;
  exactIdentifiers: string[];
  attributes: Record<string, unknown>;
}

export interface ParseBlocksOptions {
  readonly includeHistoricalCompactions?: boolean;
  readonly includeMetadata?: boolean;
}

function imageMarker(content: ImageContent): string {
  return `[IMAGE mimeType=${content.mimeType} base64Chars=${content.data.length}; exact bytes remain in JSONL]`;
}

function contentContainsImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((item) => getRecord(item)?.type === "image");
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stableStringify(content, 2);
  const rendered: string[] = [];
  for (const rawBlock of content) {
    const block = getRecord(rawBlock);
    if (!block) {
      rendered.push(stableStringify(rawBlock));
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") rendered.push(block.text);
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      rendered.push(imageMarker(block as unknown as ImageContent));
    } else rendered.push(stableStringify(block, 2));
  }
  return rendered.join("\n");
}

function makeBlock(
  entry: SessionEntryLike,
  entryIndex: number,
  kind: HistoricalBlock["kind"],
  label: string,
  exactText: string,
  options: {
    blockIndex?: number;
    toolCallId?: string;
    toolName?: string;
    toolArguments?: Readonly<Record<string, unknown>>;
    isError?: boolean;
    protectedExact?: boolean;
    reproducible?: boolean;
    attributes?: Record<string, unknown>;
  } = {},
): MutableBlock {
  const entryId = entry.id as string;
  const sourceRef: SourceRef = options.blockIndex === undefined ? { entryId } : { entryId, blockIndex: options.blockIndex };
  const base: MutableBlock = {
    id: `${entryId}:${kind}:${options.blockIndex ?? 0}`,
    entryId,
    entryIndex,
    kind,
    label,
    exactText,
    rawTokens: estimateTokensFromText(exactText),
    sourceRefs: [sourceRef],
    protectedExact: options.protectedExact ?? false,
    reproducible: options.reproducible ?? false,
    unresolved: hasUnresolvedLanguage(exactText),
    exactIdentifiers: extractIdentifiers(exactText),
    attributes: options.attributes ?? {},
  };
  if (options.blockIndex !== undefined) base.blockIndex = options.blockIndex;
  if (typeof entry.timestamp === "string") base.timestamp = entry.timestamp;
  if (options.toolCallId !== undefined) base.toolCallId = options.toolCallId;
  if (options.toolName !== undefined) base.toolName = options.toolName;
  if (options.toolArguments !== undefined) base.toolArguments = options.toolArguments;
  if (options.isError !== undefined) base.isError = options.isError;
  return base;
}

function isToolCallBlock(value: unknown): value is ToolCallContent {
  const block = getRecord(value);
  return (
    block?.type === "toolCall" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    getRecord(block.arguments) !== undefined
  );
}

function parseMessageEntry(entry: SessionEntryLike, entryIndex: number): MutableBlock[] {
  const message = getRecord(entry.message);
  if (!message || typeof message.role !== "string") {
    return [makeBlock(entry, entryIndex, "metadata", "MALFORMED MESSAGE", stableStringify(entry, 2))];
  }

  switch (message.role) {
    case "user": {
      const text = renderContent(message.content);
      return [
        makeBlock(entry, entryIndex, "user", "USER", text, {
          protectedExact: hasRestrictionLanguage(directInstructionText(text)),
          attributes: { role: "user", containsImage: contentContainsImage(message.content) },
        }),
      ];
    }
    case "assistant": {
      const content = getArray(message.content) ?? [];
      const toolCallIndexes = content.flatMap((block, index) => (isToolCallBlock(block) ? [index] : []));
      const firstToolCallIndex = toolCallIndexes[0] ?? Number.POSITIVE_INFINITY;
      const lastToolCallIndex = toolCallIndexes[toolCallIndexes.length - 1] ?? Number.NEGATIVE_INFINITY;
      const blocks: MutableBlock[] = [];
      content.forEach((rawBlock, blockIndex) => {
        const block = getRecord(rawBlock);
        if (!block || typeof block.type !== "string") {
          blocks.push(
            makeBlock(entry, entryIndex, "assistant_text", "ASSISTANT TEXT", stableStringify(rawBlock, 2), {
              blockIndex,
              attributes: { phase: "unknown" },
            }),
          );
          return;
        }
        if (block.type === "thinking" && typeof block.thinking === "string") {
          blocks.push(
            makeBlock(entry, entryIndex, "assistant_reasoning", "ASSISTANT REASONING", block.thinking, {
              blockIndex,
              attributes: { providerBlock: stableStringify(block) },
            }),
          );
          return;
        }
        if (block.type === "text" && typeof block.text === "string") {
          const phase =
            toolCallIndexes.length === 0
              ? "final"
              : blockIndex < firstToolCallIndex
                ? "preamble"
                : blockIndex > lastToolCallIndex
                  ? "post_tool_text"
                  : "interstitial";
          blocks.push(
            makeBlock(entry, entryIndex, "assistant_text", "ASSISTANT TEXT", block.text, {
              blockIndex,
              attributes: { phase, stopReason: message.stopReason },
            }),
          );
          return;
        }
        if (isToolCallBlock(block)) {
          const args = block.arguments;
          blocks.push(
            makeBlock(entry, entryIndex, "tool_call", "TOOL CALL", `${block.name}(${stableStringify(args)})`, {
              blockIndex,
              toolCallId: block.id,
              toolName: block.name,
              toolArguments: args,
              reproducible: isReproducibleTool(block.name),
              attributes: { stopReason: message.stopReason },
            }),
          );
          return;
        }
        if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
          blocks.push(
            makeBlock(entry, entryIndex, "assistant_text", "ASSISTANT IMAGE", imageMarker(block as unknown as ImageContent), {
              blockIndex,
              attributes: { image: true, containsImage: true },
            }),
          );
          return;
        }
        blocks.push(
          makeBlock(entry, entryIndex, "assistant_text", "ASSISTANT CONTENT", stableStringify(block, 2), {
            blockIndex,
            attributes: { providerBlockType: block.type },
          }),
        );
      });
      return blocks;
    }
    case "toolResult": {
      const text = renderContent(message.content);
      const toolName = getString(message.toolName) ?? "unknown";
      const isError = getBoolean(message.isError);
      return [
        makeBlock(entry, entryIndex, "tool_result", "TOOL RESULT", text, {
          toolCallId: getString(message.toolCallId),
          toolName,
          isError,
          reproducible: isReproducibleTool(toolName),
          attributes: {
            details: message.details,
            usage: message.usage,
            containsImage: contentContainsImage(message.content),
          },
        }),
      ];
    }
    case "bashExecution": {
      const command = getString(message.command) ?? "";
      const output = getString(message.output) ?? "";
      const exitCode = getNumber(message.exitCode);
      const exactText = `Command: ${command}\nExit code: ${exitCode ?? "unknown"}\nCancelled: ${String(
        getBoolean(message.cancelled) ?? false,
      )}\nTruncated by original execution: ${String(getBoolean(message.truncated) ?? false)}\n\n${output}`;
      return [
        makeBlock(entry, entryIndex, "bash_execution", "BASH EXECUTION", exactText, {
          toolName: "bash",
          isError: exitCode !== undefined ? exitCode !== 0 : undefined,
          reproducible: true,
          attributes: {
            command,
            exitCode,
            cancelled: getBoolean(message.cancelled),
            truncated: getBoolean(message.truncated),
            fullOutputPath: getString(message.fullOutputPath),
          },
        }),
      ];
    }
    case "custom": {
      const text = renderContent(message.content);
      return [
        makeBlock(entry, entryIndex, "custom_message", `CUSTOM MESSAGE ${getString(message.customType) ?? ""}`.trim(), text, {
          protectedExact: hasRestrictionLanguage(directInstructionText(text)),
          attributes: { customType: message.customType, display: message.display, details: message.details, containsImage: contentContainsImage(message.content) },
        }),
      ];
    }
    case "branchSummary": {
      const summary = getString(message.summary) ?? "";
      return [
        makeBlock(entry, entryIndex, "branch_summary", "BRANCH SUMMARY", summary, {
          attributes: { fromId: message.fromId },
        }),
      ];
    }
    case "compactionSummary": {
      const summary = getString(message.summary) ?? "";
      return [
        makeBlock(entry, entryIndex, "historical_compaction", "PRIOR COMPACTION SUMMARY", summary, {
          attributes: { tokensBefore: message.tokensBefore },
        }),
      ];
    }
    default:
      return [makeBlock(entry, entryIndex, "metadata", `MESSAGE ${message.role.toUpperCase()}`, stableStringify(message, 2))];
  }
}

function isReproducibleTool(toolName: string): boolean {
  return /^(?:bash|read|grep|find|ls|git|search|rg|cat|head|tail)$/i.test(toolName);
}

export function parseHistoricalBlocks(
  entries: readonly SessionEntryLike[],
  options: ParseBlocksOptions = {},
): HistoricalBlock[] {
  const blocks: MutableBlock[] = [];
  entries.forEach((entry, entryIndex) => {
    if (typeof entry.id !== "string") return;
    switch (entry.type) {
      case "message":
        blocks.push(...parseMessageEntry(entry, entryIndex));
        break;
      case "custom_message": {
        if (["chrono-compact-context-warning", "chrono-compact-resume"].includes(getString(entry.customType) ?? "")) break;
        const text = renderContent(entry.content);
        blocks.push(
          makeBlock(entry, entryIndex, "custom_message", `CUSTOM MESSAGE ${getString(entry.customType) ?? ""}`.trim(), text, {
            protectedExact: hasRestrictionLanguage(directInstructionText(text)),
            attributes: { customType: entry.customType, display: entry.display, details: entry.details, containsImage: contentContainsImage(entry.content) },
          }),
        );
        break;
      }
      case "branch_summary": {
        blocks.push(
          makeBlock(entry, entryIndex, "branch_summary", "BRANCH SUMMARY", getString(entry.summary) ?? "", {
            attributes: { fromId: entry.fromId },
          }),
        );
        break;
      }
      case "compaction": {
        if (options.includeHistoricalCompactions) {
          blocks.push(
            makeBlock(entry, entryIndex, "historical_compaction", "PRIOR COMPACTION CONTROL ENTRY", getString(entry.summary) ?? "", {
              attributes: {
                tokensBefore: entry.tokensBefore,
                firstKeptEntryId: entry.firstKeptEntryId,
                details: entry.details,
              },
            }),
          );
        }
        break;
      }
      case "model_change": {
        if (options.includeMetadata) {
          blocks.push(
            makeBlock(
              entry,
              entryIndex,
              "model_change",
              "MODEL CHANGE",
              `${getString(entry.provider) ?? "unknown"}/${getString(entry.modelId) ?? "unknown"}`,
            ),
          );
        }
        break;
      }
      case "thinking_level_change": {
        if (options.includeMetadata) {
          blocks.push(
            makeBlock(
              entry,
              entryIndex,
              "thinking_level_change",
              "THINKING LEVEL CHANGE",
              getString(entry.thinkingLevel) ?? "unknown",
            ),
          );
        }
        break;
      }
      default:
        if (options.includeMetadata && !["custom", "label", "session_info"].includes(entry.type)) {
          blocks.push(makeBlock(entry, entryIndex, "metadata", entry.type.toUpperCase(), stableStringify(entry, 2)));
        }
        break;
    }
  });

  const callsById = new Map<string, MutableBlock>();
  for (const block of blocks) if (block.kind === "tool_call" && block.toolCallId) callsById.set(block.toolCallId, block);
  for (const block of blocks) {
    if (block.kind !== "tool_result" || !block.toolCallId) continue;
    const call = callsById.get(block.toolCallId);
    if (!call) continue;
    block.attributes = {
      ...block.attributes,
      pairedCallEntryId: call.entryId,
      pairedCallBlockIndex: call.blockIndex,
      pairedArguments: call.toolArguments,
      pairedCallText: call.exactText,
    };
    block.toolArguments = call.toolArguments;
    if (!block.toolName || block.toolName === "unknown") block.toolName = call.toolName;
    call.attributes = {
      ...call.attributes,
      pairedResultEntryId: block.entryId,
      pairedResultBlockIndex: block.blockIndex,
      pairedResultIsError: block.isError,
    };
  }

  return blocks.map((block) => Object.freeze({ ...block, sourceRefs: Object.freeze([...block.sourceRefs]) }));
}

export function messageContentBlocks(entry: SessionEntryLike): MessageContentBlock[] {
  const message = getRecord(entry.message);
  const content = getArray(message?.content);
  return (content ?? []) as MessageContentBlock[];
}

export function exactBlockContent(entry: SessionEntryLike, blockIndex: number): string | undefined {
  if (entry.type === "message") {
    const message = getRecord(entry.message);
    const content = message?.content;
    if (typeof content === "string") return blockIndex === 0 ? content : undefined;
    const blocks = getArray(content);
    const block = blocks?.[blockIndex];
    const record = getRecord(block);
    if (!record) return block === undefined ? undefined : stableStringify(block, 2);
    if (record.type === "text" && typeof record.text === "string") return record.text;
    if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
    if (record.type === "toolCall") return stableStringify(record, 2);
    if (record.type === "image") return stableStringify(record, 2);
    return stableStringify(record, 2);
  }
  if (entry.type === "custom_message") {
    const content = entry.content;
    if (typeof content === "string") return blockIndex === 0 ? content : undefined;
    const blocks = getArray(content);
    const block = blocks?.[blockIndex];
    return block === undefined ? undefined : stableStringify(block, 2);
  }
  return blockIndex === 0 ? stableStringify(entry, 2) : undefined;
}

export function textContentOnly(content: unknown): TextContent[] {
  return (getArray(content) ?? []).filter(
    (block): block is TextContent => getRecord(block)?.type === "text" && typeof getRecord(block)?.text === "string",
  );
}
