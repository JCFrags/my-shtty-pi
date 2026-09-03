import { MAX_FRAME_BYTES, type ProjectGlanceFrame } from "./model.js";

const HEADER_BYTES = 4;
const MAX_BUFFER_BYTES = HEADER_BYTES + MAX_FRAME_BYTES;

export class ProjectGlanceFrameError extends Error {
  constructor(code = "INVALID_FRAME") {
    super(code);
    this.name = "ProjectGlanceFrameError";
  }
}

export function encodeFrame(frame: ProjectGlanceFrame): Buffer {
  let payload: string;
  try {
    payload = JSON.stringify(frame);
  } catch {
    throw new ProjectGlanceFrameError();
  }
  const body = Buffer.from(payload, "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new ProjectGlanceFrameError("FRAME_TOO_LARGE");
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class ProjectGlanceFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    const next = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    if (next.length > MAX_BUFFER_BYTES) {
      throw new ProjectGlanceFrameError("FRAME_TOO_LARGE");
    }
    this.#buffer = next;
    const frames: unknown[] = [];
    while (this.#buffer.length >= HEADER_BYTES) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        throw new ProjectGlanceFrameError("FRAME_TOO_LARGE");
      }
      if (this.#buffer.length < HEADER_BYTES + length) break;
      const body = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      try {
        frames.push(JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        throw new ProjectGlanceFrameError();
      }
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.#buffer.length;
  }
}
