import { randomUUID } from "node:crypto";
import net from "node:net";
import { RUNTIME_IDENTITY, runtimeMatches } from "pixel-store";
import { commandError } from "./errors";

const MAX_CONTROL_HEADER_BYTES = 256 * 1024;
const MAX_CONTROL_BINARY_BYTES = 2 * 1024 * 1024;

export async function control(socketPath: string, request: Record<string, unknown>, timeoutMs = 10_000, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const hello = await requestControl(socketPath, { cmd: "hello" }, Math.min(timeoutMs, 2000), signal) as { key?: string; identity?: { instanceId?: string } };
  if (!runtimeMatches(hello?.identity) || typeof hello.identity?.instanceId !== "string") throw new Error("companion runtime mismatch; inspect doctor before explicit replacement");
  if (request.expectedRuntimeInstanceId !== undefined && request.expectedRuntimeInstanceId !== hello.identity.instanceId) throw new Error("browser runtime instance changed; reconnect explicitly");
  if (request.expectedBrowserSessionKey !== undefined && request.expectedBrowserSessionKey !== hello.key) throw new Error("browser session key changed; reconnect explicitly");
  return requestControl(socketPath, { ...request, expectedInstance: hello.identity.instanceId }, timeoutMs, signal);
}

function requestControl(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const id = randomUUID();
    const connection = net.connect(socketPath);
    let settled = false;
    const timer = setTimeout(() => fail(commandError("ACTION_OUTCOME_UNKNOWN", "control request timed out; inspect current state before any further action. Do not replay the request.")), timeoutMs);
    const abort = () => fail(signal?.reason ?? new Error("control request canceled"));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); connection.destroy(); };
    let buffer = Buffer.alloc(0);
    let header: {
      id?: string | null;
      ok: boolean;
      data?: unknown;
      error?: string;
      binaryBytes?: number;
    } | null = null;
    let binaryStart = 0;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    connection.on("error", fail);
    connection.on("close", () => fail(commandError("ACTION_OUTCOME_UNKNOWN", "browser disconnected before a complete response; inspect current state, do not replay")));
    connection.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (buffer.byteLength + chunk.byteLength > MAX_CONTROL_HEADER_BYTES + MAX_CONTROL_BINARY_BYTES + 1) { fail(new Error("control response is too large")); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (!header) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.byteLength > MAX_CONTROL_HEADER_BYTES) fail(new Error("control response header is too large"));
          return;
        }
        if (newline > MAX_CONTROL_HEADER_BYTES) {
          fail(new Error("control response header is too large"));
          return;
        }
        try {
          header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        } catch (error) {
          fail(error);
          return;
        }
        binaryStart = newline + 1;
        if (!header || typeof header !== "object") { fail(new Error("invalid control response header")); return; }
        if (!header.ok) {
          fail(new Error(header!.error ?? "control request failed"));
          return;
        }
        if (header!.id !== id) {
          fail(new Error("response id mismatch"));
          return;
        }
      }
      const response = header;
      if (!response) return;
      const binaryBytes = response.binaryBytes ?? 0;
      if (!Number.isSafeInteger(binaryBytes) || binaryBytes < 0 || binaryBytes > MAX_CONTROL_BINARY_BYTES) {
        fail(new Error("control response image is too large"));
        return;
      }
      if (buffer.byteLength - binaryStart < binaryBytes) return;
      settled = true;
      cleanup();
      if (binaryBytes > 0 && response.data && typeof response.data === "object") {
        const data = response.data as Record<string, unknown>;
        const visual = data.visual && typeof data.visual === "object"
          ? data.visual as Record<string, unknown>
          : {};
        resolve({
          ...data,
          visual: { ...visual, data: buffer.subarray(binaryStart, binaryStart + binaryBytes) },
        });
      } else {
        resolve(response.data);
      }
    });
    connection.write(`${JSON.stringify({ id, ...request, identity: RUNTIME_IDENTITY })}\n`);
  });
}
