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
  MAX_UNIX_SOCKET_PATH_BYTES,
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
import { validateQuestionAction, validateQuestions, validateQuestionAttention } from "./question-validation.js";
import { assertSnapshotFrameBudget } from "./framing.js";
import { projectFeedText, validateProjectionText } from "./projection-text.js";

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

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectGlanceValidationError();
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || /\p{Cc}/u.test(value)) {
    throw new ProjectGlanceValidationError();
  }
  return value;
}

function displayText(value: unknown, maxBytes: number): string {
  const text = validateProjectionText(value, maxBytes);
  if (text === undefined) throw new ProjectGlanceValidationError();
  return text;
}

function filesystemPath(value: unknown, maxBytes: number): string {
  const path = boundedText(value, maxBytes);
  if (!path.startsWith("/") || path.endsWith("/") || /\\/u.test(path)) {
    throw new ProjectGlanceValidationError();
  }
  return path;
}

function optionalDisplayText(
  source: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  try {
    return displayText(source[key], maxBytes);
  } catch {
    return undefined;
  }
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ProjectGlanceValidationError();
  return Number(value);
}

function historyView(value: unknown): "inbox" | "history" {
  if (value !== "inbox" && value !== "history") throw new ProjectGlanceValidationError();
  return value;
}

function bodyText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum ||
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|[\uD800-\uDFFF]/u.test(value)) throw new ProjectGlanceValidationError();
  return value;
}

function validateArchive(value: unknown): NonNullable<ProjectGlanceSnapshot["archive"]> {
  const source = sourceRecord(value);
  exactKeys(source, ["inboxCount", "historyCount", "commitSeq", "state"], ["errorCode"]);
  if (!["ready", "importing", "error"].includes(String(source.state))) throw new ProjectGlanceValidationError();
  const errorCode = source.errorCode === undefined ? undefined : boundedText(source.errorCode, 96);
  if (errorCode !== undefined && !/^[a-z0-9_-]+$/u.test(errorCode)) throw new ProjectGlanceValidationError();
  return { inboxCount: nonnegativeInteger(source.inboxCount), historyCount: nonnegativeInteger(source.historyCount),
    commitSeq: nonnegativeInteger(source.commitSeq), state: source.state as "ready" | "importing" | "error",
    ...(errorCode === undefined ? {} : { errorCode }) };
}

function boundedInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new ProjectGlanceValidationError();
  }
  return Number(value);
}

export function validateSessionKey(value: unknown): string {
  const sessionKey = boundedText(value, MAX_SESSION_KEY_BYTES);
  if (!/^[a-f0-9]{16,64}$/u.test(sessionKey)) {
    throw new ProjectGlanceValidationError();
  }
  return sessionKey;
}

function validateRequestId(value: unknown): string {
  return boundedText(value, MAX_REQUEST_ID_BYTES);
}

export function validateGeneration(value: unknown): string {
  const generation = boundedText(value, MAX_GENERATION_BYTES);
  if (!/^[a-f0-9]{16,128}$/u.test(generation)) {
    throw new ProjectGlanceValidationError();
  }
  return generation;
}

export function validateToken(value: unknown): string {
  const token = boundedText(value, MAX_TOKEN_BYTES);
  if (!/^[a-f0-9]{32,128}$/u.test(token)) {
    throw new ProjectGlanceValidationError();
  }
  return token;
}

function validateTimestamp(value: unknown): string {
  const timestamp = boundedText(value, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new ProjectGlanceValidationError();
  }
  return timestamp;
}

function validateCurrent(value: unknown): ProjectGlanceCurrent {
  const source = sourceRecord(value);
  exactKeys(source, [], ["step", "toward", "focus"]);
  const current: ProjectGlanceCurrent = {};
  const step = optionalDisplayText(source, "step", MAX_CURRENT_TEXT_BYTES);
  const toward = optionalDisplayText(source, "toward", MAX_CURRENT_TEXT_BYTES);
  const focus = optionalDisplayText(source, "focus", MAX_CURRENT_TEXT_BYTES);
  if (step !== undefined) current.step = step;
  if (toward !== undefined) current.toward = toward;
  if (focus !== undefined) current.focus = focus;
  return current;
}

function validateItem(value: unknown): ProjectGlanceFeedItem {
  const source = sourceRecord(value);
  exactKeys(source, ["id", "type", "text", "createdAt"]);
  const id = boundedText(source.id, MAX_ITEM_ID_BYTES);
  const type = boundedText(source.type, 64);
  if (!(PROJECT_GLANCE_ITEM_TYPES as readonly string[]).includes(type)) {
    throw new ProjectGlanceValidationError();
  }
  return {
    id,
    type: type as ProjectGlanceFeedItem["type"],
    text: (() => {
      if (typeof source.text !== "string" || Buffer.byteLength(source.text, "utf8") > MAX_ITEM_TEXT_BYTES) throw new ProjectGlanceValidationError();
      const text = projectFeedText(source.text, MAX_ITEM_TEXT_BYTES);
      if (!text) throw new ProjectGlanceValidationError();
      return text;
    })(),
    createdAt: validateTimestamp(source.createdAt),
  };
}

export function validateSnapshot(value: unknown): ProjectGlanceSnapshot {
  const source = sourceRecord(value);
  exactKeys(source, ["protocolVersion", "sessionKey", "revision", "generatedAt", "current", "feed"], ["branchId", "uiState", "focusSerial", "questions", "questionAttention", "archive"]);
  if (source.protocolVersion !== PROJECT_GLANCE_PROTOCOL_VERSION) {
    throw new ProjectGlanceValidationError();
  }
  const feedValue = source.feed;
  if (!Array.isArray(feedValue) || feedValue.length > MAX_FEED_ITEMS) {
    throw new ProjectGlanceValidationError();
  }
  const feed = feedValue.map(validateItem);
  const branchId = source.branchId === undefined ? undefined : boundedText(source.branchId, MAX_ITEM_ID_BYTES);
  let uiState: ProjectGlanceSnapshot["uiState"];
  if (source.uiState !== undefined) {
    const state = sourceRecord(source.uiState);
    exactKeys(state, ["dismissedIds", "readIds"]);
    if (!Array.isArray(state.dismissedIds) || !Array.isArray(state.readIds) || state.dismissedIds.length > MAX_FEED_ITEMS || state.readIds.length > MAX_FEED_ITEMS) throw new ProjectGlanceValidationError();
    uiState = { dismissedIds: state.dismissedIds.map((id) => boundedText(id, MAX_ITEM_ID_BYTES)), readIds: state.readIds.map((id) => boundedText(id, MAX_ITEM_ID_BYTES)) };
  }
  const snapshot: ProjectGlanceSnapshot = {
    protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION, sessionKey: validateSessionKey(source.sessionKey), revision: boundedInteger(source.revision, Number.MAX_SAFE_INTEGER), generatedAt: validateTimestamp(source.generatedAt),
    ...(branchId ? { branchId } : {}), current: validateCurrent(source.current), feed, ...(uiState ? { uiState } : {}),
    ...(source.focusSerial === undefined ? {} : { focusSerial: boundedInteger(source.focusSerial, Number.MAX_SAFE_INTEGER) }),
    ...(source.questions === undefined ? {} : { questions: validateQuestions(source.questions) }),
    ...(source.questionAttention === undefined ? {} : { questionAttention: validateQuestionAttention(source.questionAttention) }),
    ...(source.archive === undefined ? {} : { archive: validateArchive(source.archive) }),
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (payloadBytes > MAX_SNAPSHOT_BYTES) {
    throw new ProjectGlanceValidationError();
  }
  try {
    assertSnapshotFrameBudget(snapshot);
  } catch {
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
  const socketPath = filesystemPath(source.socketPath, MAX_UNIX_SOCKET_PATH_BYTES);
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
  if (type === "page_request" || type === "body_request" || type === "question_editing") {
    const base = ["version", "type", "requestId", "sessionKey", "generation", "branchId"];
    exactKeys(source, [...base, ...(type === "page_request" ? ["view"] : type === "body_request" ? ["itemId", "offset"] : ["questionId", "revision", "active"])], type === "page_request" ? ["cursor"] : []);
    const identity = { version: PROJECT_GLANCE_PROTOCOL_VERSION, requestId: validateRequestId(source.requestId),
      sessionKey: validateSessionKey(source.sessionKey), generation: validateGeneration(source.generation),
      branchId: boundedText(source.branchId, MAX_ITEM_ID_BYTES) };
    if (type === "page_request") return { ...identity, type, view: historyView(source.view),
      ...(source.cursor === undefined ? {} : { cursor: boundedText(source.cursor, 512) }) };
    if (type === "body_request") return { ...identity, type, itemId: boundedText(source.itemId, MAX_ITEM_ID_BYTES), offset: nonnegativeInteger(source.offset) };
    if (typeof source.active !== "boolean") throw new ProjectGlanceValidationError();
    return { ...identity, type, questionId: boundedText(source.questionId, MAX_ITEM_ID_BYTES), revision: boundedInteger(source.revision, Number.MAX_SAFE_INTEGER), active: source.active };
  }
  if (type === "action") {
    exactKeys(source, [
      "version",
      "type",
      "requestId",
      "actionId",
      "sessionKey",
      "generation",
      "branchId",
      "baseRevision",
      "action",
    ]);
    const action = sourceRecord(source.action);
    if (typeof action.type === "string" && action.type.startsWith("question_")) {
      return {
        version: PROJECT_GLANCE_PROTOCOL_VERSION, type,
        requestId: validateRequestId(source.requestId), actionId: validateRequestId(source.actionId),
        sessionKey: validateSessionKey(source.sessionKey), generation: validateGeneration(source.generation),
        branchId: boundedText(source.branchId, MAX_ITEM_ID_BYTES),
        baseRevision: boundedInteger(source.baseRevision, Number.MAX_SAFE_INTEGER),
        action: validateQuestionAction(action),
      };
    }
    exactKeys(action, ["type"], ["itemId"]);
    if (
      action.type !== "mark_read" &&
      action.type !== "dismiss" &&
      action.type !== "focus"
    ) {
      throw new ProjectGlanceValidationError();
    }
    if (
      (action.type === "focus" && action.itemId !== undefined) ||
      (action.type !== "focus" && action.itemId === undefined)
    ) {
      throw new ProjectGlanceValidationError();
    }
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      requestId: validateRequestId(source.requestId),
      actionId: validateRequestId(source.actionId),
      sessionKey: validateSessionKey(source.sessionKey),
      generation: validateGeneration(source.generation),
      branchId: boundedText(source.branchId, MAX_ITEM_ID_BYTES),
      baseRevision: boundedInteger(source.baseRevision, Number.MAX_SAFE_INTEGER),
      action: {
        type: action.type,
        ...(action.itemId === undefined
          ? {}
          : { itemId: boundedText(action.itemId, MAX_ITEM_ID_BYTES) }),
      },
    };
  }
  throw new ProjectGlanceValidationError();
}

function validateErrorCode(value: unknown): ProjectGlanceErrorCode {
  const code = boundedText(value, 64);
  if (
    ![
      "invalid_frame",
      "authentication_required",
      "authentication_failed",
      "unsupported_request",
      "server_unavailable",
      "stale_action",
      "replayed_action",
      "invalid_action",
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
  if (type === "page") {
    exactKeys(source, ["version", "type", "requestId", "branchId", "view", "snapshotSeq", "items"], ["nextCursor", "previousCursor"]);
    if (!Array.isArray(source.items) || source.items.length > 25) throw new ProjectGlanceValidationError();
    const ids = new Set<string>();
    const items = source.items.map((value) => {
      const item = sourceRecord(value);
      exactKeys(item, ["itemId", "type", "preview", "createdAt", "bodyBytes"], ["archivedAt"]);
      const itemId = boundedText(item.itemId, MAX_ITEM_ID_BYTES);
      if (ids.has(itemId) || !(PROJECT_GLANCE_ITEM_TYPES as readonly unknown[]).includes(item.type)) throw new ProjectGlanceValidationError();
      ids.add(itemId);
      return { itemId, type: item.type as ProjectGlanceFeedItem["type"], preview: bodyText(item.preview, 1024),
        createdAt: validateTimestamp(item.createdAt), bodyBytes: nonnegativeInteger(item.bodyBytes),
        ...(item.archivedAt === undefined ? {} : { archivedAt: validateTimestamp(item.archivedAt) }) };
    });
    return { version: PROJECT_GLANCE_PROTOCOL_VERSION, type, requestId: validateRequestId(source.requestId),
      branchId: boundedText(source.branchId, MAX_ITEM_ID_BYTES), view: historyView(source.view), snapshotSeq: nonnegativeInteger(source.snapshotSeq), items,
      ...(source.nextCursor === undefined ? {} : { nextCursor: boundedText(source.nextCursor, 512) }),
      ...(source.previousCursor === undefined ? {} : { previousCursor: boundedText(source.previousCursor, 512) }) };
  }
  if (type === "body") {
    exactKeys(source, ["version", "type", "requestId", "branchId", "itemId", "offset", "text", "totalBytes", "bodyDigest"], ["nextOffset", "previousOffset"]);
    const offset = nonnegativeInteger(source.offset), totalBytes = nonnegativeInteger(source.totalBytes);
    const text = bodyText(source.text, 24 * 1024), end = offset + Buffer.byteLength(text, "utf8");
    const nextOffset = source.nextOffset === undefined ? undefined : nonnegativeInteger(source.nextOffset);
    const previousOffset = source.previousOffset === undefined ? undefined : nonnegativeInteger(source.previousOffset);
    if (previousOffset !== undefined && previousOffset >= offset) throw new ProjectGlanceValidationError();
    const bodyDigest = boundedText(source.bodyDigest, 64);
    if (!/^[a-f0-9]{64}$/u.test(bodyDigest) || end > totalBytes ||
        (nextOffset === undefined ? end !== totalBytes : nextOffset !== end || end >= totalBytes || end <= offset)) throw new ProjectGlanceValidationError();
    return { version: PROJECT_GLANCE_PROTOCOL_VERSION, type, requestId: validateRequestId(source.requestId),
      branchId: boundedText(source.branchId, MAX_ITEM_ID_BYTES), itemId: boundedText(source.itemId, MAX_ITEM_ID_BYTES),
      offset, text, totalBytes, bodyDigest, ...(nextOffset === undefined ? {} : { nextOffset }), ...(previousOffset === undefined ? {} : { previousOffset }) };
  }
  if (type === "pong") {
    exactKeys(source, ["version", "type", "requestId"]);
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      requestId: validateRequestId(source.requestId),
    };
  }
  if (type === "action_result") {
    exactKeys(source, [
      "version",
      "type",
      "requestId",
      "actionId",
      "accepted",
      "revision",
    ]);
    if (source.accepted !== true) throw new ProjectGlanceValidationError();
    return {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type,
      requestId: validateRequestId(source.requestId),
      actionId: validateRequestId(source.actionId),
      accepted: true,
      revision: boundedInteger(source.revision, Number.MAX_SAFE_INTEGER),
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
      message: displayText(source.message, 512),
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
