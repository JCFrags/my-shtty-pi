import {
  MAX_FRAME_BYTES,
  MAX_SNAPSHOT_FRAME_OVERHEAD_BYTES,
  MAX_SNAPSHOT_REQUEST_ID,
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceFrame,
  type ProjectGlanceSnapshot,
} from "./model.js";

export const FRAME_HEADER_BYTES = 4;
export const MAX_RETAINED_FRAME_BYTES = FRAME_HEADER_BYTES + MAX_FRAME_BYTES;
export const MAX_FRAMES_PER_PUSH = 4_096;

export class ProjectGlanceFrameError extends Error {
  constructor(code = "INVALID_FRAME") {
    super(code);
    this.name = "ProjectGlanceFrameError";
  }
}

function serializedBody(value: unknown): Buffer {
  let payload: string | undefined;
  try {
    payload = JSON.stringify(value);
  } catch {
    throw new ProjectGlanceFrameError();
  }
  if (typeof payload !== "string") throw new ProjectGlanceFrameError();
  return Buffer.from(payload, "utf8");
}

export function snapshotFrameBodyBytes(
  snapshot: ProjectGlanceSnapshot,
  requestId?: string,
): number {
  if (requestId === undefined) {
    return (
      Buffer.byteLength(
        JSON.stringify({
          version: PROJECT_GLANCE_PROTOCOL_VERSION,
          type: "snapshot",
          snapshot,
        }),
        "utf8",
      )
    );
  }
  return Buffer.byteLength(
    JSON.stringify({
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      type: "snapshot",
      requestId,
      snapshot,
    }),
    "utf8",
  );
}

export function assertSnapshotFrameBudget(snapshot: ProjectGlanceSnapshot): void {
  const payloadBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (payloadBytes > MAX_FRAME_BYTES - MAX_SNAPSHOT_FRAME_OVERHEAD_BYTES) {
    throw new ProjectGlanceFrameError("SNAPSHOT_TOO_LARGE");
  }
  if (
    snapshotFrameBodyBytes(snapshot) > MAX_FRAME_BYTES ||
    snapshotFrameBodyBytes(snapshot, MAX_SNAPSHOT_REQUEST_ID) > MAX_FRAME_BYTES
  ) {
    throw new ProjectGlanceFrameError("SNAPSHOT_TOO_LARGE");
  }
}

export function encodeFrame(frame: ProjectGlanceFrame): Buffer {
  const body = serializedBody(frame);
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new ProjectGlanceFrameError("FRAME_TOO_LARGE");
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Streaming decoder. `push` returns every complete JSON value found in the
 * supplied chunk and retains at most one incomplete frame (header plus body).
 */
export class ProjectGlanceFrameDecoder {
  #header = Buffer.alloc(FRAME_HEADER_BYTES);
  #headerBytes = 0;
  #body: Buffer | undefined;
  #bodyBytes = 0;

  push(chunk: Uint8Array): unknown[] {
    if (!(chunk instanceof Uint8Array)) {
      throw new ProjectGlanceFrameError();
    }
    if (chunk.byteLength === 0) return [];
    const input = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: unknown[] = [];
    let offset = 0;

    while (offset < input.length) {
      if (!this.#body) {
        const headerNeeded = FRAME_HEADER_BYTES - this.#headerBytes;
        const available = input.length - offset;
        if (available < headerNeeded) {
          input.copy(this.#header, this.#headerBytes, offset);
          this.#headerBytes += available;
          offset = input.length;
          break;
        }
        input.copy(this.#header, this.#headerBytes, offset, offset + headerNeeded);
        this.#headerBytes = FRAME_HEADER_BYTES;
        offset += headerNeeded;
        const length = this.#header.readUInt32BE(0);
        if (length === 0) {
          throw new ProjectGlanceFrameError("INVALID_FRAME");
        }
        if (length > MAX_FRAME_BYTES) {
          throw new ProjectGlanceFrameError("FRAME_TOO_LARGE");
        }
        this.#body = Buffer.alloc(length);
        this.#bodyBytes = 0;
        this.#headerBytes = 0;
      }

      const remaining = this.#body.length - this.#bodyBytes;
      const available = input.length - offset;
      const take = Math.min(remaining, available);
      input.copy(this.#body, this.#bodyBytes, offset, offset + take);
      this.#bodyBytes += take;
      offset += take;
      if (this.#bodyBytes < this.#body.length) break;

      const body = this.#body;
      this.#body = undefined;
      this.#bodyBytes = 0;
      try {
        frames.push(JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        throw new ProjectGlanceFrameError();
      }
      if (frames.length >= MAX_FRAMES_PER_PUSH && offset < input.length) {
        throw new ProjectGlanceFrameError("TOO_MANY_FRAMES");
      }
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.#headerBytes + this.#bodyBytes;
  }
}
