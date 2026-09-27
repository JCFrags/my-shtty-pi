import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CATEGORIES, HARD_LIMITS, PROVIDER_IDS } from "@context-kit/protocol";
import {
  collectContext, contextLimits, contextToolResult, parseContextQuery,
  type ContextCollection, type ContextLimits,
} from "@context-kit/protocol/collect";

const enumString = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] });
export const RecallParams = Type.Object({
  query: Type.Optional(Type.String({ maxLength: HARD_LIMITS.queryBytes, description: "Up to 16 case-insensitive query terms in bounded current-state fields. Matches any term and ranks results, not literal phrases. Empty means browse." })),
  providers: Type.Optional(Type.Array(enumString(PROVIDER_IDS), { minItems: 1, maxItems: PROVIDER_IDS.length, uniqueItems: true })),
  categories: Type.Optional(Type.Array(enumString(CATEGORIES), { maxItems: CATEGORIES.length, uniqueItems: true, description: "Memory proposals require the explicit proposal category. Default Memory recall returns accepted knowledge." })),
  records: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_LIMITS.records, description: "Maximum cards per provider, default 6." })),
  scan: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_LIMITS.scan, description: "Maximum native records examined per provider, default 128." })),
  providerBytes: Type.Optional(Type.Integer({ minimum: 2048, maximum: HARD_LIMITS.bytes, description: "Complete provider reply budget, default 8192 bytes." })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 4096, maximum: HARD_LIMITS.outputBytes, description: "Complete serialized tool-result budget, default 16384 bytes." })),
  waitMs: Type.Optional(Type.Integer({ minimum: 10, maximum: HARD_LIMITS.waitMs, description: "Common provider response deadline, default 150 ms." })),
}, { additionalProperties: false });
export type RecallInput = Static<typeof RecallParams>;
export type RecallOptions = Partial<ContextLimits>;
export type RecallResult = ContextCollection;

/** Pi adapter for the shared read-only collector. */
export function createRecallTool(
  pi: Pick<ExtensionAPI, "events" | "getActiveTools">,
  options: RecallOptions = {},
  epoch: () => number = () => 0,
) {
  const defaults = contextLimits(options);
  return {
    name: "context_recall",
    label: "Context Recall",
    description: "Find bounded current-state cards from active Memory, Todo, Notes, and Workplan tools. One query page, not historical recall. Memory is logical-session knowledge; other state is branch-local. Proposals require an explicit category. Returns lifecycle, coverage, exclusions, and read-only native recovery. Defaults: 6 cards and 128 scanned records per provider, 150 ms wait, 16 KiB complete result. Never activates tools, scans archives, or changes context.",
    parameters: RecallParams,
    async execute(_toolCallId: string, raw: RecallInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const input = parseContextQuery(raw);
      return contextToolResult(await collectContext(pi, { ...defaults, ...input }, {
        getScope: () => ({ sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() ?? null }),
        epoch, signal,
      }));
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
