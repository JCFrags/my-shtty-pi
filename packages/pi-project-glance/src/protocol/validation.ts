import {
  MAX_CURRENT_TEXT_BYTES,
  MAX_FEED_ITEMS,
  MAX_GENERATION_BYTES,
  MAX_ITEM_ID_BYTES,
  MAX_ITEM_TEXT_BYTES,
  MAX_REQUEST_ID_BYTES,
  MAX_SESSION_KEY_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_TOKEN_BYTES,
  PROJECT_GLANCE_ITEM_TYPES,
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceClientFrame,
  type ProjectGlanceCurrent,
  type ProjectGlanceErrorCode,
  type ProjectGlanceFeedItem,
  type ProjectGlanceFrame,
  type ProjectGlanceRuntimeDescriptor,
  type ProjectGlanceServerFrame,
  type ProjectGlanceSnapshot,
} from "./model.js";

export class ProjectGlanceValidationError extends Error {
  constructor(code = "INVALID_FRAME") {
    super(code);
    this.name = "ProjectGlanceValidationError";
  }
}

function sourceRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectGlanceValidationError();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  source: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new ProjectGlanceValidationError();
  }
  for (const key of required) {
    if (!Object.hasOwn(source, key)) throw new ProjectGlanceValidationError();
  }
}

function boundedString(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectGlanceValidationError();
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || /\p{Cc}/u.test(value)) {
    throw new ProjectGlanceValidationError();
  }
  if (
    /(?:^|[\s(])\/(?:home|Users|private|var)\//u.test(value) ||
    /[A-Za-z]:\\/u.test(value)
  ) {
    throw new ProjectGlanceValidationError();
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  return boundedString(source[key], maxBytes);
}

function boundedInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new ProjectGlanceValidationError();
  }
  return Number(value);
}

export function validateSessionKey(value: unknown): string {
  const sessionKey = boundedString(value, MAX_SESSION_KEY_BYTES);
  if (!/^[a-f0-9]{16,64}$/u.test(sessionKey)) {
    throw new ProjectGlanceValidationError();
  }
  return sessionKey;
}

function validateRequestId(value: unknown): string {
  return boundedString(value, MAX_REQUEST_ID_BYTES);
}

function validateGeneration(value: unknown): string {
  const generation = boundedString(value, MAX_GENERATION_BYTES);
  if (!/^[a-f0-9]{16,128}$/u.test(generation)) {
    throw new ProjectGlanceValidationError();
  }
  return generation;
}

function validateToken(value: unknown): string {
  const token = boundedString(value, MAX_TOKEN_BYTES);
  if (!/^[a-f0-9]{32,128}$/u.test(token)) {
    throw new ProjectGlanceValidationError();
  }
  return token;
}

function validateTimestamp(value: unknown): string {
  const timestamp = boundedString(value, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new ProjectGlanceValidationError();
  }
  return timestamp;
}

function validateCurrent(value: unknown): ProjectGlanceCurrent {
  const source = sourceRecord(value);
  exactKeys(source, [], ["step", "toward", "focus"]);
  const current: ProjectGlanceCurrent = {};
  const step = optionalString(source, "step", MAX_CURRENT_TEXT_BYTES);
  const toward = optionalString(source, "toward", MAX_CURRENT_TEXT_BYTES);
  const focus = optionalString(source, "focus", MAX_CURRENT_TEXT_BYTES);
  if (step !== undefined) current.step = step;
  if (toward !== undefined) current.toward = toward;
  if (focus !== undefined) current.focus = focus;
  return current;
}

function validateItem(value: unknown): ProjectGlanceFeedItem {
  const source = sourceRecord(value);
  exactKeys(source, ["id", "type", "text", "createdAt"]);
  const id = boundedString(source.id, MAX_ITEM_ID_BYTES);
  const type = boundedString(source.type, 64);
  if (!(PROJECT_GLANCE_ITEM_TYPES as readonly string[]).includes(type)) {
    throw new ProjectGlanceValidationError();
  }
  return {
    id,
    type: type as ProjectGlanceFeedItem["type"],
    text: boundedString(source.text, MAX_ITEM_TEXT_BYTES),
    createdAt: validateTimestamp(source.createdAt),
  };
}

export function validateSnapshot(value: unknown): ProjectGlanceSnapshot {
  const source = sourceRecord(value);
  exactKeys(source, [
    "protocolVersion",
    "sessionKey",
    "revision",
    "generatedAt",
    "current",
    "feed",
  ]);
  if (source.protocolVersion !== PROJECT_GLANCE_PROTOCOL_VERSION) {
    throw new ProjectGlanceValidationError();
  }
  const feedValue = source.feed;
  if (!Array.isArray(feedValue) || feedValue.length > MAX_FEED_ITEMS) {
    throw new ProjectGlanceValidationError();
  }
  const feed = feedValue.map(validateItem);
  const snapshot: ProjectGlanceSnapshot = {
    protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey: validateSessionKey(source.sessionKey),
    revision: boundedInteger(source.revision, Number.MAX_SAFE_INTEGER),
    generatedAt: validateTimestamp(source.generatedAt),
    current: validateCurrent(source.current),
    feed,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new ProjectGlanceValidationError();
  }
  return snapshot;
}

export function validateRuntimeDescriptor(
  value: unknown,
): ProjectGlanceRuntimeDescriptor {
  const source = sourceRecord(value);
  exactKeys(source, [
    "protocolVersion",
    "sessionKey",
    "socketPath",
    "token",
    "generation",
    "createdAt",
  ]);
  if (source.protocolVersion !== PROJECT_GLANCE_PROTOCOL_VERSION) {
    throw new ProjectGlanceValidationError();
  }
  const socketPath = boundedString(source.socketPath, 256);
  if (!socketPath.startsWith("/")) throw new ProjectGlanceValidationError();
  return {
    protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey: validateSessionKey(source.sessionKey),
    socketPath,
    token: validateToken(source.token),
    generation: validateGeneration(source.generation),
    createdAt: validateTimestamp(source.createdAt),
  };
}

export function validateClientFrame(value: unknown): ProjectGlanceClientFrame {
  const source = sourceRecord(value);
  const type = source.type;
  if (source.version !== PROJECT_GLANCE_PROTOCOL_VERSION || typeof type !== "string") {
    throw new ProjectGlanceValidationError();
  }
  if (type === "hello") {
    exactKeys(source, [
      "version",
      "type",
      "requestId",
      "sessionKey",
      "token",
      "generation",
    ]);
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      requestId: validateRequestId(source.requestId),
      sessionKey: validateSessionKey(source.sessionKey),
      token: validateToken(source.token),
      generation: validateGeneration(source.generation),
    };
  }
  if (type === "ping" || type === "snapshot_request") {
    exactKeys(source, ["version", "type", "requestId"]);
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      requestId: validateRequestId(source.requestId),
    };
  }
  throw new ProjectGlanceValidationError();
}

function validateErrorCode(value: unknown): ProjectGlanceErrorCode {
  const code = boundedString(value, 64);
  if (
    ![
      "invalid_frame",
      "authentication_required",
      "authentication_failed",
      "unsupported_request",
      "server_unavailable",
    ].includes(code)
  ) {
    throw new ProjectGlanceValidationError();
  }
  return code as ProjectGlanceErrorCode;
}

export function validateServerFrame(value: unknown): ProjectGlanceServerFrame {
  const source = sourceRecord(value);
  const type = source.type;
  if (source.version !== PROJECT_GLANCE_PROTOCOL_VERSION || typeof type !== "string") {
    throw new ProjectGlanceValidationError();
  }
  if (type === "hello") {
    exactKeys(source, [
      "version",
      "type",
      "requestId",
      "accepted",
      "sessionKey",
      "generation",
    ]);
    if (source.accepted !== true) throw new ProjectGlanceValidationError();
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      requestId: validateRequestId(source.requestId),
      accepted: true,
      sessionKey: validateSessionKey(source.sessionKey),
      generation: validateGeneration(source.generation),
    };
  }
  if (type === "snapshot") {
    exactKeys(source, ["version", "type", "snapshot"], ["requestId"]);
    const requestId = Object.hasOwn(source, "requestId")
      ? validateRequestId(source.requestId)
      : undefined;
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      ...(requestId === undefined ? {} : { requestId }),
      snapshot: validateSnapshot(source.snapshot),
    };
  }
  if (type === "pong") {
    exactKeys(source, ["version", "type", "requestId"]);
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      requestId: validateRequestId(source.requestId),
    };
  }
  if (type === "snapshot_changed") {
    exactKeys(source, ["version", "type", "revision"]);
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      revision: boundedInteger(source.revision, Number.MAX_SAFE_INTEGER),
    };
  }
  if (type === "error") {
    exactKeys(source, ["version", "type", "code", "message"], ["requestId"]);
    const requestId = Object.hasOwn(source, "requestId")
      ? validateRequestId(source.requestId)
      : undefined;
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      ...(requestId === undefined ? {} : { requestId }),
      code: validateErrorCode(source.code),
      message: boundedString(source.message, 512),
    };
  }
  throw new ProjectGlanceValidationError();
}

export function validateFrame(value: unknown): ProjectGlanceFrame {
  try {
    return validateClientFrame(value);
  } catch {
    return validateServerFrame(value);
  }
}
