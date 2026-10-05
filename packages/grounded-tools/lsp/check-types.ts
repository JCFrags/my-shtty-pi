// Shared contracts for explicit checks. A finished file check is not a workspace pass.
export type CheckKind = "syntax" | "schema" | "type" | "lint" | "format" | "build" | "test" | "markdown" | "prose" | "links" | "diagnostic";
export type CheckScope = "file" | "changed" | "package" | "workspace";
export type CheckOutcome = "passed" | "findings" | "failed" | "unavailable" | "unsupported" | "skipped" | "busy" | "cancelled" | "timeout" | "output-limit";

export interface Finding {
  tool: string;
  kind: CheckKind;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  columnEncoding?: "utf-16" | "unicode" | "byte";
  severity: "error" | "warning" | "information";
  code?: string;
  message: string;
  sources?: string[];
  suggestion?: unknown;
}

export interface CheckTarget {
  scope: CheckScope;
  root: string;
  cwd: string;
  path: string;
  files: string[];
  targets: string[];
  selection: "exact-files" | "tool-discovery";
  baseRef?: string;
  notes: string[];
}

export interface CheckEnvironment {
  cwd: string;
  configurationFiles: string[];
  pythonPath?: string;
  pythonSource?: string;
  languageVersionHints: Array<{ file: string; value: string }>;
  notes: string[];
}

export interface CheckCommand {
  id: string;
  label: string;
  kind: CheckKind;
  command: string;
  args: string[];
  cwd: string;
  source: string;
  scopes: CheckScope[];
  projectNative: boolean;
  fingerprint: string;
  notes: string[];
}

export interface ExecutionRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  resourceClass?: "normal" | "expensive";
}

export interface ExecutionResult {
  outcome: "completed" | "failed" | "unavailable" | "busy" | "cancelled" | "timeout" | "output-limit";
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutLog?: string;
  stderrLog?: string;
  startedAt: number;
  durationMs: number;
  pid?: number;
  message?: string;
  resourceNotes: string[];
}

export type ExecuteCheck = (request: ExecutionRequest) => Promise<ExecutionResult>;

export interface CheckResult {
  tool: string;
  kind: CheckKind;
  scope: CheckScope;
  outcome: CheckOutcome;
  completed: boolean;
  findings: Finding[];
  environment: CheckEnvironment;
  target: CheckTarget;
  execution?: ExecutionResult;
  filesAnalyzed?: number;
  notes: string[];
  metadata?: unknown;
}

export interface ToolAvailability {
  id: string;
  configured: boolean;
  command?: string;
  executableAvailable: boolean;
  resolvedExecutable?: string;
  exercised: boolean;
  lastOutcome?: CheckOutcome;
  notes: string[];
}

export interface AnalyzerContext {
  target: CheckTarget;
  environment: CheckEnvironment;
  execute: ExecuteCheck;
  timeoutMs: number;
  signal?: AbortSignal;
  commands: Record<string, string>;
  allowNetwork: boolean;
  configuration?: Record<string, unknown>;
}

export interface TextPreview {
  tool: string;
  path: string;
  original: string;
  proposed: string;
  notes: string[];
  execution?: ExecutionResult;
}
