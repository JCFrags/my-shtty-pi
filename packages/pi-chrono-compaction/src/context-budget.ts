import { createHash } from "node:crypto";
import { convertToLlm, estimateTokens, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionEntryLike } from "./types.js";

/** Token policy only. Native memory, source I/O, row and deadline limits are independent. */
export const MAX_CONTEXT_TOKENS = 250_000;
export const DEFAULT_CONTEXT_TOKENS = 32_000;
export const DEFAULT_RESPONSE_RESERVE_TOKENS = 16_384;

export function validateContextCeiling(tokens: number): void {
  if (!Number.isSafeInteger(tokens) || tokens < 512 || tokens > MAX_CONTEXT_TOKENS) {
    throw new Error(`Context ceiling must be an integer from 512 to ${MAX_CONTEXT_TOKENS} tokens.`);
  }
}

/** Re-evaluate for the selected model on every operation, including after a model switch. */
export function resolveContextCeiling(
  configuredTokens: number,
  contextWindow: number,
  overheadTokens = 0,
  responseReserveTokens = DEFAULT_RESPONSE_RESERVE_TOKENS,
): number {
  validateContextCeiling(configuredTokens);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1
    || !Number.isSafeInteger(overheadTokens) || overheadTokens < 0
    || !Number.isSafeInteger(responseReserveTokens) || responseReserveTokens < 0) {
    throw new Error("Selected model context capacity or reserved token budget is unavailable.");
  }
  const ceiling = Math.min(configuredTokens, contextWindow - overheadTokens - responseReserveTokens);
  validateContextCeiling(ceiling);
  return ceiling;
}

export const CONTEXT_ESTIMATOR = "pi-message-estimator-and-utf16-ceil-div4-v1" as const;
export interface ContextBudget {
  readonly model: { readonly provider: string; readonly id: string; readonly api: string; readonly contextWindow: number; readonly maxTokens: number; readonly thinkingLevel: string };
  readonly configuredTokens: number;
  readonly responseReserveTokens: number;
  readonly systemTokens: number;
  readonly systemHash: string;
  readonly tools: readonly { readonly name: string; readonly tokens: number; readonly hash: string }[];
  readonly toolSchemaTokens: number;
  readonly framingTokens: number;
  readonly effectiveCeilingTokens: number;
  readonly estimator: typeof CONTEXT_ESTIMATOR;
  readonly qualification: string;
}
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const textTokens = (text: string): number => Math.ceil(text.length / 4);

/** Capture public request inputs only. Source paths, credentials and tool execute
 * functions are neither retained nor hashed. Full active schema JSON is charged. */
export function captureContextBudget(input: {
  readonly model: ContextBudget["model"];
  readonly configuredTokens: number;
  readonly responseReserveTokens: number;
  readonly systemPrompt: string;
  readonly activeTools: readonly string[];
  readonly allTools: readonly { name: string; description: string; parameters: unknown }[];
  readonly framingTokens: number;
}): ContextBudget {
  if (!input.model.provider || !input.model.id || !input.model.api || !Number.isSafeInteger(input.model.maxTokens)
    || input.model.maxTokens < 0 || !Number.isSafeInteger(input.framingTokens) || input.framingTokens < 0) throw new Error("context-v4-budget-invalid");
  const tools = [...new Set(input.activeTools)].sort().map(name => {
    const tool = input.allTools.find(value => value.name === name);
    if (!tool || tool.parameters === undefined) throw new Error("context-v4-tool-schema-unavailable");
    const json = JSON.stringify({ name, description: tool.description, parameters: tool.parameters });
    return { name, tokens: textTokens(json), hash: sha(json) };
  });
  const systemTokens = textTokens(input.systemPrompt), toolSchemaTokens = tools.reduce((sum, tool) => sum + tool.tokens, 0);
  // A fixed transport allowance plus a per-schema allowance complements the
  // explicit schema and message estimates. It is not an exact tokenizer claim.
  const framingTokens = Math.max(512, input.framingTokens) + tools.length * 32;
  return { model: { ...input.model }, configuredTokens: input.configuredTokens,
    responseReserveTokens: input.responseReserveTokens, systemTokens, systemHash: sha(input.systemPrompt), tools,
    toolSchemaTokens, framingTokens,
    effectiveCeilingTokens: resolveContextCeiling(input.configuredTokens, input.model.contextWindow,
      systemTokens + toolSchemaTokens + framingTokens, input.responseReserveTokens),
    estimator: CONTEXT_ESTIMATOR,
    qualification: "Estimated public-hook request, not an exact model tokenizer or final provider payload. Includes Pi compaction conversion, complete raw-tail messages, system, active schemas, framing allowance and response reserve. Later context/payload extensions and provider serialization can change the request." };
}

/** Public conversion includes Pi's compaction prefix and <summary> wrapper. */
export function chargeCompactionSummary(summary: string): number {
  return convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }])
    .reduce((sum, message) => sum + estimateTokens(message), 0) + 32;
}

/** Match Pi's retained-tail reconstruction. Old compaction metadata is not a
 * second summary. No image or tool-result body is shortened. */
export function chargeRawTail(entries: readonly SessionEntryLike[]): { tokens: number; messages: number } {
  if (entries.length > 256) throw new Error("context-v4-tail-bound-exceeded");
  const converted = convertToLlm(entries.filter(entry => entry.type !== "compaction")
    .flatMap(entry => sessionEntryToContextMessages(entry as SessionEntry)));
  return { tokens: converted.reduce((sum, message) => sum + estimateTokens(message) + 32, 0), messages: converted.length };
}
