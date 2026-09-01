export const SOURCE_ID = "user:pi-rich-status";

export const TOKEN_NAMES = [
  "summary",
  "model",
  "context",
  "tool",
  "changed_files",
  "turn",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type TokenSnapshot = Partial<Record<TokenName, string>>;
export type TokenPatch = Record<TokenName, string | null>;

export const ACTIVITY_TTL_MS = 15_000;
export const TTL_REFRESH_MS = 5_000;
export const TOOL_UPDATE_REFRESH_MS = 3_000;
export const TOOL_CLEAR_DEBOUNCE_MS = 350;
export const COALESCE_MS = 150;
export const MIN_REPORT_INTERVAL_MS = 250;
export const PROCESS_TIMEOUT_MS = 1_500;
export const PROCESS_OUTPUT_LIMIT_BYTES = 4_096;
export const SCHEMA_OUTPUT_LIMIT_BYTES = 2_000_000;
export const FAILURE_THRESHOLD = 3;
export const MAX_BACKOFF_MS = 30_000;
export const SUMMARY_MAX_CHARS = 60;
export const TOKEN_VALUE_MAX_CHARS = 80;
