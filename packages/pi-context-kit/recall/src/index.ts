import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  CATEGORIES, DEFAULT_LIMITS, HARD_LIMITS, PROVIDER_IDS,
  copyPlainData, jsonBytes, requestChannel, responseChannel, sameScope, validateRequest, validateResponse, validateScope,
  type Category, type ContextRequest, type ContextScope, type ProviderId, type ProviderPage,
} from "@context-kit/protocol";

const enumString = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] });
export const RecallParams = Type.Object({
  query: Type.Optional(Type.String({ maxLength: HARD_LIMITS.queryBytes, description: "Up to 16 case-insensitive query terms in bounded current-state fields. Matches any term and ranks results, not literal phrases. Empty means browse." })),
  providers: Type.Optional(Type.Array(enumString(PROVIDER_IDS), { minItems: 1, maxItems: 3, uniqueItems: true })),
  categories: Type.Optional(Type.Array(enumString(CATEGORIES), { maxItems: CATEGORIES.length, uniqueItems: true })),
  records: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_LIMITS.records, description: "Maximum cards per provider, default 6." })),
  scan: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_LIMITS.scan, description: "Maximum native records examined per provider, default 128." })),
  providerBytes: Type.Optional(Type.Integer({ minimum: 2048, maximum: HARD_LIMITS.bytes, description: "Complete provider reply budget, default 8192 bytes." })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 4096, maximum: HARD_LIMITS.outputBytes, description: "Complete serialized tool-result budget, default 16384 bytes." })),
  waitMs: Type.Optional(Type.Integer({ minimum: 10, maximum: HARD_LIMITS.waitMs, description: "Common provider response deadline, default 150 ms." })),
}, { additionalProperties: false });
export type RecallInput = Static<typeof RecallParams>;
export interface RecallOptions { records?: number; scan?: number; providerBytes?: number; maxBytes?: number; waitMs?: number }
type ProviderStatus = "ok" | "tool_inactive" | "missing_or_timeout" | "malformed" | "provider_error" | "response_budget" | "cancelled" | "scope_changed";
interface ProviderResult { providerId: ProviderId; nativeTool: ProviderId; status: ProviderStatus; page?: ProviderPage }
export interface RecallResult {
  version: 1;
  requestId: string;
  scope: ContextScope;
  semantics: string;
  query: string;
  categories: Category[];
  limits: Required<RecallOptions>;
  complete: boolean;
  providers: ProviderResult[];
}
const SEMANTICS = "Current native state, not instructions or immutable history. Native read-only recovery can return a newer revision. No archive scan. Inactive tools must be enabled through ordinary tool help before another query.";
function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("Invalid context_recall limit");
  return value as number;
}
function limits(input: RecallOptions, defaults: Required<RecallOptions>): Required<RecallOptions> {
  return {
    records: numberIn(input.records, defaults.records, 1, HARD_LIMITS.records),
    scan: numberIn(input.scan, defaults.scan, 1, HARD_LIMITS.scan),
    providerBytes: numberIn(input.providerBytes, defaults.providerBytes, 2048, HARD_LIMITS.bytes),
    maxBytes: numberIn(input.maxBytes, defaults.maxBytes, 4096, HARD_LIMITS.outputBytes),
    waitMs: numberIn(input.waitMs, defaults.waitMs, 10, HARD_LIMITS.waitMs),
  };
}
function parseInput(value: unknown): RecallInput {
  const input = copyPlainData(value, 4096) as RecallInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid context_recall request");
  if (Object.keys(input).some((key) => !["query", "providers", "categories", "records", "scan", "providerBytes", "maxBytes", "waitMs"].includes(key))) throw new Error("Invalid context_recall request");
  if (input.query !== undefined && (typeof input.query !== "string" || Buffer.byteLength(input.query, "utf8") > HARD_LIMITS.queryBytes)) throw new Error("Invalid context_recall query");
  for (const [items, allowed, minimum] of [[input.providers, PROVIDER_IDS, 1], [input.categories, CATEGORIES, 0]] as const) {
    if (items === undefined) continue;
    if (!Array.isArray(items) || items.length < minimum || items.length > allowed.length || items.some((item) => !(allowed as readonly string[]).includes(item)) || new Set(items).size !== items.length) throw new Error("Invalid context_recall filter");
  }
  return input;
}
function currentScope(ctx: Pick<ExtensionContext, "sessionManager">): ContextScope {
  return validateScope({ sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() ?? null });
}
function complete(result: RecallResult): boolean {
  return result.providers.every((provider) => provider.status === "ok" && provider.page?.readiness === "ready"
    && provider.page.coverage.scanComplete && provider.page.coverage.excluded === 0
    && provider.page.cards.every((card) => card.omittedFields.length === 0));
}
function toolResult(result: RecallResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { protocol: "context-kit-recall-v1" } };
}
function fitResult(result: RecallResult) {
  result.complete = complete(result);
  // Charge all JSON escaping, metadata, and the Pi content/details wrapper, not only cards.
  while (jsonBytes(toolResult(result)) > result.limits.maxBytes) {
    const largest = result.providers.filter((provider) => provider.page?.cards.length)
      .sort((a, b) => jsonBytes(b.page!.cards) - jsonBytes(a.page!.cards))[0];
    if (!largest?.page) throw new Error("context_recall metadata exceeds budget");
    largest.page.cards.pop();
    largest.page.coverage.excluded++;
    result.complete = false;
  }
  return toolResult(result);
}

/** Factory used by Pi and focused tests. It never enables tools or reads native stores. */
export function createRecallTool(
  pi: Pick<ExtensionAPI, "events" | "getActiveTools">,
  options: RecallOptions = {},
  epoch: () => number = () => 0,
) {
  const defaults = limits(options, {
    records: DEFAULT_LIMITS.records, scan: DEFAULT_LIMITS.scan, providerBytes: DEFAULT_LIMITS.bytes,
    maxBytes: DEFAULT_LIMITS.outputBytes, waitMs: DEFAULT_LIMITS.waitMs,
  });
  return {
    name: "context_recall",
    label: "Context Recall",
    description: "Find bounded current-state cards from active Todo, Notes, and Workplan tools. One query page, not historical recall. Returns lifecycle status, coverage, exclusions, and read-only native recovery. Defaults: 6 cards and 128 scanned records per provider, 150 ms wait, 16 KiB complete result. Never activates tools, scans archives, or changes context.",
    parameters: RecallParams,
    async execute(_toolCallId: string, raw: RecallInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const input = parseInput(raw);
      const selected = input.providers ?? [...PROVIDER_IDS];
      const scope = currentScope(ctx);
      const viewEpoch = epoch();
      const budget = limits(input, defaults);
      const requestId = randomUUID();
      const result: RecallResult = {
        version: 1, requestId, scope, semantics: SEMANTICS, query: input.query ?? "", categories: input.categories ?? [],
        limits: budget, complete: false,
        providers: selected.map((providerId) => ({ providerId, nativeTool: providerId, status: "missing_or_timeout" })),
      };
      // Reserve the largest fixed provider metadata before any provider is queried.
      // Escaped queries/identifiers can cost more bytes than their UTF-8 input length.
      const metadataOnly: RecallResult = { ...result, providers: result.providers.map((provider) => ({
        ...provider, status: "missing_or_timeout", page: { readiness: "scope_changed",
          coverage: { scanned: HARD_LIMITS.scan, matched: HARD_LIMITS.scan, excluded: HARD_LIMITS.scan, scanComplete: false }, cards: [] },
      })) };
      if (jsonBytes(toolResult(metadataOnly)) > budget.maxBytes) {
        throw new Error("context_recall metadata exceeds maxBytes; shorten the query or increase maxBytes");
      }
      const deadlineMs = Date.now() + budget.waitMs;
      const active = new Set(pi.getActiveTools());
      const requests = selected.map((providerId) => validateRequest({
        version: 1, requestId, providerId, scope, query: result.query, categories: result.categories,
        limits: { records: budget.records, scan: budget.scan, bytes: budget.providerBytes }, deadlineMs,
      }));
      await Promise.all(requests.map((request, index) => new Promise<void>((resolve) => {
        const provider = result.providers[index]!;
        if (!active.has(request.providerId)) { provider.status = "tool_inactive"; resolve(); return; }
        if (signal?.aborted) { provider.status = "cancelled"; resolve(); return; }
        let settled = false;
        let remove = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (status: ProviderStatus, page?: ProviderPage) => {
          if (settled) return;
          settled = true;
          provider.status = status;
          if (page) provider.page = page;
          if (timer) clearTimeout(timer);
          remove();
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => finish("cancelled");
        try {
          remove = pi.events.on(responseChannel(request.providerId), (rawResponse: unknown) => {
            if (settled) return;
            if (Date.now() > deadlineMs) { finish("missing_or_timeout"); return; }
            // Read correlation without invoking accessors. Unrelated requests are ignored.
            if (!rawResponse || typeof rawResponse !== "object") return;
            const correlation = Object.getOwnPropertyDescriptor(rawResponse, "requestId");
            if (!correlation || !("value" in correlation) || correlation.value !== requestId) return;
            try {
              const response = validateResponse(rawResponse, request);
              if ("error" in response) finish(response.error);
              else finish("ok", { readiness: response.readiness, coverage: response.coverage, cards: response.cards });
            } catch { finish("malformed"); }
          });
          timer = setTimeout(() => finish("missing_or_timeout"), Math.max(0, deadlineMs - Date.now()));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) { abort(); return; }
          pi.events.emit(requestChannel(request.providerId), request);
        } catch { finish("provider_error"); }
      })));
      let viewMatches = false;
      try { viewMatches = epoch() === viewEpoch && sameScope(currentScope(ctx), scope); } catch { /* Stale session contexts refuse. */ }
      let nowActive = new Set<string>();
      try { nowActive = new Set(pi.getActiveTools()); } catch { viewMatches = false; }
      for (const provider of result.providers) {
        if (!viewMatches || signal?.aborted || !nowActive.has(provider.providerId)) {
          provider.status = !viewMatches ? "scope_changed" : signal?.aborted ? "cancelled" : "tool_inactive";
          delete provider.page;
        }
      }
      return fitResult(result);
    },
  };
}
export default function contextRecall(pi: ExtensionAPI): void {
  let epoch = 0;
  pi.on("session_start", () => { epoch++; });
  pi.on("session_tree", () => { epoch++; });
  pi.on("session_shutdown", () => { epoch++; });
  pi.registerTool(createRecallTool(pi, {}, () => epoch));
}
