export interface ChronoReducerResult {
  readonly text: string;
  readonly reducer: string;
  readonly lossy: boolean;
  readonly omissions: readonly { readonly description: string }[];
}

export interface ChronoCompressionResult {
  readonly summary: string;
  readonly rawTokens: number;
  readonly renderedTokens: number;
  readonly targetTokens: number;
  readonly validation: { readonly ok: boolean };
}

export interface ChronoCompactApi {
  reduceBlock(context: {
    block: Record<string, unknown>;
    maxTokens: number;
    laterText: string;
  }): ChronoReducerResult;
  compactEntries(
    entries: readonly Record<string, unknown>[],
    options: {
      config: {
        targetTokens: number;
        enableSemanticCompression: false;
        includeHeader: false;
      };
      hardOutputTokens: number;
    },
  ): Promise<ChronoCompressionResult>;
}

let loading: Promise<ChronoCompactApi | undefined> | undefined;

function validApi(value: unknown): value is ChronoCompactApi {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).reduceBlock === "function" &&
    typeof (value as Record<string, unknown>).compactEntries === "function"
  );
}

/** Load the bundled deterministic ChronoCompact runtime without loading Pi peers. */
export async function loadChronoCompact(): Promise<
  ChronoCompactApi | undefined
> {
  loading ??= (async () => {
    try {
      const specifier = "pi-chrono-compact/deterministic";
      const loaded: unknown = await import(specifier);
      return validApi(loaded) ? loaded : undefined;
    } catch {
      return undefined;
    }
  })();
  return await loading;
}
