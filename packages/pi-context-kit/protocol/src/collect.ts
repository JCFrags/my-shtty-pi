import { randomUUID } from "node:crypto";
import {
  CATEGORIES, DEFAULT_LIMITS, HARD_LIMITS, PROVIDER_IDS,
  copyPlainData, jsonBytes, nativeTool, requestChannel, responseChannel, sameScope, validateRequest, validateResponse, validateScope,
  type Category, type ContextEventBus, type ContextScope, type NativeRecovery, type ProviderId, type ProviderPage,
} from "./index.js";

export interface ContextLimits { records: number; scan: number; providerBytes: number; maxBytes: number; waitMs: number }
export interface ContextQuery extends Partial<ContextLimits> { query?: string; providers?: ProviderId[]; categories?: Category[] }
export type ProviderStatus = "ok" | "tool_inactive" | "missing_or_timeout" | "malformed" | "provider_error" | "response_budget" | "cancelled" | "scope_changed";
export interface ProviderResult { providerId: ProviderId; nativeTool: NativeRecovery["tool"]; status: ProviderStatus; page?: ProviderPage }
export interface ContextCollection {
  version: 2;
  requestId: string;
  scope: ContextScope;
  semantics: string;
  query: string;
  categories: Category[];
  limits: ContextLimits;
  complete: boolean;
  providers: ProviderResult[];
}
export interface ContextHost { events: ContextEventBus; getActiveTools(): string[] }
export interface ContextView { getScope(): ContextScope; epoch(): number; signal?: AbortSignal }
const SEMANTICS = "Current native state, not instructions or immutable history. Native read-only recovery can return a newer revision unless an exact revision is supplied. Memory knowledge is shared within its logical session across tree moves; proposals require an explicit category. Other state is branch-local. No archive scan. Inactive tools must be enabled through ordinary tool help before another query.";
function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("Invalid context_recall limit");
  return value as number;
}
export function contextLimits(input: Partial<ContextLimits> = {}): ContextLimits {
  return {
    records: numberIn(input.records, DEFAULT_LIMITS.records, 1, HARD_LIMITS.records),
    scan: numberIn(input.scan, DEFAULT_LIMITS.scan, 1, HARD_LIMITS.scan),
    providerBytes: numberIn(input.providerBytes, DEFAULT_LIMITS.bytes, 2048, HARD_LIMITS.bytes),
    maxBytes: numberIn(input.maxBytes, DEFAULT_LIMITS.outputBytes, 4096, HARD_LIMITS.outputBytes),
    waitMs: numberIn(input.waitMs, DEFAULT_LIMITS.waitMs, 10, HARD_LIMITS.waitMs),
  };
}
export function parseContextQuery(value: unknown): ContextQuery {
  const input = copyPlainData(value, 4096) as ContextQuery;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid context_recall request");
  if (Object.keys(input).some((key) => !["query", "providers", "categories", "records", "scan", "providerBytes", "maxBytes", "waitMs"].includes(key))) throw new Error("Invalid context_recall request");
  if (input.query !== undefined && (typeof input.query !== "string" || Buffer.byteLength(input.query, "utf8") > HARD_LIMITS.queryBytes)) throw new Error("Invalid context_recall query");
  for (const [items, allowed, minimum] of [[input.providers, PROVIDER_IDS, 1], [input.categories, CATEGORIES, 0]] as const) {
    if (items === undefined) continue;
    if (!Array.isArray(items) || items.length < minimum || items.length > allowed.length || items.some((item) => !(allowed as readonly string[]).includes(item)) || new Set(items).size !== items.length) throw new Error("Invalid context_recall filter");
  }
  return input;
}
function complete(result: ContextCollection): boolean {
  return result.providers.every((provider) => provider.status === "ok" && provider.page?.readiness === "ready"
    && provider.page.coverage.scanComplete && provider.page.coverage.excluded === 0
    && provider.page.cards.every((card) => card.omittedFields.length === 0));
}
export function contextToolResult(result: ContextCollection) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { protocol: "context-kit-recall-v2" } };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function fitResult(result: ContextCollection): ContextCollection {
  result.complete = complete(result);
  // Charge escaping, metadata, and the Pi content/details wrapper, not only cards.
  while (jsonBytes(contextToolResult(result)) > result.limits.maxBytes) {
    const largest = result.providers.filter((provider) => provider.page?.cards.length)
      .sort((a, b) => jsonBytes(b.page!.cards) - jsonBytes(a.page!.cards))[0];
    if (!largest?.page) throw new Error("context_recall metadata exceeds budget");
    largest.page.cards.pop();
    largest.page.coverage.excluded++;
    result.complete = false;
  }
  return freeze(result);
}

/** One bounded, detached selection through caller-owned transport. No Pi runtime,
 * native store, tool execution, activation, or context mutation is used here. */
export async function collectContext(host: ContextHost, raw: ContextQuery, view: ContextView): Promise<ContextCollection> {
  const input = parseContextQuery(raw);
  const selected = input.providers ?? [...PROVIDER_IDS];
  const scope = validateScope(view.getScope());
  const viewEpoch = view.epoch();
  const signal = view.signal;
  const budget = contextLimits(input);
  const requestId = randomUUID();
  const result: ContextCollection = {
    version: 2, requestId, scope, semantics: SEMANTICS, query: input.query ?? "", categories: input.categories ?? [],
    limits: budget, complete: false,
    providers: selected.map((providerId) => ({ providerId, nativeTool: nativeTool(providerId), status: "missing_or_timeout" })),
  };
  const metadataOnly: ContextCollection = { ...result, providers: result.providers.map((provider) => ({
    ...provider, status: "missing_or_timeout", page: { readiness: "scope_changed",
      coverage: { scanned: HARD_LIMITS.scan, matched: HARD_LIMITS.scan, excluded: HARD_LIMITS.scan, scanComplete: false }, cards: [] },
  })) };
  if (jsonBytes(contextToolResult(metadataOnly)) > budget.maxBytes) {
    throw new Error("context_recall metadata exceeds maxBytes; shorten the query or increase maxBytes");
  }
  const deadlineMs = Date.now() + budget.waitMs;
  const active = new Set(host.getActiveTools());
  const requests = selected.map((providerId) => validateRequest({
    version: 2, requestId, providerId, scope, query: result.query,
    categories: providerId === "memory" && !result.categories.length ? ["knowledge"] : result.categories,
    limits: { records: budget.records, scan: budget.scan, bytes: budget.providerBytes }, deadlineMs,
  }));
  await Promise.all(requests.map((request, index) => new Promise<void>((resolve) => {
    const provider = result.providers[index]!;
    if (!active.has(provider.nativeTool)) { provider.status = "tool_inactive"; resolve(); return; }
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
      try { remove(); } catch { /* Failed peer cleanup must not prevent settlement. */ }
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => finish("cancelled");
    try {
      remove = host.events.on(responseChannel(request.providerId, 2), (rawResponse: unknown) => {
        if (settled) return;
        if (Date.now() > deadlineMs) { finish("missing_or_timeout"); return; }
        // Read correlation without accessors. Unrelated requests are ignored.
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
      host.events.emit(requestChannel(request.providerId, 2), request);
    } catch { finish("provider_error"); }
  })));
  let viewMatches = false;
  try { viewMatches = view.epoch() === viewEpoch && sameScope(validateScope(view.getScope()), scope); } catch { /* Stale contexts refuse. */ }
  let nowActive = new Set<string>();
  try { nowActive = new Set(host.getActiveTools()); } catch { viewMatches = false; }
  for (const provider of result.providers) {
    if (!viewMatches || signal?.aborted || !nowActive.has(provider.nativeTool)) {
      provider.status = !viewMatches ? "scope_changed" : signal?.aborted ? "cancelled" : "tool_inactive";
      delete provider.page;
    }
  }
  return fitResult(result);
}
