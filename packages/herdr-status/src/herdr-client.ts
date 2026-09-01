import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";

import {
  ACTIVITY_TTL_MS,
  PROCESS_OUTPUT_LIMIT_BYTES,
  PROCESS_TIMEOUT_MS,
  SCHEMA_OUTPUT_LIMIT_BYTES,
  SOURCE_ID,
  TOKEN_NAMES,
  type TokenPatch,
  type TokenSnapshot,
} from "./constants.ts";
import {
  redactCredentials,
  redactHomePathPrefixes,
  sanitizeSummary,
  sanitizeVisible,
} from "./sanitize.ts";

export interface ActivationState {
  active: boolean;
  paneId?: string;
  binaryPath?: string;
  reason?: string;
}

export type ExecutableCheck = (binaryPath: string) => boolean;

export function isExecutable(binaryPath: string): boolean {
  try {
    accessSync(binaryPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveActivation(
  environment: NodeJS.ProcessEnv,
  executableCheck: ExecutableCheck = isExecutable,
): ActivationState {
  const paneId = environment.HERDR_PANE_ID?.trim() || undefined;
  const binaryPath = environment.HERDR_BIN_PATH?.trim() || undefined;

  if (environment.HERDR_ENV !== "1") {
    return {
      active: false,
      ...(paneId ? { paneId } : {}),
      ...(binaryPath ? { binaryPath } : {}),
      reason: "HERDR_ENV is not 1",
    };
  }

  if (!paneId) {
    return {
      active: false,
      ...(binaryPath ? { binaryPath } : {}),
      reason: "HERDR_PANE_ID is missing",
    };
  }

  if (!binaryPath) {
    return { active: false, paneId, reason: "HERDR_BIN_PATH is missing" };
  }

  if (!executableCheck(binaryPath)) {
    return {
      active: false,
      paneId,
      binaryPath,
      reason: "HERDR_BIN_PATH is not executable",
    };
  }

  return { active: true, paneId, binaryPath };
}

export interface ProcessRunOptions {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
}

function appendBounded(current: Buffer, incoming: Buffer, limitBytes: number): Buffer {
  if (current.length >= limitBytes) return current;
  const remaining = limitBytes - current.length;
  return Buffer.concat([current, incoming.subarray(0, remaining)]);
}

function processErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "unknown")
      : "unknown";
  return `unable to start Herdr (${sanitizeVisible(code, 32)})`;
}

export async function runBoundedProcess(
  binaryPath: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes ?? PROCESS_OUTPUT_LIMIT_BYTES;

  return await new Promise<ProcessRunResult>((resolve, reject) => {
    let settled = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const child = spawn(binaryPath, [...args], {
      env: options.environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdout = appendBounded(stdout, buffer, outputLimitBytes);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = appendBounded(stderr, buffer, outputLimitBytes);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Herdr command timed out"));
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(processErrorMessage(error)));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Herdr exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

export interface HerdrCapabilities {
  sequence: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasFlag(helpText: string, flag: string): boolean {
  let offset = 0;
  while (offset < helpText.length) {
    const index = helpText.indexOf(flag, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : helpText[index - 1];
    const after = helpText[index + flag.length];
    const beforeBoundary = before === undefined || " \t\r\n[".includes(before);
    const afterBoundary = after === undefined || " \t\r\n=,[".includes(after);
    if (beforeBoundary && afterBoundary) return true;
    offset = index + flag.length;
  }
  return false;
}

export function detectHerdrCapabilities(schemaText: string, helpText: string): HerdrCapabilities {
  let schema: unknown;
  try {
    schema = JSON.parse(schemaText) as unknown;
  } catch {
    throw new Error("Herdr API schema was not valid JSON");
  }

  const root = asRecord(schema);
  const schemas = asRecord(root?.schemas);
  const request = asRecord(schemas?.request);
  const definitions = asRecord(request?.$defs);
  const params = asRecord(definitions?.PaneReportMetadataParams);
  const properties = asRecord(params?.properties);

  if (!properties || !properties.tokens || !properties.ttl_ms) {
    throw new Error("installed Herdr lacks required metadata tokens or TTL support");
  }

  for (const requiredFlag of ["--source", "--token", "--clear-token", "--ttl-ms"]) {
    if (!hasFlag(helpText, requiredFlag)) {
      throw new Error(`installed Herdr help lacks ${requiredFlag}`);
    }
  }

  return {
    sequence: Boolean(properties.seq) && hasFlag(helpText, "--seq"),
  };
}

export function snapshotToPatch(snapshot: TokenSnapshot): TokenPatch {
  return Object.fromEntries(
    TOKEN_NAMES.map((name) => {
      const value = snapshot[name];
      if (value === undefined) return [name, null];
      const redacted = redactHomePathPrefixes(redactCredentials(String(value)));
      const normalized = name === "summary"
        ? sanitizeSummary(redacted)
        : sanitizeVisible(redacted);
      return [name, normalized || null];
    }),
  ) as TokenPatch;
}

export interface ReportArguments {
  paneId: string;
  sourceId?: string;
  tokens: TokenPatch;
  sequence?: number | undefined;
  ttlMs?: number | undefined;
}

export function buildReportMetadataArgs(input: ReportArguments): string[] {
  const args = [
    "pane",
    "report-metadata",
    input.paneId,
    "--source",
    input.sourceId ?? SOURCE_ID,
  ];

  for (const name of TOKEN_NAMES) {
    const value = input.tokens[name];
    if (value === null) {
      args.push("--clear-token", name);
    } else {
      args.push("--token", `${name}=${value}`);
    }
  }

  if (input.sequence !== undefined) {
    args.push("--seq", String(input.sequence));
  }
  if (input.ttlMs !== undefined) {
    args.push("--ttl-ms", String(input.ttlMs));
  }
  return args;
}

export function buildClearMetadataArgs(
  paneId: string,
  sequence: number | undefined,
  sourceId = SOURCE_ID,
): string[] {
  const tokens = Object.fromEntries(TOKEN_NAMES.map((name) => [name, null])) as TokenPatch;
  return buildReportMetadataArgs({ paneId, sourceId, tokens, sequence });
}

export interface MetadataTransport {
  report(snapshot: TokenSnapshot, sequence: number, ttlMs: number): Promise<void>;
  clear(sequence: number): Promise<void>;
}

export interface HerdrCliOptions {
  binaryPath: string;
  paneId: string;
  environment?: NodeJS.ProcessEnv;
  processTimeoutMs?: number;
}

export class HerdrCli implements MetadataTransport {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly processTimeoutMs: number;
  private capabilitiesPromise: Promise<HerdrCapabilities> | undefined;

  constructor(private readonly options: HerdrCliOptions) {
    this.environment = options.environment ?? process.env;
    this.processTimeoutMs = options.processTimeoutMs ?? PROCESS_TIMEOUT_MS;
  }

  async inspectInstalledInterface(): Promise<HerdrCapabilities> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.probeInstalledInterface().catch((error: unknown) => {
        this.capabilitiesPromise = undefined;
        throw error;
      });
    }
    return await this.capabilitiesPromise;
  }

  async report(
    snapshot: TokenSnapshot,
    sequence: number,
    ttlMs = ACTIVITY_TTL_MS,
  ): Promise<void> {
    const capabilities = await this.inspectInstalledInterface();
    const args = buildReportMetadataArgs({
      paneId: this.options.paneId,
      tokens: snapshotToPatch(snapshot),
      sequence: capabilities.sequence ? sequence : undefined,
      ttlMs,
    });
    await runBoundedProcess(this.options.binaryPath, args, {
      environment: this.environment,
      timeoutMs: this.processTimeoutMs,
      outputLimitBytes: PROCESS_OUTPUT_LIMIT_BYTES,
    });
  }

  async clear(sequence: number): Promise<void> {
    const capabilities = await this.inspectInstalledInterface();
    const args = buildClearMetadataArgs(
      this.options.paneId,
      capabilities.sequence ? sequence : undefined,
    );
    await runBoundedProcess(this.options.binaryPath, args, {
      environment: this.environment,
      timeoutMs: this.processTimeoutMs,
      outputLimitBytes: PROCESS_OUTPUT_LIMIT_BYTES,
    });
  }

  private async probeInstalledInterface(): Promise<HerdrCapabilities> {
    const schema = await runBoundedProcess(
      this.options.binaryPath,
      ["api", "schema", "--json"],
      {
        environment: this.environment,
        timeoutMs: this.processTimeoutMs,
        outputLimitBytes: SCHEMA_OUTPUT_LIMIT_BYTES,
      },
    );
    const help = await runBoundedProcess(
      this.options.binaryPath,
      ["pane", "report-metadata", "--help"],
      {
        environment: this.environment,
        timeoutMs: this.processTimeoutMs,
        outputLimitBytes: PROCESS_OUTPUT_LIMIT_BYTES * 4,
      },
    );

    return detectHerdrCapabilities(schema.stdout, `${help.stdout}\n${help.stderr}`);
  }
}
