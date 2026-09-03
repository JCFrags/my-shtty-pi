#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startStaticFixtureRelay } from "../dist/fixture/runtime.js";
import { openOrFocusProjectGlancePane } from "../dist/pi/open-pane.js";
import { projectGlanceError, projectGlanceErrorCode } from "../dist/pi/errors.js";

const execFileAsync = promisify(execFile);
const COMMAND_OUTPUT_LIMIT = 128 * 1024;
const PANE_WAIT_TIMEOUT_MS = 8_000;
const PANE_POLL_MS = 100;

function herdrEnvironment() {
  return { ...process.env, HERDR_ENV: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
}

async function runHerdr(args) {
  try {
    const result = await execFileAsync("herdr", args, {
      env: herdrEnvironment(),
      encoding: "utf8",
      maxBuffer: COMMAND_OUTPUT_LIMIT,
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
    };
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function paneIsPresent(paneId) {
  return (await runHerdr(["pane", "get", paneId])).ok;
}

async function readPane(paneId) {
  const result = await runHerdr([
    "pane",
    "read",
    paneId,
    "--source",
    "visible",
    "--lines",
    "200",
  ]);
  return result.ok ? result.stdout : "";
}

async function waitForPaneSmoke(paneId, relay) {
  const started = Date.now();
  let observedScreen = false;
  while (Date.now() - started <= PANE_WAIT_TIMEOUT_MS) {
    const text = await readPane(paneId);
    observedScreen = observedScreen || (
      text.includes("Project Glance") &&
      text.includes("CURRENT") &&
      text.includes("PROGRESS FEED")
    );
    if (relay.connectedClients > 0 && observedScreen && await paneIsPresent(paneId)) {
      await sleep(PANE_POLL_MS);
      if (relay.connectedClients > 0 && await paneIsPresent(paneId)) return;
    }
    await sleep(PANE_POLL_MS);
  }
  throw projectGlanceError("PROJECT_GLANCE_PANE_SMOKE_FAILED");
}

async function closePane(paneId) {
  if (!paneId) return true;
  const result = await runHerdr(["plugin", "pane", "close", paneId]);
  if (!result.ok) return false;
  const started = Date.now();
  while (Date.now() - started <= PANE_WAIT_TIMEOUT_MS) {
    if (!(await paneIsPresent(paneId))) return true;
    await sleep(PANE_POLL_MS);
  }
  return false;
}

async function run() {
  if (process.platform !== "linux") throw projectGlanceError("PROJECT_GLANCE_PANE_SMOKE_FAILED");
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw projectGlanceError("PROJECT_GLANCE_HERDR_CONTEXT_REQUIRED");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-project-glance-smoke-"));
  const environment = {
    ...process.env,
    XDG_RUNTIME_DIR: tempRoot,
    HERDR_ENV: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  let relay;
  let paneId;
  let closeSucceeded = true;
  try {
    relay = await startStaticFixtureRelay(environment);
    const opened = await openOrFocusProjectGlancePane({
      sessionKey: relay.sessionKey,
      descriptorPath: relay.paths.descriptorPath,
      currentPaneId: process.env.HERDR_PANE_ID,
      environment,
      herdrEnvironment: herdrEnvironment(),
    });
    if (opened.action !== "opened") {
      throw projectGlanceError("PROJECT_GLANCE_PANE_SMOKE_FAILED");
    }
    paneId = opened.paneId;
    await waitForPaneSmoke(paneId, relay);
    closeSucceeded = await closePane(paneId);
    if (!closeSucceeded) throw projectGlanceError("PROJECT_GLANCE_PANE_SMOKE_FAILED");
    paneId = undefined;
    process.stdout.write("PROJECT_GLANCE_PANE_SMOKE_PASS\n");
    process.stdout.write("Disposable Herdr pane stayed alive, completed the relay handshake, and rendered Project Glance sections.\n");
  } finally {
    if (paneId) closeSucceeded = (await closePane(paneId)) && closeSucceeded;
    await relay?.stop().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (!closeSucceeded) throw projectGlanceError("PROJECT_GLANCE_PANE_SMOKE_FAILED");
}

try {
  await run();
} catch (error) {
  const code = projectGlanceErrorCode(error);
  process.stderr.write(`Project Glance pane smoke failed safely: ${code}.\n`);
  process.exitCode = 1;
}
