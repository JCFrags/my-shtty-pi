import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ToolInvocationAuditStore,
  type ToolAuditActor,
} from "../../src/audit/tool-invocation-store.js";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";

const actor: ToolAuditActor = {
  principalId: "prn_parent",
  kind: "pi_parent",
  agentId: "agt_parent",
  piSessionId: "pi_session",
};

function start(
  toolCallId: string,
  input: unknown,
  observedAt = "2026-01-01T00:00:00.000Z",
) {
  const encoded = canonicalJson(input);
  return {
    phase: "started" as const,
    observedAt,
    toolCallId,
    toolName: "orchestrate",
    input,
    inputBytes: Buffer.byteLength(encoded, "utf8"),
    inputSha256: sha256(encoded),
  };
}

function completed(
  toolCallId: string,
  status: "succeeded" | "failed" | "cancelled",
  observedAt = "2026-01-01T00:00:01.000Z",
) {
  return {
    phase: "completed" as const,
    observedAt,
    toolCallId,
    toolName: "orchestrate",
    status,
    durationMs: 1_000,
    ...(status === "failed"
      ? { errorCode: "INVALID_REQUEST", errorMessage: "The call failed." }
      : {}),
  };
}

test("tool audit stores exact input, correlates completion, filters, and deduplicates replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-audit-store-"));
  const path = join(root, "audit.jsonl");
  const store = new ToolInvocationAuditStore(path);
  try {
    await store.open();
    const smallEncoded = canonicalJson({ action: "list" });
    for (const invalidOmission of [
      {
        input: { action: "list" },
        inputBytes: Buffer.byteLength(smallEncoded, "utf8"),
        inputSha256: sha256(smallEncoded),
        inputOmitted: false,
      },
      {
        inputBytes: 42,
        inputSha256: sha256("omitted"),
        inputOmitted: true,
      },
    ])
      await assert.rejects(
        store.append(actor, {
          phase: "started",
          observedAt: "2026-01-01T00:00:00.000Z",
          toolCallId: "call_invalid_omission",
          toolName: "orchestrate",
          ...invalidOmission,
        } as never),
        (error: unknown) =>
          (error as { code?: string }).code === "INVALID_REQUEST",
      );
    const input = {
      action: "run",
      task: { title: "Canary", objective: "Return exactly OK." },
    };
    const first = await store.append(actor, start("call_1", input));
    assert.equal(first.stored, true);
    const replay = await store.append(actor, start("call_1", input));
    assert.deepEqual(replay, {
      stored: false,
      invocationId: first.invocationId,
    });
    await assert.rejects(
      store.append(actor, start("call_1", { action: "run", changed: true })),
      (error: unknown) =>
        (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
    await store.append(actor, completed("call_1", "succeeded"));

    const summaries = await store.list({ action: "run", status: "succeeded" });
    assert.equal(summaries.length, 1);
    assert.equal(Object.hasOwn(summaries[0]!, "input"), false);
    assert.equal(summaries[0]!.status, "succeeded");
    assert.equal(summaries[0]!.durationMs, 1_000);

    const full = await store.get(first.invocationId);
    assert.deepEqual(full?.input, input);
    assert.equal(full?.inputSha256, sha256(canonicalJson(input)));
    assert.equal(full?.status, "succeeded");

    const stats = await store.stats({ groupBy: ["action", "status"] });
    assert.equal(stats.total, 1);
    assert.equal(stats.incomplete, 0);
    assert.deepEqual(stats.groups, [
      { key: { action: "run", status: "succeeded" }, count: 1 },
    ]);

    const verification = await store.verify();
    assert.equal(verification.valid, true);
    assert.equal(verification.records, 2);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool audit preserves an explicit non-canonical input marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-audit-unavailable-"));
  const path = join(root, "audit.jsonl");
  const store = new ToolInvocationAuditStore(path);
  try {
    await store.open();
    const started = await store.append(actor, {
      phase: "started",
      observedAt: "2026-01-01T00:00:00.000Z",
      toolCallId: "call_missing_args",
      toolName: "orchestrate",
      inputUnavailable: "non_canonical",
    });
    await store.append(actor, completed("call_missing_args", "failed"));
    const full = await store.get(started.invocationId);
    assert.equal(full?.inputUnavailable, "non_canonical");
    assert.equal(Object.hasOwn(full ?? {}, "input"), false);
    assert.equal(Object.hasOwn(full ?? {}, "inputSha256"), false);
    assert.equal((await store.verify()).valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool audit appends parallel invocations safely and rotates to a bounded chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-audit-rotate-"));
  const path = join(root, "audit.jsonl");
  const store = new ToolInvocationAuditStore(path, {
    maxSegmentBytes: 4_096,
    maxSegments: 2,
  });
  try {
    await store.open();
    await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        const call = `parallel_${index}`;
        const timestamp = new Date(
          Date.UTC(2026, 0, 1, 0, 0, index),
        ).toISOString();
        await store.append(
          actor,
          start(call, { action: "inspect", value: "x".repeat(120) }, timestamp),
        );
        await store.append(
          actor,
          completed(
            call,
            index % 3 === 0 ? "failed" : "succeeded",
            new Date(Date.parse(timestamp) + 10).toISOString(),
          ),
        );
      }),
    );
    const verification = await store.verify();
    assert.equal(verification.valid, true);
    assert.equal(verification.segments <= 2, true);
    assert.equal(verification.maxRetainedBytes, 8_192);
    assert.equal(verification.records > 0, true);
    assert.equal(verification.truncatedPrefix, true);
    assert.equal(
      (await Promise.all([lstat(path), lstat(`${path}.1`)])).every(
        (value) => (value.mode & 0o777) === 0o600,
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool audit becomes unavailable without rewriting a corrupt chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-audit-corrupt-"));
  const path = join(root, "audit.jsonl");
  try {
    await writeFile(path, '{"bad":true}\n', { mode: 0o600 });
    const before = await readFile(path, "utf8");
    const store = new ToolInvocationAuditStore(path);
    await store.open();
    assert.equal(store.available, false);
    await assert.rejects(
      store.append(actor, start("call_corrupt", { action: "run" })),
      (error: unknown) =>
        (error as { code?: string }).code === "AUDIT_UNAVAILABLE",
    );
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
