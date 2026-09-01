import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SemanticCompressor, SemanticCompressionRequest, SemanticCompressionResponse } from "./types.js";
import { getRecord, getString } from "./utils.js";

export interface PiSemanticCompressorOptions {
  readonly model: string;
  readonly maxCalls?: number;
}

function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`Semantic model must use provider/model syntax; received ${spec}`);
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

export function createPiSemanticCompressor(
  ctx: ExtensionContext,
  options: PiSemanticCompressorOptions,
): SemanticCompressor {
  const modelSpec = parseModelSpec(options.model);
  const model = ctx.modelRegistry.find(modelSpec.provider, modelSpec.modelId);
  if (!model) throw new Error(`Semantic compression model not found: ${options.model}`);
  const maxCalls = Math.max(1, Math.floor(options.maxCalls ?? 24));
  let calls = 0;
  let authPromise: ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders> | undefined;

  return {
    async compress(request: SemanticCompressionRequest, signal?: AbortSignal): Promise<SemanticCompressionResponse | undefined> {
      if (calls >= maxCalls) return undefined;
      calls += 1;
      authPromise ??= ctx.modelRegistry.getApiKeyAndHeaders(model);
      const auth = await authPromise;
      if (!auth.ok || !auth.apiKey) return undefined;

      const [{ complete }, { uuidv7 }] = await Promise.all([
        import("@earendil-works/pi-ai/compat"),
        import("@earendil-works/pi-ai"),
      ]);
      const required = request.requiredIdentifiers.slice(0, 40);
      const roleInstruction =
        request.block.kind === "assistant_reasoning"
          ? "Preserve hypotheses considered, conclusion reached, why the next action/tool was selected, and unresolved uncertainty."
          : "Preserve decisions, factual claims, results, constraints, and the text's role in the chronological sequence.";
      const prompt = [
        `Compress this single historical ${request.block.label.toLowerCase()} block to at most ${request.maxTokens} tokens.`,
        roleInstruction,
        "Do not add facts, filenames, commands, identifiers, errors, outcomes, or quotations that do not occur in the source.",
        "Do not rewrite an early incorrect hypothesis as though it was known to be correct at the time.",
        required.length > 0 ? `Preserve these exact identifiers when material: ${required.join(", ")}` : "",
        "Return only the compressed block text.",
        "",
        "<source>",
        request.sourceText,
        "</source>",
      ]
        .filter(Boolean)
        .join("\n");
      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: Math.max(96, request.maxTokens * 2),
          signal,
          cacheRetention: "none",
          sessionId: uuidv7(),
        },
      );
      const text = response.content
        .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
        .join("\n")
        .trim();
      if (!text) return undefined;
      const modelRecord = getRecord(model);
      const resolvedModel = [getString(modelRecord?.provider), getString(modelRecord?.id)].filter(Boolean).join("/");
      return { text, model: resolvedModel || options.model, usage: response.usage };
    },
  };
}
