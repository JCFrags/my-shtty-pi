import { SessionServiceError } from "./session-contract.ts";

export const DEFAULT_SESSION_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_SESSION_FRAME_DEPTH = 16;

export interface SessionReadyFrame {
  version: 1;
  requestId: string;
  generation: number;
  action: "ready";
  sequence: number;
  cwd: string;
}

export interface SessionCompleteFrame {
  version: 1;
  requestId: string;
  generation: number;
  action: "complete";
  sequence: number;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  fence: string;
}

export type SessionControlFrame = SessionReadyFrame | SessionCompleteFrame;

function objectDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return depth;
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return entries.reduce((maximum, entry) => Math.max(maximum, objectDepth(entry, depth + 1)), depth + 1);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new SessionServiceError("SESSION_FRAME_INVALID", `Unexpected session frame field: ${unexpected[0]}`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new SessionServiceError("SESSION_FRAME_INVALID", `Missing session frame field: ${key}`);
  }
}

export function validateSessionControlFrame(value: unknown): SessionControlFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionServiceError("SESSION_FRAME_INVALID", "Session control frame must be a JSON object");
  }
  if (objectDepth(value) > DEFAULT_SESSION_FRAME_DEPTH) {
    throw new SessionServiceError("SESSION_FRAME_INVALID", "Session control frame nesting is too deep");
  }
  const frame = value as Record<string, unknown>;
  if (frame.action === "ready") {
    assertExactKeys(frame, ["version", "requestId", "generation", "action", "sequence", "cwd"]);
  } else if (frame.action === "complete") {
    assertExactKeys(frame, ["version", "requestId", "generation", "action", "sequence", "cwd", "exitCode", "signal", "fence"]);
  } else {
    throw new SessionServiceError("SESSION_FRAME_INVALID", "Unknown session control action");
  }
  if (frame.version !== 1) throw new SessionServiceError("SESSION_FRAME_VERSION_UNSUPPORTED", "Unsupported session frame version");
  if (typeof frame.requestId !== "string" || !/^[a-f0-9]{16,64}$/.test(frame.requestId)) {
    throw new SessionServiceError("SESSION_FRAME_INVALID", "Invalid session frame request id");
  }
  if (!Number.isSafeInteger(frame.generation) || (frame.generation as number) < 1) {
    throw new SessionServiceError("SESSION_FRAME_INVALID", "Invalid session frame generation");
  }
  if (!Number.isSafeInteger(frame.sequence) || (frame.sequence as number) < 0) {
    throw new SessionServiceError("SESSION_FRAME_INVALID", "Invalid session frame sequence");
  }
  if (typeof frame.cwd !== "string" || frame.cwd.length === 0 || Buffer.byteLength(frame.cwd) > 16 * 1024) {
    throw new SessionServiceError("SESSION_FRAME_INVALID", "Invalid session frame working directory");
  }
  if (frame.action === "complete") {
    if (frame.exitCode !== null && (!Number.isSafeInteger(frame.exitCode) || (frame.exitCode as number) < 0 || (frame.exitCode as number) > 255)) {
      throw new SessionServiceError("SESSION_FRAME_INVALID", "Invalid session frame exit code");
    }
    if (frame.signal !== null && typeof frame.signal !== "string") {
      throw new SessionServiceError("SESSION_FRAME_INVALID", "Invalid session frame signal");
    }
    if (typeof frame.fence !== "string" || !/^[a-f0-9]{64}$/.test(frame.fence)) {
      throw new SessionServiceError("SESSION_FRAME_INVALID", "Invalid session stream fence");
    }
  }
  return frame as unknown as SessionControlFrame;
}

export function encodeSessionFrame(value: unknown, maxFrameBytes = DEFAULT_SESSION_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > maxFrameBytes) {
    throw new SessionServiceError("SESSION_FRAME_SIZE", `Session frame is ${body.length} bytes; maximum is ${maxFrameBytes}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class SessionFrameDecoder {
  private buffer = Buffer.alloc(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxFrameBytes = DEFAULT_SESSION_FRAME_BYTES) {}

  push(chunk: Buffer): SessionControlFrame[] {
    if (chunk.length > 0) this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: SessionControlFrame[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.maxFrameBytes) {
        throw new SessionServiceError("SESSION_FRAME_SIZE", `Invalid session frame length: ${length}`);
      }
      if (this.buffer.length < 4 + length) break;
      const bytes = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let text: string;
      try {
        text = this.decoder.decode(bytes);
      } catch (error) {
        throw new SessionServiceError("SESSION_FRAME_UTF8", "Session frame is not strict UTF-8", { cause: error });
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new SessionServiceError("SESSION_FRAME_JSON", "Session frame is not valid JSON", { cause: error });
      }
      frames.push(validateSessionControlFrame(value));
    }
    return frames;
  }

  finish(): void {
    if (this.buffer.length !== 0) {
      throw new SessionServiceError("SESSION_FRAME_TRUNCATED", `Session control channel ended with ${this.buffer.length} trailing bytes`);
    }
  }
}
