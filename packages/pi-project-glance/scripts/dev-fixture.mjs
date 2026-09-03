#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticFixtureRelay } from "../dist/fixture/runtime.js";
import { openOrFocusProjectGlancePane } from "../dist/pi/open-pane.js";

const openPane = process.argv.includes("--open");
const restartArgument = process.argv.find((argument) => argument.startsWith("--restart-after-ms="));
const restartAfterMs = restartArgument === undefined ? undefined : Number(restartArgument.slice("--restart-after-ms=".length));
if (restartAfterMs !== undefined && (!Number.isSafeInteger(restartAfterMs) || restartAfterMs < 1 || restartAfterMs > 60_000)) {
  process.stderr.write("Project Glance fixture failed safely: INVALID_RESTART_DELAY.\n");
  process.exitCode = 1;
} else {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-project-glance-fixture-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: tempRoot, HERDR_ENV: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const execFileAsync = (file, args) =>
    new Promise((resolveResult) => {
      execFile(file, args, { env: process.env, encoding: "utf8", maxBuffer: 128 * 1024 }, (error) => resolveResult(!error));
    });
  let relay;
  let openedPane;
  let restartTimer;
  let stopping = false;

  async function cleanup() {
    if (stopping) return;
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (openedPane?.action === "opened") {
      await execFileAsync("herdr", ["plugin", "pane", "close", openedPane.paneId]);
    }
    await relay?.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }

  try {
    relay = await startStaticFixtureRelay(environment);
    if (openPane) {
      if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("HERDR_CONTEXT_REQUIRED");
      const options = {
        sessionKey: relay.sessionKey,
        descriptorPath: relay.paths.descriptorPath,
        currentPaneId: process.env.HERDR_PANE_ID,
        cwd: process.cwd(),
        environment,
        herdrEnvironment: process.env,
      };
      openedPane = await openOrFocusProjectGlancePane(options);
      process.stdout.write(openedPane.action === "opened" ? "Project Glance fixture pane opened.\n" : "Project Glance fixture pane focused.\n");
    } else {
      process.stdout.write("Project Glance fixture relay ready.\n");
    }
    if (restartAfterMs !== undefined) {
      restartTimer = setTimeout(async () => {
        try {
          await relay.restart();
          process.stdout.write("Project Glance fixture relay restarted.\n");
        } catch {
          process.stdout.write("Project Glance fixture relay restart failed.\n");
        }
      }, restartAfterMs);
    }
    process.stdout.write("Press Ctrl-C to stop the disposable fixture.\n");
    const finish = new Promise((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.once("SIGHUP", stop);
    });
    await finish;
  } catch (error) {
    if (error instanceof Error && error.message === "HERDR_CONTEXT_REQUIRED") {
      process.stderr.write("Open the disposable fixture from a Herdr-managed pane.\n");
    } else {
      const reason = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "UNKNOWN";
      process.stderr.write(`Project Glance fixture failed safely: ${reason}.\n`);
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}
