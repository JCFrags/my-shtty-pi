import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ToolAuditReporter,
  toolAuditSpoolPath,
} from "../../src/pi/tool-audit-reporter.js";

interface RequestRecord {
  method: string;
  params: Record<string, unknown>;
}

function client(
  requests: RequestRecord[],
  behavior: () => Promise<unknown> = async () => ({ stored: true }),
) {
  return {
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params: structuredClone(params) });
      return behavior();
    },
  };
}

async function withStateRoot(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tool-audit-reporter-"));
  const previous = process.env.PI_HERDR_ORCH_STATE_ROOT;
  process.env.PI_HERDR_ORCH_STATE_ROOT = root;
  try {
    await callback(root);
  } finally {
    if (previous === undefined) delete process.env.PI_HERDR_ORCH_STATE_ROOT;
    else process.env.PI_HERDR_ORCH_STATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("tool reporter captures exact orchestration input and only bounded completion metadata", async () => {
  await withStateRoot(async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const requests: RequestRecord[] = [];
    const reporter = new ToolAuditReporter({ now: () => now });
    await reporter.configure("session", "pi_session");
    reporter.bind(client(requests) as never);

    const args = {
      action: "run",
      task: { title: "Canary", objective: "Return exactly OK." },
    };
    await reporter.captureStart({
      toolCallId: "call_1",
      toolName: "orchestrate",
      args,
    });
    now += 25;
    await reporter.captureEnd({
      toolCallId: "call_1",
      toolName: "orchestrate",
      isError: false,
      result: {
        content: [{ type: "text", text: "SECRET_SUCCESS_PAYLOAD" }],
        details: { transcript: "must not be retained" },
      },
    });
    await reporter.captureStart({
      toolCallId: "ignored",
      toolName: "read",
      args: { path: "/tmp/file" },
    });
    await reporter.flush();

    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.method, "tool_audit.ingest");
    assert.deepEqual(requests[0]!.params.input, args);
    assert.equal(requests[0]!.params.phase, "started");
    assert.deepEqual(requests[1]!.params, {
      phase: "completed",
      observedAt: "2026-01-01T00:00:00.025Z",
      toolCallId: "call_1",
      toolName: "orchestrate",
      status: "succeeded",
      durationMs: 25,
    });
    assert.equal(
      JSON.stringify(requests).includes("SECRET_SUCCESS_PAYLOAD"),
      false,
    );
    assert.equal(JSON.stringify(requests).includes("transcript"), false);
  });
});

test("tool reporter marks non-canonical input without misrepresenting it as null", async () => {
  await withStateRoot(async () => {
    const requests: RequestRecord[] = [];
    const reporter = new ToolAuditReporter();
    await reporter.configure("session", "pi_session");
    reporter.bind(client(requests) as never);

    await reporter.captureStart({
      toolCallId: "call_missing_args",
      toolName: "orchestrate",
    });
    await reporter.captureEnd({
      toolCallId: "call_missing_args",
      toolName: "orchestrate",
      isError: true,
      result: {
        content: [{ type: "text", text: "INVALID_REQUEST: args are missing" }],
      },
    });
    await reporter.flush();

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]!.params, {
      phase: "started",
      observedAt: requests[0]!.params.observedAt,
      toolCallId: "call_missing_args",
      toolName: "orchestrate",
      inputUnavailable: "non_canonical",
    });
    assert.equal(Object.hasOwn(requests[0]!.params, "input"), false);
    assert.equal(Object.hasOwn(requests[0]!.params, "inputSha256"), false);
  });
});

test("tool reporter spools broker failure and replays phases once in order", async () => {
  await withStateRoot(async () => {
    const gaps: string[] = [];
    const failedRequests: RequestRecord[] = [];
    const reporter = new ToolAuditReporter({
      onGap: (message) => gaps.push(message),
    });
    await reporter.configure("session", "pi_session");
    reporter.bind(
      client(failedRequests, async () => {
        throw new Error("BROKER_OFFLINE");
      }) as never,
    );
    await reporter.captureStart({
      toolCallId: "call_spooled",
      toolName: "orchestrator_result",
      args: { taskId: "tsk_1", summary: "bounded" },
    });
    await reporter.captureEnd({
      toolCallId: "call_spooled",
      toolName: "orchestrator_result",
      isError: true,
      result: {
        content: [
          {
            type: "text",
            text: "INVALID_REQUEST: result contract did not match",
          },
        ],
      },
    });
    const path = toolAuditSpoolPath("session", "pi_session");
    const spooled = JSON.parse(await readFile(path, "utf8")) as unknown[];
    assert.equal(spooled.length, 2);
    assert.equal(gaps.length, 0);

    const replayed: RequestRecord[] = [];
    reporter.bind(client(replayed) as never);
    await reporter.captureStart({
      toolCallId: "call_after_reconnect",
      toolName: "orchestrate",
      args: { action: "list" },
    });
    await reporter.flush();
    assert.deepEqual(
      replayed.map((item) => [item.params.toolCallId, item.params.phase]),
      [
        ["call_spooled", "started"],
        ["call_spooled", "completed"],
        ["call_after_reconnect", "started"],
      ],
    );
    assert.equal(replayed[1]!.params.status, "failed");
    assert.equal(replayed[1]!.params.errorCode, "INVALID_REQUEST");
    assert.equal(
      await stat(path).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

test("tool reporter preserves a corrupt spool and reports a gap without overwriting it", async () => {
  await withStateRoot(async () => {
    const path = toolAuditSpoolPath("session", "pi_session");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const corrupt = '[{"phase":"started","extra":"changed"}]\n';
    await writeFile(path, corrupt, { mode: 0o600 });
    const gaps: string[] = [];
    const reporter = new ToolAuditReporter({
      onGap: (message) => gaps.push(message),
    });
    await assert.rejects(reporter.configure("session", "pi_session"));
    await reporter.captureStart({
      toolCallId: "call_after_corruption",
      toolName: "orchestrate",
      args: { action: "list" },
    });
    assert.equal(await readFile(path, "utf8"), corrupt);
    assert.equal(gaps.length, 1);
  });
});

test("tool reporter persists a new start without waiting for a stalled broker", async () => {
  await withStateRoot(async () => {
    const reporter = new ToolAuditReporter();
    await reporter.configure("session", "pi_session");
    reporter.bind({
      connected: true,
      request: () => new Promise<never>(() => undefined),
    } as never);
    await Promise.race([
      reporter.captureStart({
        toolCallId: "call_stalled",
        toolName: "orchestrate",
        args: { action: "list" },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("capture waited for the broker")),
          100,
        ),
      ),
    ]);
    const queued = JSON.parse(
      await readFile(toolAuditSpoolPath("session", "pi_session"), "utf8"),
    ) as unknown[];
    assert.equal(queued.length, 1);
    reporter.unbind();
  });
});

test("tool reporter marks oversized input and graceful interruption without leaking payload", async () => {
  await withStateRoot(async () => {
    const requests: RequestRecord[] = [];
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const reporter = new ToolAuditReporter({ now: () => now });
    await reporter.configure("session", "pi_session");
    reporter.bind(client(requests) as never);
    await reporter.captureStart({
      toolCallId: "call_large",
      toolName: "orchestrate",
      args: { action: "run", objective: "x".repeat(300_000) },
    });
    now += 10;
    await reporter.interrupt("quit");

    const start = requests[0]!.params;
    assert.equal(start.inputOmitted, true);
    assert.equal(Object.hasOwn(start, "input"), false);
    assert.equal(typeof start.inputSha256, "string");
    assert.equal((start.inputSha256 as string).length, 64);
    assert.equal((start.inputBytes as number) > 262_144, true);
    assert.deepEqual(requests[1]!.params, {
      phase: "completed",
      observedAt: "2026-01-01T00:00:00.010Z",
      toolCallId: "call_large",
      toolName: "orchestrate",
      status: "cancelled",
      durationMs: 10,
      errorCode: "PI_SESSION_INTERRUPTED",
      errorMessage: "quit",
    });
  });
});
