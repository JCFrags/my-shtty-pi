import { getSupportedThinkingLevels, type AssistantMessage, type Model, type Api, type ModelThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ValueWorkerSettings, ValueWorkerStatusCode } from "./value-worker-types.js";

export interface ResolvedValueModel { readonly status: "ready"; readonly model: Model<Api>; readonly identity: string; readonly thinking: ModelThinkingLevel; readonly costAvailable: boolean; }
export type ValueModelResolution = ResolvedValueModel | { readonly status: ValueWorkerStatusCode };
export async function resolveValueWorkerModel(ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">, settings: ValueWorkerSettings): Promise<ValueModelResolution> {
  let model: Model<Api> | undefined;
  if (settings.model === "main") model = ctx.model;
  else { const slash = settings.model.indexOf("/"); if (slash < 1) return { status: "model-not-found" }; model = ctx.modelRegistry.find(settings.model.slice(0, slash), settings.model.slice(slash + 1)); }
  if (!model) return { status: "model-not-found" };
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { status: "model-auth-unavailable" };
  const thinking: ModelThinkingLevel = settings.thinking === "inherit" ? (ctx.thinkingLevel ?? "off") : settings.thinking;
  if (!getSupportedThinkingLevels(model).includes(thinking)) return { status: "thinking-unsupported" };
  return { status: "ready", model, identity: `${model.provider}/${model.id}`, thinking, costAvailable: modelPricesAvailable(model) };
}

export interface ValueModelCall { call(model: Model<Api>, prompt: string, options: { maxTokens: number; thinking: ModelThinkingLevel; signal?: AbortSignal }): Promise<AssistantMessage>; }
export function createPiValueModelCall(ctx: Pick<ExtensionContext, "modelRegistry">): ValueModelCall {
  const registry = ctx.modelRegistry as unknown as { complete(model: Model<Api>, context: unknown, options: unknown): Promise<AssistantMessage> };
  return { call: (model, prompt, options) => registry.complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { maxTokens: Math.min(model.maxTokens, options.maxTokens), ...(options.thinking === "off" ? {} : { reasoning: options.thinking }), signal: options.signal, cacheRetention: "none" }) };
}
export function assistantText(response: AssistantMessage): string { return response.content.flatMap((x) => x.type === "text" ? [x.text] : []).join("\n").trim(); }

export function usdToMicroUsd(value: number): number | undefined { if (!Number.isFinite(value) || value < 0) return undefined; const result = Math.ceil(value * 1_000_000); return Number.isSafeInteger(result) ? result : undefined; }
export function modelPricesAvailable(model: Model<Api>): boolean { return [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every((x) => Number.isFinite(x) && x >= 0); }
/** Pi prices are USD per million tokens, which is numerically micro-USD per token. */
export function upperBoundCostMicroUsd(model: Model<Api>, inputTokens: number, outputTokens: number): number | undefined {
  if (!modelPricesAvailable(model)) return undefined;
  return Math.ceil(inputTokens * model.cost.input) + Math.ceil(outputTokens * model.cost.output);
}
export function actualCostMicroUsd(model: Model<Api>, usage: Usage): number | undefined {
  const provider = usdToMicroUsd(usage.cost.total);
  if (provider !== undefined && provider > 0) return provider;
  if (!modelPricesAvailable(model)) return undefined;
  return Math.ceil(usage.input * model.cost.input) + Math.ceil(usage.output * model.cost.output) + Math.ceil(usage.cacheRead * model.cost.cacheRead) + Math.ceil(usage.cacheWrite * model.cost.cacheWrite);
}

export type ProviderFailure = { readonly status: "cancelled" | "model-auth-unavailable" | "provider-timeout" | "provider-rate-limit" | "provider-temporary-failure" | "unknown-value-worker-failure"; readonly transient: boolean };
export function classifyProviderFailure(error: unknown, signal?: AbortSignal): ProviderFailure {
  if (signal?.aborted) return { status: "cancelled", transient: false };
  const values: unknown[] = []; let current = error;
  for (let i = 0; i < 4 && current && typeof current === "object"; i++) { const item = current as Record<string, unknown>; values.push(item.status, item.statusCode, item.code, item.type, item.name); current = item.cause; }
  const statuses = values.filter((x): x is number => Number.isInteger(x));
  const codes = new Set(values.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()));
  if (statuses.some((x) => [401, 403].includes(x)) || ["AUTHENTICATION_ERROR", "UNAUTHORIZED", "FORBIDDEN"].some((x) => codes.has(x))) return { status: "model-auth-unavailable", transient: false };
  if (statuses.some((x) => [408, 425].includes(x)) || ["ABORTERROR", "TIMEOUTERROR", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].some((x) => codes.has(x))) return { status: "provider-timeout", transient: true };
  if (statuses.includes(429) || codes.has("RATE_LIMIT") || codes.has("RATE_LIMITED")) return { status: "provider-rate-limit", transient: true };
  if (statuses.some((x) => [500, 502, 503, 504].includes(x)) || ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].some((x) => codes.has(x))) return { status: "provider-temporary-failure", transient: true };
  return { status: "unknown-value-worker-failure", transient: false };
}
