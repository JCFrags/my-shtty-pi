import { constants } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, sha256 } from "../shared/canonical-json.js";
import {
  createPrivateExclusive,
  readPrivateLines,
  verifyPrivatePath,
} from "../shared/private-fs.js";
import { OrchestratorError } from "../shared/errors.js";

const ZERO_HASH = "0".repeat(64);
const DEFAULT_MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 8;
const MAX_INPUT_BYTES = 262_144;
const noFollow =
  (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export const TOOL_AUDIT_PHASES = ["started", "completed"] as const;
export const TOOL_AUDIT_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type ToolAuditStatus = (typeof TOOL_AUDIT_STATUSES)[number];

export interface ToolAuditActor {
  principalId: string;
  kind: string;
  agentId: string;
  piSessionId: string;
}

export interface ToolAuditStartInput {
  phase: "started";
  observedAt: string;
  toolCallId: string;
  toolName: string;
  input?: unknown;
  inputBytes: number;
  inputSha256: string;
  inputOmitted?: true;
}

export interface ToolAuditCompletionInput {
  phase: "completed";
  observedAt: string;
  toolCallId: string;
  toolName: string;
  status: ToolAuditStatus;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

export type ToolAuditInput = ToolAuditStartInput | ToolAuditCompletionInput;

export interface ToolAuditRecord {
  schemaVersion: 1;
  seq: number;
  id: string;
  timestamp: string;
  phase: "started" | "completed";
  invocationId: string;
  toolCallId: string;
  toolName: string;
  actor: ToolAuditActor;
  action?: string;
  input?: unknown;
  inputBytes?: number;
  inputSha256?: string;
  inputOmitted?: true;
  status?: ToolAuditStatus;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  prevHash: string;
  hash: string;
}

export interface ToolAuditInvocation {
  invocationId: string;
  toolCallId: string;
  toolName: string;
  action?: string;
  actor: ToolAuditActor;
  startedAt: string;
  completedAt?: string;
  status: ToolAuditStatus | "incomplete";
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  input?: unknown;
  inputBytes: number;
  inputSha256: string;
  inputOmitted?: true;
  startSeq: number;
  completionSeq?: number;
}

export interface ToolAuditQuery {
  toolName?: string;
  action?: string;
  agentId?: string;
  status?: ToolAuditStatus | "incomplete";
  errorCode?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ToolAuditStoreOptions {
  maxSegmentBytes?: number;
  maxSegments?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OrchestratorError("AUDIT_CORRUPT", "Audit record is invalid.");
  return value as Record<string, unknown>;
}

function safeText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function safeId(value: unknown, maxBytes = 256): value is string {
  return safeText(value, maxBytes);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

function safeTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  )
    return true;
  if (Array.isArray(value))
    return (
      value.length <= 4096 && value.every((item) => safeJson(item, depth + 1))
    );
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 4096 &&
      entries.every(
        ([key, item]) =>
          Buffer.byteLength(key, "utf8") <= 1024 &&
          !/[\u0000-\u001f\u007f]/u.test(key) &&
          safeJson(item, depth + 1),
      )
    );
  }
  return false;
}

function validateActor(value: unknown): ToolAuditActor {
  const source = record(value);
  if (
    Object.keys(source).length !== 4 ||
    !["principalId", "kind", "agentId", "piSessionId"].every((key) =>
      Object.hasOwn(source, key),
    ) ||
    !safeId(source.principalId) ||
    !safeText(source.kind, 64) ||
    !safeId(source.agentId) ||
    !safeId(source.piSessionId)
  )
    throw new OrchestratorError("AUDIT_CORRUPT", "Audit actor is invalid.");
  return source as unknown as ToolAuditActor;
}

function validateStoredRecord(value: unknown): ToolAuditRecord {
  const source = record(value);
  const allowed = new Set([
    "schemaVersion",
    "seq",
    "id",
    "timestamp",
    "phase",
    "invocationId",
    "toolCallId",
    "toolName",
    "actor",
    "action",
    "input",
    "inputBytes",
    "inputSha256",
    "inputOmitted",
    "status",
    "durationMs",
    "errorCode",
    "errorMessage",
    "prevHash",
    "hash",
  ]);
  if (
    Object.keys(source).some((key) => !allowed.has(key)) ||
    source.schemaVersion !== 1 ||
    !Number.isSafeInteger(source.seq) ||
    Number(source.seq) < 1 ||
    !safeId(source.id) ||
    !safeTimestamp(source.timestamp) ||
    !TOOL_AUDIT_PHASES.includes(source.phase as never) ||
    !safeHash(source.invocationId) ||
    !safeId(source.toolCallId) ||
    !safeText(source.toolName, 128) ||
    !safeHash(source.prevHash) ||
    !safeHash(source.hash)
  )
    throw new OrchestratorError("AUDIT_CORRUPT", "Audit record is invalid.");
  validateActor(source.actor);
  if (source.action !== undefined && !safeText(source.action, 128))
    throw new OrchestratorError("AUDIT_CORRUPT", "Audit action is invalid.");
  if (source.phase === "started") {
    if (
      !Number.isSafeInteger(source.inputBytes) ||
      Number(source.inputBytes) < 0 ||
      !safeHash(source.inputSha256) ||
      (source.inputOmitted === true
        ? source.input !== undefined ||
          Number(source.inputBytes) <= MAX_INPUT_BYTES
        : source.inputOmitted !== undefined ||
          !Object.hasOwn(source, "input") ||
          !safeJson(source.input) ||
          Buffer.byteLength(canonicalJson(source.input), "utf8") !==
            Number(source.inputBytes) ||
          sha256(canonicalJson(source.input)) !== source.inputSha256) ||
      source.status !== undefined ||
      source.durationMs !== undefined ||
      source.errorCode !== undefined ||
      source.errorMessage !== undefined
    )
      throw new OrchestratorError(
        "AUDIT_CORRUPT",
        "Audit start record is invalid.",
      );
  } else if (
    !TOOL_AUDIT_STATUSES.includes(source.status as never) ||
    source.input !== undefined ||
    source.inputBytes !== undefined ||
    source.inputSha256 !== undefined ||
    source.inputOmitted !== undefined ||
    (source.durationMs !== undefined &&
      (!Number.isSafeInteger(source.durationMs) ||
        Number(source.durationMs) < 0)) ||
    (source.errorCode !== undefined &&
      (typeof source.errorCode !== "string" ||
        !/^[A-Z0-9_]{1,64}$/u.test(source.errorCode))) ||
    (source.errorMessage !== undefined &&
      !safeText(source.errorMessage, 4096)) ||
    (source.status === "succeeded" &&
      (source.errorCode !== undefined || source.errorMessage !== undefined))
  )
    throw new OrchestratorError(
      "AUDIT_CORRUPT",
      "Audit completion record is invalid.",
    );
  const unsigned = { ...source };
  delete unsigned.hash;
  if (sha256(canonicalJson(unsigned)) !== source.hash)
    throw new OrchestratorError("AUDIT_CORRUPT", "Audit hash is invalid.");
  return source as unknown as ToolAuditRecord;
}

function validateInput(input: ToolAuditInput): void {
  if (
    !safeTimestamp(input.observedAt) ||
    !safeId(input.toolCallId) ||
    !safeText(input.toolName, 128)
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Tool audit input is invalid.",
    );
  if (input.phase === "started") {
    if (
      !Number.isSafeInteger(input.inputBytes) ||
      input.inputBytes < 0 ||
      !safeHash(input.inputSha256) ||
      (input.inputOmitted === true
        ? input.input !== undefined || input.inputBytes <= MAX_INPUT_BYTES
        : input.inputOmitted !== undefined ||
          !Object.hasOwn(input, "input") ||
          !safeJson(input.input) ||
          input.inputBytes > MAX_INPUT_BYTES ||
          Buffer.byteLength(canonicalJson(input.input), "utf8") !==
            input.inputBytes ||
          sha256(canonicalJson(input.input)) !== input.inputSha256)
    )
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Tool audit start is invalid.",
      );
  } else if (
    !TOOL_AUDIT_STATUSES.includes(input.status) ||
    (input.durationMs !== undefined &&
      (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0)) ||
    (input.errorCode !== undefined &&
      !/^[A-Z0-9_]{1,64}$/u.test(input.errorCode)) ||
    (input.errorMessage !== undefined && !safeText(input.errorMessage, 4096)) ||
    (input.status === "succeeded" &&
      (input.errorCode !== undefined || input.errorMessage !== undefined))
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Tool audit completion is invalid.",
    );
}

function validateQuery(query: ToolAuditQuery): {
  since?: number;
  until?: number;
} {
  for (const [value, maxBytes, label] of [
    [query.toolName, 128, "tool name"],
    [query.action, 128, "action"],
    [query.agentId, 256, "agent ID"],
    [query.errorCode, 64, "error code"],
  ] as const)
    if (value !== undefined && !safeText(value, maxBytes))
      throw new OrchestratorError(
        "INVALID_REQUEST",
        `Audit ${label} filter is invalid.`,
      );
  if (
    query.status !== undefined &&
    query.status !== "incomplete" &&
    !TOOL_AUDIT_STATUSES.includes(query.status)
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Audit status filter is invalid.",
    );
  const since = query.since === undefined ? undefined : Date.parse(query.since);
  const until = query.until === undefined ? undefined : Date.parse(query.until);
  if (
    (query.since !== undefined && !safeTimestamp(query.since)) ||
    (query.until !== undefined && !safeTimestamp(query.until)) ||
    (since !== undefined && until !== undefined && since > until)
  )
    throw new OrchestratorError(
      "INVALID_REQUEST",
      "Audit time range is invalid.",
    );
  return {
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

function actionFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const action = (input as Record<string, unknown>).action;
  return safeText(action, 128) ? action : undefined;
}

function inputFromRecord(record: ToolAuditRecord): ToolAuditInput {
  return record.phase === "started"
    ? {
        phase: "started",
        observedAt: record.timestamp,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        ...(record.inputOmitted === true
          ? { inputOmitted: true as const }
          : { input: record.input }),
        inputBytes: record.inputBytes!,
        inputSha256: record.inputSha256!,
      }
    : {
        phase: "completed",
        observedAt: record.timestamp,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        status: record.status!,
        ...(record.durationMs === undefined
          ? {}
          : { durationMs: record.durationMs }),
        ...(record.errorCode === undefined
          ? {}
          : { errorCode: record.errorCode }),
        ...(record.errorMessage === undefined
          ? {}
          : { errorMessage: record.errorMessage }),
      };
}

function phaseDigest(actor: ToolAuditActor, input: ToolAuditInput): string {
  return sha256(canonicalJson({ actor, input }));
}

function summaryFromStart(record: ToolAuditRecord): ToolAuditInvocation {
  return {
    invocationId: record.invocationId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    ...(record.action ? { action: record.action } : {}),
    actor: record.actor,
    startedAt: record.timestamp,
    status: "incomplete",
    ...(record.inputOmitted === true
      ? { inputOmitted: true as const }
      : { input: record.input }),
    inputBytes: record.inputBytes!,
    inputSha256: record.inputSha256!,
    startSeq: record.seq,
  };
}

export class ToolInvocationAuditStore {
  readonly path: string;
  readonly maxSegmentBytes: number;
  readonly maxSegments: number;
  #opened = false;
  #available = true;
  #corruption: string | undefined;
  #nextSeq = 1;
  #lastHash = ZERO_HASH;
  #seen = new Map<string, string>();
  #startTools = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: ToolAuditStoreOptions = {}) {
    this.path = path;
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
    if (
      !Number.isSafeInteger(this.maxSegmentBytes) ||
      this.maxSegmentBytes < 4096 ||
      this.maxSegmentBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(this.maxSegments) ||
      this.maxSegments < 1 ||
      this.maxSegments > 64
    )
      throw new Error("Tool audit retention limits are invalid.");
  }

  get available(): boolean {
    return this.#available;
  }

  get corruption(): string | undefined {
    return this.#corruption;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  async open(): Promise<void> {
    if (this.#opened) return;
    this.#opened = true;
    let previous: ToolAuditRecord | undefined;
    try {
      for (const path of await this.#retainedPaths()) {
        for await (const line of readPrivateLines(path)) {
          const stored = validateStoredRecord(JSON.parse(line));
          if (
            previous &&
            (stored.seq !== previous.seq + 1 ||
              stored.prevHash !== previous.hash)
          )
            throw new OrchestratorError(
              "AUDIT_CORRUPT",
              "Tool audit sequence or chain is invalid.",
            );
          if (!previous && stored.seq === 1 && stored.prevHash !== ZERO_HASH)
            throw new OrchestratorError(
              "AUDIT_CORRUPT",
              "Tool audit initial hash is invalid.",
            );
          const key = `${stored.invocationId}:${stored.phase}`;
          if (this.#seen.has(key))
            throw new OrchestratorError(
              "AUDIT_CORRUPT",
              "Tool audit contains a duplicate phase.",
            );
          this.#seen.set(
            key,
            phaseDigest(stored.actor, inputFromRecord(stored)),
          );
          if (stored.phase === "started")
            this.#startTools.set(stored.invocationId, stored.toolName);
          previous = stored;
        }
      }
      if (previous) {
        this.#nextSeq = previous.seq + 1;
        this.#lastHash = previous.hash;
      }
    } catch (error) {
      this.#available = false;
      this.#corruption =
        error instanceof Error
          ? error.message
          : "Tool audit could not be opened.";
    }
  }

  async append(
    actor: ToolAuditActor,
    input: ToolAuditInput,
  ): Promise<{
    stored: boolean;
    invocationId: string;
    seq?: number;
  }> {
    validateActor(actor);
    validateInput(input);
    if (!this.#opened) await this.open();
    if (!this.#available)
      throw new OrchestratorError(
        "AUDIT_UNAVAILABLE",
        this.#corruption ?? "Tool audit is unavailable.",
      );
    const invocationId = sha256(
      `${actor.principalId}\u0000${actor.agentId}\u0000${actor.piSessionId}\u0000${input.toolCallId}`,
    );
    const key = `${invocationId}:${input.phase}`;
    const digest = phaseDigest(actor, input);
    const previousDigest = this.#seen.get(key);
    if (previousDigest !== undefined) {
      if (previousDigest !== digest)
        throw new OrchestratorError(
          "IDEMPOTENCY_CONFLICT",
          "Tool audit phase replay does not match the stored input.",
        );
      return { stored: false, invocationId };
    }
    if (input.phase === "completed") {
      const startTool = this.#startTools.get(invocationId);
      if (startTool !== undefined && startTool !== input.toolName)
        throw new OrchestratorError(
          "IDEMPOTENCY_CONFLICT",
          "Tool audit completion tool does not match its start phase.",
        );
    }
    let outcome: { stored: boolean; invocationId: string; seq?: number } = {
      stored: false,
      invocationId,
    };
    const operation = this.#tail.then(async () => {
      const concurrentDigest = this.#seen.get(key);
      if (concurrentDigest !== undefined) {
        if (concurrentDigest !== digest)
          throw new OrchestratorError(
            "IDEMPOTENCY_CONFLICT",
            "Tool audit phase replay does not match the stored input.",
          );
        return;
      }
      if (input.phase === "completed") {
        const startTool = this.#startTools.get(invocationId);
        if (startTool !== undefined && startTool !== input.toolName)
          throw new OrchestratorError(
            "IDEMPOTENCY_CONFLICT",
            "Tool audit completion tool does not match its start phase.",
          );
      }
      const base = {
        schemaVersion: 1,
        seq: this.#nextSeq,
        id: `aud_${String(this.#nextSeq).padStart(20, "0")}`,
        timestamp: input.observedAt,
        phase: input.phase,
        invocationId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        actor,
        ...(input.phase === "started"
          ? {
              ...(actionFromInput(input.input)
                ? { action: actionFromInput(input.input) }
                : {}),
              ...(input.inputOmitted === true
                ? { inputOmitted: true as const }
                : { input: input.input }),
              inputBytes: input.inputBytes,
              inputSha256: input.inputSha256,
            }
          : {
              status: input.status,
              ...(input.durationMs !== undefined
                ? { durationMs: input.durationMs }
                : {}),
              ...(input.errorCode ? { errorCode: input.errorCode } : {}),
              ...(input.errorMessage
                ? { errorMessage: input.errorMessage }
                : {}),
            }),
        prevHash: this.#lastHash,
      } as Omit<ToolAuditRecord, "hash">;
      const stored: ToolAuditRecord = {
        ...base,
        hash: sha256(canonicalJson(base)),
      };
      const line = `${canonicalJson(stored)}\n`;
      if (Buffer.byteLength(line, "utf8") > this.maxSegmentBytes)
        throw new OrchestratorError(
          "LIMIT_EXCEEDED",
          "Tool audit record exceeds the segment limit.",
        );
      const rotated = await this.#rotateIfNeeded(
        Buffer.byteLength(line, "utf8"),
      );
      if (rotated) await this.#rebuildSeen();
      await this.#appendLine(line);
      this.#seen.set(key, digest);
      if (input.phase === "started")
        this.#startTools.set(invocationId, input.toolName);
      this.#nextSeq++;
      this.#lastHash = stored.hash;
      outcome = { stored: true, invocationId, seq: stored.seq };
    });
    this.#tail = operation.catch(() => undefined);
    await operation;
    return outcome;
  }

  async list(query: ToolAuditQuery = {}): Promise<ToolAuditInvocation[]> {
    this.#assertReadable();
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Audit query limit is invalid.",
      );
    const items = await this.#scan(query);
    return items.slice(0, limit).map((item) => {
      const { input: _input, ...summary } = item;
      return summary;
    });
  }

  async get(invocationId: string): Promise<ToolAuditInvocation | null> {
    this.#assertReadable();
    if (!safeHash(invocationId))
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Audit invocation ID is invalid.",
      );
    let call: ToolAuditInvocation | undefined;
    for await (const item of this.#records()) {
      if (item.invocationId !== invocationId) continue;
      if (item.phase === "started") call = summaryFromStart(item);
      else if (call) {
        call.completedAt = item.timestamp;
        call.status = item.status!;
        call.completionSeq = item.seq;
        if (item.durationMs !== undefined) call.durationMs = item.durationMs;
        if (item.errorCode !== undefined) call.errorCode = item.errorCode;
        if (item.errorMessage !== undefined)
          call.errorMessage = item.errorMessage;
      }
    }
    return call ?? null;
  }

  async stats(
    query: Omit<ToolAuditQuery, "limit"> & {
      groupBy?: readonly ("toolName" | "action" | "status" | "errorCode")[];
    } = {},
  ): Promise<{
    total: number;
    incomplete: number;
    groups: Array<{ key: Record<string, string>; count: number }>;
  }> {
    const groupBy = query.groupBy ?? ["action", "errorCode"];
    if (
      groupBy.length < 1 ||
      groupBy.length > 4 ||
      new Set(groupBy).size !== groupBy.length ||
      groupBy.some(
        (field) =>
          !["toolName", "action", "status", "errorCode"].includes(field),
      )
    )
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Audit grouping is invalid.",
      );
    const { groupBy: _groupBy, ...filters } = query;
    const items = await this.#scan(filters);
    const groups = new Map<
      string,
      { key: Record<string, string>; count: number }
    >();
    for (const item of items) {
      const key = Object.fromEntries(
        groupBy.map((field) => [field, String(item[field] ?? "(none)")]),
      );
      const encoded = canonicalJson(key);
      const current = groups.get(encoded);
      if (current) current.count++;
      else groups.set(encoded, { key, count: 1 });
    }
    return {
      total: items.length,
      incomplete: items.filter((item) => item.status === "incomplete").length,
      groups: [...groups.values()].sort(
        (left, right) =>
          right.count - left.count ||
          canonicalJson(left.key).localeCompare(canonicalJson(right.key)),
      ),
    };
  }

  async verify(): Promise<{
    valid: boolean;
    records: number;
    retainedFromSeq: number | null;
    lastSeq: number;
    lastHash: string;
    truncatedPrefix: boolean;
    segments: number;
    maxRetainedBytes: number;
  }> {
    this.#assertReadable();
    let previous: ToolAuditRecord | undefined;
    let first: ToolAuditRecord | undefined;
    let count = 0;
    const paths = await this.#retainedPaths();
    for await (const item of this.#records()) {
      first ??= item;
      if (
        previous &&
        (item.seq !== previous.seq + 1 || item.prevHash !== previous.hash)
      )
        throw new OrchestratorError("AUDIT_CORRUPT", "Audit chain is invalid.");
      previous = item;
      count++;
    }
    return {
      valid: true,
      records: count,
      retainedFromSeq: first?.seq ?? null,
      lastSeq: previous?.seq ?? 0,
      lastHash: previous?.hash ?? ZERO_HASH,
      truncatedPrefix: Boolean(first && first.seq > 1),
      segments: paths.length,
      maxRetainedBytes: this.maxSegmentBytes * this.maxSegments,
    };
  }

  async #scan(query: ToolAuditQuery): Promise<ToolAuditInvocation[]> {
    const { since, until } = validateQuery(query);
    const calls = new Map<string, ToolAuditInvocation>();
    for await (const item of this.#records()) {
      if (item.phase === "started") {
        if (
          (query.toolName && item.toolName !== query.toolName) ||
          (query.action && item.action !== query.action) ||
          (query.agentId && item.actor.agentId !== query.agentId) ||
          (since !== undefined && Date.parse(item.timestamp) < since) ||
          (until !== undefined && Date.parse(item.timestamp) > until)
        )
          continue;
        calls.set(item.invocationId, summaryFromStart(item));
      } else {
        const call = calls.get(item.invocationId);
        if (!call) continue;
        call.completedAt = item.timestamp;
        call.status = item.status!;
        call.completionSeq = item.seq;
        if (item.durationMs !== undefined) call.durationMs = item.durationMs;
        if (item.errorCode !== undefined) call.errorCode = item.errorCode;
        if (item.errorMessage !== undefined)
          call.errorMessage = item.errorMessage;
      }
    }
    return [...calls.values()]
      .filter(
        (item) =>
          (!query.status || item.status === query.status) &&
          (!query.errorCode || item.errorCode === query.errorCode),
      )
      .sort((left, right) => right.startSeq - left.startSeq);
  }

  #assertReadable(): void {
    if (!this.#opened)
      throw new OrchestratorError(
        "AUDIT_UNAVAILABLE",
        "Tool audit is not open.",
      );
    if (!this.#available)
      throw new OrchestratorError(
        "AUDIT_UNAVAILABLE",
        this.#corruption ?? "Tool audit is unavailable.",
      );
  }

  async *#records(): AsyncGenerator<ToolAuditRecord> {
    for (const path of await this.#retainedPaths())
      for await (const line of readPrivateLines(path))
        yield validateStoredRecord(JSON.parse(line));
  }

  async #rebuildSeen(): Promise<void> {
    const retained = new Map<string, string>();
    const startTools = new Map<string, string>();
    for await (const stored of this.#records()) {
      const key = `${stored.invocationId}:${stored.phase}`;
      if (retained.has(key))
        throw new OrchestratorError(
          "AUDIT_CORRUPT",
          "Tool audit contains a duplicate retained phase.",
        );
      retained.set(key, phaseDigest(stored.actor, inputFromRecord(stored)));
      if (stored.phase === "started")
        startTools.set(stored.invocationId, stored.toolName);
    }
    this.#seen = retained;
    this.#startTools = startTools;
  }

  async #retainedPaths(): Promise<string[]> {
    const paths: string[] = [];
    for (let index = this.maxSegments - 1; index >= 1; index--) {
      const path = `${this.path}.${index}`;
      if (await pathExists(path)) paths.push(path);
    }
    if (await pathExists(this.path)) paths.push(this.path);
    return paths;
  }

  async #rotateIfNeeded(nextBytes: number): Promise<boolean> {
    const currentBytes = await stat(this.path).then(
      (value) => value.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    );
    if (currentBytes === 0 || currentBytes + nextBytes <= this.maxSegmentBytes)
      return false;
    const oldest = `${this.path}.${this.maxSegments - 1}`;
    if (this.maxSegments > 1) {
      if (await pathExists(oldest)) {
        await verifyPrivatePath(oldest);
        await unlink(oldest);
      }
      for (let index = this.maxSegments - 2; index >= 1; index--) {
        const source = `${this.path}.${index}`;
        if (!(await pathExists(source))) continue;
        await verifyPrivatePath(source);
        await rename(source, `${this.path}.${index + 1}`);
      }
      await verifyPrivatePath(this.path);
      await rename(this.path, `${this.path}.1`);
    } else {
      await verifyPrivatePath(this.path);
      await unlink(this.path);
    }
    const directory = await open(dirname(this.path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  }

  async #appendLine(line: string): Promise<void> {
    let handle;
    try {
      handle = await open(
        this.path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
        0o600,
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await createPrivateExclusive(this.path, "");
      handle = await open(
        this.path,
        constants.O_WRONLY | constants.O_APPEND | noFollow,
      );
    }
    try {
      const value = await handle.stat();
      const uid = process.getuid?.();
      if (
        !value.isFile() ||
        value.nlink !== 1 ||
        (uid !== undefined && value.uid !== uid) ||
        (value.mode & 0o077) !== 0
      )
        throw new Error("Tool audit file is unsafe.");
      await handle.writeFile(line, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  }
}
