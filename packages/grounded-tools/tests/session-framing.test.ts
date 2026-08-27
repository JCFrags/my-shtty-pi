import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeSessionFrame,
  SessionFrameDecoder,
  validateSessionControlFrame,
} from "@grounded/pi-core/session-framing";
import { SessionServiceError } from "@grounded/pi-core/session-contract";

const ready = {
  version: 1 as const,
  requestId: "0123456789abcdef",
  generation: 1,
  action: "ready" as const,
  sequence: 0,
  cwd: "/tmp",
};

const complete = {
  version: 1 as const,
  requestId: "fedcba9876543210",
  generation: 1,
  action: "complete" as const,
  sequence: 1,
  cwd: "/tmp/work",
  exitCode: 0,
  signal: null,
  fence: "a".repeat(64),
};

test("session framing decodes split and combined frames", () => {
  const bytes = Buffer.concat([encodeSessionFrame(ready), encodeSessionFrame(complete)]);
  const decoder = new SessionFrameDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(bytes.subarray(3, 11)), []);
  assert.deepEqual(decoder.push(bytes.subarray(11)), [ready, complete]);
  decoder.finish();
});

test("session framing rejects invalid length, UTF-8, JSON, and trailing bytes", () => {
  assert.throws(
    () => new SessionFrameDecoder(8).push(Buffer.from([0, 0, 0, 9])),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_FRAME_SIZE",
  );

  const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(
    () => new SessionFrameDecoder().push(invalidUtf8),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_FRAME_UTF8",
  );

  const invalidJsonBody = Buffer.from("{", "utf8");
  const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, invalidJsonBody.length]), invalidJsonBody]);
  assert.throws(
    () => new SessionFrameDecoder().push(invalidJson),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_FRAME_JSON",
  );

  const decoder = new SessionFrameDecoder();
  decoder.push(Buffer.from([0, 0]));
  assert.throws(
    () => decoder.finish(),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_FRAME_TRUNCATED",
  );
});

test("session control validation requires exact bounded identity fields", () => {
  assert.deepEqual(validateSessionControlFrame(ready), ready);
  assert.deepEqual(validateSessionControlFrame(complete), complete);
  assert.throws(() => validateSessionControlFrame({ ...ready, extra: true }), /Unexpected session frame field/);
  assert.throws(() => validateSessionControlFrame({ ...ready, generation: 0 }), /generation/);
  assert.throws(() => validateSessionControlFrame({ ...complete, fence: "short" }), /fence/);
  assert.throws(() => validateSessionControlFrame({ ...complete, exitCode: 999 }), /exit code/);
});

test("session framing bounds encoded bodies", () => {
  assert.throws(
    () => encodeSessionFrame(ready, 8),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_FRAME_SIZE",
  );
});
