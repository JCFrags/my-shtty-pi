export const PROJECT_GLANCE_PRODUCT = "Pi Project Glance" as const;
export const PROJECT_GLANCE_PACKAGE = "pi-project-glance" as const;
export const PROJECT_GLANCE_COMMAND = "project-glance" as const;
export const PROJECT_GLANCE_PLUGIN_ID = "pi.project-glance" as const;
export const PROJECT_GLANCE_ENTRYPOINT = "glance" as const;
export const PROJECT_GLANCE_TITLE = "Project Glance" as const;
export const PROJECT_GLANCE_SECTION = "Progress Feed" as const;
export const PROJECT_GLANCE_TYPE_PREFIX = "ProjectGlance" as const;
export const PROJECT_GLANCE_EVENT_PREFIX = "pi-project-glance:" as const;
export const PROJECT_GLANCE_CUSTOM_ENTRY_PREFIX = "pi-project-glance/" as const;
export const PROJECT_GLANCE_RUNTIME_KEY = "pi-project-glance" as const;
export const PROJECT_GLANCE_DESCRIPTOR_ENV = "PI_PROJECT_GLANCE_DESCRIPTOR" as const;
export const PROJECT_GLANCE_EVENT_SNAPSHOT_CHANGED =
  `${PROJECT_GLANCE_EVENT_PREFIX}snapshot-changed` as const;

export const PROJECT_GLANCE_PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_SESSION_KEY_BYTES = 64;
export const MAX_GENERATION_BYTES = 128;
export const MAX_TOKEN_BYTES = 128;
export const MAX_ITEM_ID_BYTES = 128;
export const MAX_ITEM_TEXT_BYTES = 4 * 1024;
export const MAX_CURRENT_TEXT_BYTES = 512;
export const MAX_FEED_ITEMS = 50;
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

// Backslashes are valid request-ID bytes but each one expands to two bytes in
// JSON. This deliberately exercises the worst valid escaped request ID when
// deriving the correlated snapshot envelope overhead.
export const MAX_SNAPSHOT_REQUEST_ID = "\\".repeat(MAX_REQUEST_ID_BYTES);
export const MAX_SNAPSHOT_FRAME_OVERHEAD_BYTES =
  Buffer.byteLength(
    JSON.stringify({
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type: "snapshot",
      requestId: MAX_SNAPSHOT_REQUEST_ID,
      snapshot: null,
    }),
    "utf8",
  ) - Buffer.byteLength("null", "utf8");
export const MAX_SNAPSHOT_BYTES =
  MAX_FRAME_BYTES - MAX_SNAPSHOT_FRAME_OVERHEAD_BYTES;

export const PROJECT_GLANCE_ITEM_TYPES = [
  "assistant_update",
  "checkpoint",
  "milestone_completed",
] as const;
export type ProjectGlanceItemType = (typeof PROJECT_GLANCE_ITEM_TYPES)[number];

export interface ProjectGlanceCurrent {
  step?: string;
  toward?: string;
  focus?: string;
}

export interface ProjectGlanceFeedItem {
  id: string;
  type: ProjectGlanceItemType;
  text: string;
  createdAt: string;
}

export interface ProjectGlanceSnapshot {
  protocolVersion: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  sessionKey: string;
  revision: number;
  generatedAt: string;
  current: ProjectGlanceCurrent;
  feed: ProjectGlanceFeedItem[];
}

export interface ProjectGlanceHelloRequest {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "hello";
  requestId: string;
  sessionKey: string;
  token: string;
  generation: string;
}

export interface ProjectGlancePingRequest {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "ping";
  requestId: string;
}

export interface ProjectGlanceSnapshotRequest {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "snapshot_request";
  requestId: string;
}

export type ProjectGlanceClientFrame =
  | ProjectGlanceHelloRequest
  | ProjectGlancePingRequest
  | ProjectGlanceSnapshotRequest;

export interface ProjectGlanceHelloResponse {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "hello";
  requestId: string;
  accepted: true;
  sessionKey: string;
  generation: string;
}

export interface ProjectGlanceSnapshotFrame {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "snapshot";
  requestId?: string;
  snapshot: ProjectGlanceSnapshot;
}

export interface ProjectGlancePongResponse {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "pong";
  requestId: string;
}

export interface ProjectGlanceSnapshotChangedFrame {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "snapshot_changed";
  revision: number;
}

export type ProjectGlanceErrorCode =
  | "invalid_frame"
  | "authentication_required"
  | "authentication_failed"
  | "unsupported_request"
  | "server_unavailable";

export interface ProjectGlanceErrorFrame {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  type: "error";
  requestId?: string;
  code: ProjectGlanceErrorCode;
  message: string;
}

export type ProjectGlanceServerFrame =
  | ProjectGlanceHelloResponse
  | ProjectGlanceSnapshotFrame
  | ProjectGlancePongResponse
  | ProjectGlanceSnapshotChangedFrame
  | ProjectGlanceErrorFrame;

export type ProjectGlanceFrame =
  | ProjectGlanceClientFrame
  | ProjectGlanceServerFrame;

export interface ProjectGlanceRuntimeDescriptor {
  protocolVersion: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  sessionKey: string;
  socketPath: string;
  token: string;
  generation: string;
  createdAt: string;
}
