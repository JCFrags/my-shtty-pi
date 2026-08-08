import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HerdrCli,
  buildClearMetadataArgs,
  buildReportMetadataArgs,
  detectHerdrCapabilities,
  resolveActivation,
  runBoundedProcess,
  snapshotToPatch,
} from "../src/herdr-client.ts";

const fakeHerdr = path.join(process.cwd(), "test/fixtures/fake-herdr.mjs");

async function readLog(logPath: string): Promise<{ argv: string[]; at: number }[]> {
  const contents = await readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; at: number });
}

test("activation requires the complete Herdr environment and executable binary", () => {
  assert.deepEqual(resolveActivation({}, () => true), {
    active: false,
    reason: "HERDR_ENV is not 1",
  });
  assert.deepEqual(
    resolveActivation({ HERDR_ENV: "0", HERDR_PANE_ID: "w0:p9" }, () => true),
    {
      active: false,
      paneId: "w0:p9",
      reason: "HERDR_ENV is not 1",
    },
  );
  assert.deepEqual(resolveActivation({ HERDR_ENV: "1" }, () => true), {
    active: false,
    reason: "HERDR_PANE_ID is missing",
  });
  assert.deepEqual(
    resolveActivation({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, () => true),
    {
      active: false,
      paneId: "w1:p1",
      reason: "HERDR_BIN_PATH is missing",
    },
  );
  assert.deepEqual(
    resolveActivation(
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/bad/herdr" },
      () => false,
    ),
    {
      active: false,
      paneId: "w1:p1",
      binaryPath: "/bad/herdr",
      reason: "HERDR_BIN_PATH is not executable",
    },
  );
  assert.deepEqual(
    resolveActivation(
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/opt/herdr" },
      () => true,
    ),
    {
      active: true,
      paneId: "w1:p1",
      binaryPath: "/opt/herdr",
    },
  );
});

test("installed schema and help determine sequence support without inventing flags", () => {
  const schema = JSON.stringify({
    schemas: {
      request: {
        $defs: {
          PaneReportMetadataParams: {
            properties: { tokens: {}, ttl_ms: {}, seq: {} },
          },
        },
      },
    },
  });
  const help = "--source ID --token NAME=VALUE --clear-token NAME --seq N --ttl-ms N";
  assert.deepEqual(detectHerdrCapabilities(schema, help), { sequence: true });
  assert.deepEqual(
    detectHerdrCapabilities(schema, help.replace(" --seq N", "")),
    { sequence: false },
  );
  assert.throws(
    () => detectHerdrCapabilities(schema, help.replace("--clear-token NAME", "")),
    /--clear-token/u,
  );
});

test("argument builder emits deterministic argv with documented clear semantics", () => {
  const tokens = snapshotToPatch({
    summary: "reading src/a.ts",
    model: "openai/gpt-5.6-pro",
    changed_files: "2",
    turn: "7",
  });

  assert.deepEqual(
    buildReportMetadataArgs({
      paneId: "w1:p1",
      tokens,
      sequence: 42,
      ttlMs: 15_000,
    }),
    [
      "pane",
      "report-metadata",
      "w1:p1",
      "--source",
      "user:pi-rich-status",
      "--token",
      "summary=reading src/a.ts",
      "--token",
      "model=openai/gpt-5.6-pro",
      "--clear-token",
      "context",
      "--clear-token",
      "tool",
      "--token",
      "changed_files=2",
      "--token",
      "turn=7",
      "--seq",
      "42",
      "--ttl-ms",
      "15000",
    ],
  );

  assert.deepEqual(buildClearMetadataArgs("w1:p1", 43), [
    "pane",
    "report-metadata",
    "w1:p1",
    "--source",
    "user:pi-rich-status",
    "--clear-token",
    "summary",
    "--clear-token",
    "model",
    "--clear-token",
    "context",
    "--clear-token",
    "tool",
    "--clear-token",
    "changed_files",
    "--clear-token",
    "turn",
    "--seq",
    "43",
  ]);
});

test("transport-boundary normalization never emits empty or credential-bearing token values", () => {
  const tokens = snapshotToPatch({
    summary: "API_TOKEN=secret\nreading /tmp/file",
    tool: "\u0000\u001b[31m",
  });

  assert.equal(tokens.summary, "API_TOKEN=<redacted> reading /tmp/file");
  assert.equal(tokens.tool, null);
  const args = buildReportMetadataArgs({ paneId: "w1:p1", tokens });
  for (const [index, argument] of args.entries()) {
    if (argument !== "--token") continue;
    const tokenArgument = args[index + 1];
    assert.ok(tokenArgument);
    assert.ok(!tokenArgument.endsWith("="));
    assert.doesNotMatch(tokenArgument, /secret/u);
  }
});

test("metadata argv never constructs semantic lifecycle or session identity calls", () => {
  const invocations = [
    buildReportMetadataArgs({
      paneId: "w1:p1",
      tokens: snapshotToPatch({ summary: "idle · 2 files changed" }),
      sequence: 10,
      ttlMs: 15_000,
    }),
    buildClearMetadataArgs("w1:p1", 11),
  ];

  for (const args of invocations) {
    assert.deepEqual(args.slice(0, 2), ["pane", "report-metadata"]);
    assert.ok(!args.some((argument) => /report-agent|--state|--session(?:-id|-ref)?/u.test(argument)));
  }
});

test("fake Herdr binary receives probes and exact metadata argv", async () => {
  await chmod(fakeHerdr, 0o755);
  const directory = await mkdtemp(path.join(tmpdir(), "pi-herdr-status-"));
  const logPath = path.join(directory, "herdr.log");
  const environment = {
    ...process.env,
    FAKE_HERDR_LOG: logPath,
  };
  const client = new HerdrCli({
    binaryPath: fakeHerdr,
    paneId: "w3:p2",
    environment,
    processTimeoutMs: 1_000,
  });

  await client.report({ summary: "running npm test", tool: "bash", turn: "3" }, 11, 15_000);
  await client.clear(12);

  const log = await readLog(logPath);
  assert.equal(log.length, 2);
  assert.deepEqual(log[0]?.argv.slice(0, 5), [
    "pane",
    "report-metadata",
    "w3:p2",
    "--source",
    "user:pi-rich-status",
  ]);
  assert.ok(log[0]?.argv.includes("--seq"));
  assert.ok(log[0]?.argv.includes("11"));
  assert.ok(log[0]?.argv.includes("--ttl-ms"));
  assert.ok(log[0]?.argv.includes("15000"));
  assert.ok(log[1]?.argv.includes("--clear-token"));
  assert.ok(!log[1]?.argv.includes("--ttl-ms"));

  for (const entry of log) {
    assert.deepEqual(entry.argv.slice(0, 2), ["pane", "report-metadata"]);
    assert.ok(!entry.argv.includes("--state"));
    assert.ok(!entry.argv.some((arg) => arg.includes("report-agent")));
  }
});

test("a failed interface probe is not cached permanently", async () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_HERDR_BAD_SCHEMA: "1",
  };
  const client = new HerdrCli({
    binaryPath: fakeHerdr,
    paneId: "w1:p1",
    environment,
  });

  await assert.rejects(client.inspectInstalledInterface(), /not valid JSON/u);
  delete environment.FAKE_HERDR_BAD_SCHEMA;
  assert.deepEqual(await client.inspectInstalledInterface(), { sequence: true });
});

test("sequence is omitted when the installed schema or help does not support it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-herdr-status-"));
  const logPath = path.join(directory, "herdr.log");
  const client = new HerdrCli({
    binaryPath: fakeHerdr,
    paneId: "w1:p1",
    environment: {
      ...process.env,
      FAKE_HERDR_LOG: logPath,
      FAKE_HERDR_NO_SEQ: "1",
    },
  });

  await client.report({ summary: "idle" }, 99, 15_000);
  const [entry] = await readLog(logPath);
  assert.ok(entry);
  assert.ok(!entry.argv.includes("--seq"));
});

test("subprocess execution is bounded and failures are concise", async () => {
  await assert.rejects(
    runBoundedProcess(fakeHerdr, ["noop"], {
      environment: { ...process.env, FAKE_HERDR_SLEEP_MS: "100" },
      timeoutMs: 10,
    }),
    /timed out/u,
  );

  await assert.rejects(
    runBoundedProcess(fakeHerdr, ["noop"], {
      environment: { ...process.env, FAKE_HERDR_EXIT_CODE: "7" },
      timeoutMs: 1_000,
      outputLimitBytes: 32,
    }),
    /code 7/u,
  );

  const result = await runBoundedProcess(fakeHerdr, ["noop"], {
    environment: { ...process.env, FAKE_HERDR_OUTPUT_BYTES: "10000" },
    outputLimitBytes: 64,
  });
  assert.equal(Buffer.byteLength(result.stdout), 64);
});
