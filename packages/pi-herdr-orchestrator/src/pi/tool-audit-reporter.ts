import { sha256, canonicalJson } from "../shared/canonical-json.js";
import {
  createPrivateExclusive,
  readPrivateRegular,
  replacePrivateRegular,
  verifyPrivatePath,
} from "../shared/private-fs.js";
import {
  ensurePrivateDirectory,
  stateRootForSession,
} from "../shared/paths.js";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_PARENT_TOOL_NAMES,
  PARENT_TOOL_NAMES,
} from "./parent-tool-schema.js";
import type { PiBrokerClient } from "./broker-client.js";

const MANAGED_TOOL_NAMES = [
  "orchestrator_result",
  "orchestrator_ask",
  "orchestrator_review_submit",
] as const;
const MAX_INPUT_BYTES = 262_144;
const MAX_SPOOL_BYTES = 16 * 1024 * 1024;
const MAX_SPOOL_ITEMS = 4096;

export const AUDITED_ORCHESTRATION_TOOLS = new Set<string>([
  ...MANAGED_TOOL_NAMES,
  ...DEFAULT_PARENT_TOOL_NAMES,
  ...PARENT_TOOL_NAMES,
]);

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

interface AuditStartEnvelope {
  phase: "started";
  observedAt: string;
  toolCallId: string;
  toolName: string;
  input?: unknown;
  inputBytes?: number;
  inputSha256?: string;
  inputOmitted?: true;
  inputUnavailable?: "non_canonical";
}

interface AuditCompletionEnvelope {
  phase: "completed";
  observedAt: string;
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed" | "cancelled";
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

type AuditEnvelope = AuditStartEnvelope | AuditCompletionEnvelope;

interface PendingInvocation {
  toolName: string;
  startedAtMs: number;
}

export interface ToolExecutionStartLike {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
}

export interface ToolExecutionEndLike {
  toolCallId?: unknown;
  toolName?: unknown;
  result?: unknown;
  isError?: unknown;
}

export interface ToolAuditReporterOptions {
  now?: () => number;
  onGap?: (message: string) => void;
}

function safeText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeErrorMessage(value: string): string | undefined {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!normalized) return undefined;
  const bytes = Buffer.from(normalized, "utf8");
  return bytes.length <= 4096
    ? normalized
    : bytes
        .subarray(0, 4096)
        .toString("utf8")
        .replace(/\uFFFD$/u, "");
}

function resultErrorText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return undefined;
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is { type: string; text: string } =>
      Boolean(
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === "text" &&
        typeof (item as Record<string, unknown>).text === "string",
      ),
    )
    .map((item) => item.text)
    .join(" ");
  return normalizeErrorMessage(text);
}

function errorSummary(result: unknown): { code: string; message?: string } {
  const message = resultErrorText(result);
  const upper = message?.match(/\b[A-Z][A-Z0-9_]{2,63}\b/u)?.[0];
  if (upper)
    return {
      code: upper,
      ...(message ? { message } : {}),
    };
  const lower = message?.toLowerCase() ?? "";
  const code = lower.includes("invalid arguments for tool")
    ? "TOOL_ARGUMENT_VALIDATION"
    : lower.includes("not found")
      ? "TOOL_NOT_FOUND"
      : lower.includes("output token limit") || lower.includes("truncated")
        ? "TOOL_ARGUMENTS_TRUNCATED"
        : lower.includes("aborted") || lower.includes("cancelled")
          ? "TOOL_CANCELLED"
          : "TOOL_EXECUTION_FAILED";
  return { code, ...(message ? { message } : {}) };
}

function validateEnvelope(value: unknown): AuditEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tool audit spool entry is invalid.");
  const item = value as Record<string, unknown>;
  const parsedAt =
    typeof item.observedAt === "string" ? Date.parse(item.observedAt) : NaN;
  if (
    !safeText(item.toolCallId, 256) ||
    !safeText(item.toolName, 128) ||
    !safeText(item.observedAt, 64) ||
    !Number.isFinite(parsedAt) ||
    new Date(parsedAt).toISOString() !== item.observedAt
  )
    throw new Error("Tool audit spool entry is invalid.");
  if (item.phase === "started") {
    const allowed = new Set([
      "phase",
      "observedAt",
      "toolCallId",
      "toolName",
      "input",
      "inputBytes",
      "inputSha256",
      "inputOmitted",
      "inputUnavailable",
    ]);
    let encoded: string | undefined;
    try {
      if (
        item.inputUnavailable === undefined &&
        item.inputOmitted !== true &&
        Object.hasOwn(item, "input")
      )
        encoded = canonicalJson(item.input);
    } catch {
      throw new Error("Tool audit spool start input is invalid.");
    }
    if (
      Object.keys(item).some((key) => !allowed.has(key)) ||
      (item.inputUnavailable === "non_canonical"
        ? item.input !== undefined ||
          item.inputBytes !== undefined ||
          item.inputSha256 !== undefined ||
          item.inputOmitted !== undefined
        : item.inputUnavailable !== undefined ||
          !Number.isSafeInteger(item.inputBytes) ||
          Number(item.inputBytes) < 0 ||
          typeof item.inputSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(item.inputSha256) ||
          (item.inputOmitted === true
            ? item.input !== undefined ||
              Number(item.inputBytes) <= MAX_INPUT_BYTES
            : item.inputOmitted !== undefined ||
              encoded === undefined ||
              Buffer.byteLength(encoded, "utf8") !== item.inputBytes ||
              Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES ||
              sha256(encoded) !== item.inputSha256))
    )
      throw new Error("Tool audit spool start is invalid.");
    return item as unknown as AuditStartEnvelope;
  }
  const allowed = new Set([
    "phase",
    "observedAt",
    "toolCallId",
    "toolName",
    "status",
    "durationMs",
    "errorCode",
    "errorMessage",
  ]);
  if (
    item.phase !== "completed" ||
    Object.keys(item).some((key) => !allowed.has(key)) ||
    !["succeeded", "failed", "cancelled"].includes(String(item.status)) ||
    (item.durationMs !== undefined &&
      (!Number.isSafeInteger(item.durationMs) ||
        Number(item.durationMs) < 0)) ||
    (item.errorCode !== undefined &&
      (typeof item.errorCode !== "string" ||
        !/^[A-Z0-9_]{1,64}$/u.test(item.errorCode))) ||
    (item.errorMessage !== undefined && !safeText(item.errorMessage, 4096)) ||
    (item.status === "succeeded" &&
      (item.errorCode !== undefined || item.errorMessage !== undefined))
  )
    throw new Error("Tool audit spool completion is invalid.");
  return item as unknown as AuditCompletionEnvelope;
}

export function toolAuditSpoolPath(
  sessionKey: string,
  piSessionId: string,
): string {
  if (!safeText(piSessionId, 256))
    throw new Error("Pi session ID is invalid for audit spooling.");
  return join(
    stateRootForSession(sessionKey),
    "tool-audit-spool-v1",
    `${sha256(piSessionId)}.json`,
  );
}

export class ToolAuditReporter {
  readonly #now: () => number;
  readonly #onGap: (message: string) => void;
  readonly #pending = new Map<string, PendingInvocation>();
  #queue: AuditEnvelope[] = [];
  #spoolPath: string | undefined;
  #client: PiBrokerClient | undefined;
  #tail: Promise<void> = Promise.resolve();
  #drainPromise: Promise<void> | undefined;
  #loaded = false;

  constructor(options: ToolAuditReporterOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onGap = options.onGap ?? (() => undefined);
  }

  async configure(sessionKey: string, piSessionId: string): Promise<void> {
    const path = toolAuditSpoolPath(sessionKey, piSessionId);
    if (this.#spoolPath === path && this.#loaded) return;
    if (this.#loaded) await this.interrupt("PI_SESSION_REPLACED");
    this.#loaded = false;
    this.#spoolPath = path;
    await ensurePrivateDirectory(
      join(stateRootForSession(sessionKey), "tool-audit-spool-v1"),
    );
    this.#queue = [];
    const exists = await pathExists(path);
    if (exists) {
      const parsed = JSON.parse(await readPrivateRegular(path));
      if (!Array.isArray(parsed) || parsed.length > MAX_SPOOL_ITEMS)
        throw new Error("Tool audit spool is invalid.");
      this.#queue = parsed.map(validateEnvelope);
    }
    this.#loaded = true;
    void this.flush();
  }

  bind(client: PiBrokerClient): void {
    this.#client = client;
    void this.flush();
  }

  unbind(client?: PiBrokerClient): void {
    if (!client || this.#client === client) this.#client = undefined;
  }

  async captureStart(event: ToolExecutionStartLike): Promise<void> {
    if (
      !safeText(event.toolCallId, 256) ||
      !safeText(event.toolName, 128) ||
      !AUDITED_ORCHESTRATION_TOOLS.has(event.toolName)
    )
      return;
    const observedAtMs = this.#now();
    const observedAt = new Date(observedAtMs).toISOString();
    let canonical: string | undefined;
    try {
      canonical = canonicalJson(event.args);
    } catch {
      canonical = undefined;
    }
    const bytes =
      canonical === undefined
        ? undefined
        : Buffer.byteLength(canonical, "utf8");
    const envelope: AuditStartEnvelope =
      canonical === undefined
        ? {
            phase: "started",
            observedAt,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            inputUnavailable: "non_canonical",
          }
        : bytes! <= MAX_INPUT_BYTES
          ? {
              phase: "started",
              observedAt,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: JSON.parse(canonical),
              inputBytes: bytes!,
              inputSha256: sha256(canonical),
            }
          : {
              phase: "started",
              observedAt,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              inputBytes: bytes!,
              inputSha256: sha256(canonical),
              inputOmitted: true,
            };
    if (
      this.#pending.has(event.toolCallId) ||
      this.#pending.size < MAX_SPOOL_ITEMS
    )
      this.#pending.set(event.toolCallId, {
        toolName: event.toolName,
        startedAtMs: observedAtMs,
      });
    else
      this.#onGap(
        "Tool audit pending-call limit was reached; completion duration may be unavailable.",
      );
    await this.#enqueue(envelope);
  }

  async captureEnd(event: ToolExecutionEndLike): Promise<void> {
    if (
      !safeText(event.toolCallId, 256) ||
      !safeText(event.toolName, 128) ||
      !AUDITED_ORCHESTRATION_TOOLS.has(event.toolName)
    )
      return;
    const endedAtMs = this.#now();
    const pending = this.#pending.get(event.toolCallId);
    this.#pending.delete(event.toolCallId);
    const failed = event.isError === true;
    const summary = failed ? errorSummary(event.result) : undefined;
    const cancelled = summary?.code === "TOOL_CANCELLED";
    await this.#enqueue({
      phase: "completed",
      observedAt: new Date(endedAtMs).toISOString(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: failed ? (cancelled ? "cancelled" : "failed") : "succeeded",
      ...(pending
        ? { durationMs: Math.max(0, endedAtMs - pending.startedAtMs) }
        : {}),
      ...(summary ? { errorCode: summary.code } : {}),
      ...(summary?.message ? { errorMessage: summary.message } : {}),
    });
  }

  async interrupt(reason = "PI_SESSION_SHUTDOWN"): Promise<void> {
    const observedAtMs = this.#now();
    const pending = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [toolCallId, value] of pending)
      await this.#enqueue({
        phase: "completed",
        observedAt: new Date(observedAtMs).toISOString(),
        toolCallId,
        toolName: value.toolName,
        status: "cancelled",
        durationMs: Math.max(0, observedAtMs - value.startedAtMs),
        errorCode: "PI_SESSION_INTERRUPTED",
        errorMessage: normalizeErrorMessage(reason) ?? "Pi session ended.",
      });
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.#drainPromise) return this.#drainPromise;
    const operation = this.#drain().catch((error: unknown) => {
      this.#onGap(
        error instanceof Error
          ? `Tool audit replay gap: ${error.message}`
          : "Tool audit replay gap: queued records could not be replayed.",
      );
    });
    this.#drainPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#drainPromise === operation) this.#drainPromise = undefined;
    }
  }

  async #enqueue(envelope: AuditEnvelope): Promise<void> {
    try {
      await this.#serialize(async () => {
        if (!this.#loaded)
          throw new Error("Tool audit spool is not configured.");
        if (this.#queue.length >= MAX_SPOOL_ITEMS)
          throw new Error("Tool audit spool item limit was reached.");
        this.#queue.push(envelope);
        await this.#persist();
      });
      void this.flush();
    } catch (error) {
      this.#onGap(
        error instanceof Error
          ? `Tool audit gap: ${error.message}`
          : "Tool audit gap: the invocation could not be recorded.",
      );
    }
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #drain(): Promise<void> {
    const client = this.#client;
    if (!client?.connected || !this.#loaded) return;
    while (
      this.#queue.length > 0 &&
      this.#client === client &&
      client.connected
    ) {
      const envelope = this.#queue[0]!;
      try {
        await client.request(
          "tool_audit.ingest",
          envelope as unknown as Record<string, unknown>,
          {
            timeoutMs: 5_000,
          },
        );
      } catch {
        return;
      }
      if (this.#queue[0] !== envelope) return;
      this.#queue.shift();
      await this.#serialize(() => this.#persist());
    }
  }

  async #persist(): Promise<void> {
    const path = this.#spoolPath;
    if (!path) throw new Error("Tool audit spool is not configured.");
    if (this.#queue.length === 0) {
      if (await pathExists(path)) {
        await verifyPrivatePath(path);
        await unlink(path);
      }
      return;
    }
    const content = `${canonicalJson(this.#queue)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_SPOOL_BYTES)
      throw new Error("Tool audit spool byte limit was reached.");
    if (await pathExists(path)) await replacePrivateRegular(path, content);
    else await createPrivateExclusive(path, content);
  }
}
