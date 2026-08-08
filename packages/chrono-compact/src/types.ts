export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  [key: string]: unknown;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  [key: string]: unknown;
}

export type MessageContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent | Record<string, unknown>;

export interface SessionHeaderLike {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface SessionEntryLike {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface SourceRecord {
  lineNumber: number;
  rawLine: string;
  data: SessionHeaderLike | SessionEntryLike;
}

export interface ParsedSession {
  readonly header: SessionHeaderLike;
  readonly records: readonly SourceRecord[];
  readonly entries: readonly SessionEntryLike[];
  readonly entryById: ReadonlyMap<string, SessionEntryLike>;
  readonly recordById: ReadonlyMap<string, SourceRecord>;
  readonly childrenByParent: ReadonlyMap<string | null, readonly string[]>;
  readonly inferredLeafId: string | null;
  readonly sessionPath?: string;
}

export type BlockKind =
  | "user"
  | "assistant_reasoning"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "bash_execution"
  | "branch_summary"
  | "custom_message"
  | "model_change"
  | "thinking_level_change"
  | "historical_compaction"
  | "metadata";

export interface SourceRef {
  entryId: string;
  blockIndex?: number;
}

export interface HistoricalBlock {
  readonly id: string;
  readonly entryId: string;
  readonly entryIndex: number;
  readonly blockIndex?: number;
  readonly kind: BlockKind;
  readonly label: string;
  readonly exactText: string;
  readonly rawTokens: number;
  readonly sourceRefs: readonly SourceRef[];
  readonly timestamp?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolArguments?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly protectedExact: boolean;
  readonly reproducible: boolean;
  readonly unresolved: boolean;
  readonly exactIdentifiers: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
}

export type RepresentationLevel = "raw" | "normalized" | "reduced" | "semantic" | "merged" | "marker" | "absent";

export interface OmissionNotice {
  readonly description: string;
  readonly omittedLines?: number;
  readonly omittedBytes?: number;
  readonly repeatedLines?: number;
}

export interface RepresentationCandidate {
  readonly id: string;
  readonly level: RepresentationLevel;
  readonly text: string;
  readonly tokens: number;
  readonly rawTokens: number;
  readonly utility: number;
  readonly lossy: boolean;
  readonly reducer?: string;
  readonly reducerVersion?: string;
  readonly omissions: readonly OmissionNotice[];
  readonly sourceRefs: readonly SourceRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CandidateUnit {
  readonly id: string;
  readonly kind: BlockKind | "episode";
  readonly label: string;
  readonly startEntryIndex: number;
  readonly endEntryIndex: number;
  readonly sourceRefs: readonly SourceRef[];
  readonly rawTokens: number;
  readonly importance: number;
  readonly importanceReasons: readonly string[];
  readonly resource?: {
    readonly kind: "file" | "command";
    readonly key: string;
    readonly occurrence: number;
    readonly occurrenceCount: number;
  };
  readonly protectedExact: boolean;
  readonly candidates: readonly RepresentationCandidate[];
  readonly toolCallIds: readonly string[];
}

export interface PlannedUnit extends CandidateUnit {
  readonly selected: RepresentationCandidate;
}

export interface CompressionPlan {
  readonly targetTokens: number;
  readonly estimatedTokens: number;
  readonly rawTokens: number;
  readonly units: readonly PlannedUnit[];
  readonly warnings: readonly string[];
}

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly unitId?: string;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface CompressionDetails {
  readonly schemaVersion: 2;
  readonly generationHash: string;
  readonly sourceEntryIds: readonly string[];
  readonly sourceRange?: { readonly start: string; readonly end: string };
  readonly rawTokens: number;
  readonly renderedTokens: number;
  readonly targetTokens: number;
  readonly reducerVersions: Readonly<Record<string, string>>;
  readonly plan: readonly {
    readonly unitId: string;
    readonly level: RepresentationLevel;
    readonly sourceRefs: readonly SourceRef[];
    readonly rawTokens: number;
    readonly renderedTokens: number;
    readonly importance: number;
    readonly importanceReasons: readonly string[];
  }[];
  readonly validation: ValidationReport;
  readonly v2?: {
    readonly resourceGenerationHash: string;
    readonly causalGenerationHash: string;
    readonly pinnedMemoryTokens: number;
    readonly retentionBands: Readonly<Record<"hot" | "warm" | "cold", number>>;
    readonly tokenTelemetry: Readonly<Record<string, unknown>>;
  };
  readonly historyEditor?: {
    readonly status: "disabled" | "skipped" | "applied" | "fallback";
    readonly calls: 0 | 1;
    readonly model?: string;
    readonly inputItems: number;
    readonly outputDecisions?: number;
    readonly rejectedDecisions?: number;
    readonly missingDecisions?: number;
    readonly changedItems?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reason?: string;
  };
}

export interface CompressionResult {
  readonly summary: string;
  readonly rawTokens: number;
  readonly renderedTokens: number;
  readonly targetTokens: number;
  readonly plan: CompressionPlan;
  readonly validation: ValidationReport;
  readonly details: CompressionDetails;
}

export interface SemanticCompressionRequest {
  readonly block: HistoricalBlock;
  readonly maxTokens: number;
  readonly sourceText: string;
  readonly requiredIdentifiers: readonly string[];
}

export interface SemanticCompressionResponse {
  readonly text: string;
  readonly model?: string;
  readonly usage?: unknown;
}

export interface SemanticCompressor {
  compress(request: SemanticCompressionRequest, signal?: AbortSignal): Promise<SemanticCompressionResponse | undefined>;
}

export interface CompactorConfig {
  readonly targetTokens: number;
  readonly minSummaryTokens: number;
  readonly maxSummaryTokens: number;
  readonly recentExactBiasFraction: number;
  readonly minMarginalUtilityPerToken: number;
  readonly mergeEpisodes: boolean;
  readonly mergeBeforeFraction: number;
  readonly maxIndividualUnits: number;
  readonly minEpisodeRawTokens: number;
  readonly maxEpisodeTokens: number;
  readonly semanticMaxTokens: number;
  readonly enableSemanticCompression: boolean;
  readonly includeHeader: boolean;
  readonly emergencyAllowAbsent: boolean;
  readonly hotSourceTokens: number;
  readonly warmSourceTokens: number;
  readonly coldCueTokens: number;
}

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  targetTokens: 12_000,
  minSummaryTokens: 4_000,
  maxSummaryTokens: 20_000,
  recentExactBiasFraction: 0.2,
  minMarginalUtilityPerToken: 0.06,
  mergeEpisodes: true,
  mergeBeforeFraction: 0.55,
  maxIndividualUnits: 600,
  minEpisodeRawTokens: 1_200,
  maxEpisodeTokens: 420,
  semanticMaxTokens: 180,
  enableSemanticCompression: true,
  includeHeader: true,
  emergencyAllowAbsent: true,
  hotSourceTokens: 10_000,
  warmSourceTokens: 75_000,
  coldCueTokens: 56,
};
