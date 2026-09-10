import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerStartupStatus { state: "pending" | "running" | "ready" | "unavailable"; errorCode?: string; changed?: boolean }
export const startupPackagePath = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const startupAuthorizationPath = (configurationPath: string): string => join(dirname(configurationPath), "chrono-deployments",
  createHash("sha256").update(startupPackagePath()).digest("hex"), "startup-authorization.json");

/** Initialization never runs in Pi's interactive process. One bounded child
 * validates the deployment authorization and serializes with other agents. */
export function startAuthorizedWorkerRuntime(authorizationPath: string): Promise<WorkerStartupStatus> {
  return new Promise(resolveResult => {
    const environment = Object.fromEntries(["PATH", "HOME", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = spawn(process.execPath, ["--max-old-space-size=96", join(dirname(fileURLToPath(import.meta.url)), "worker-runtime-startup-entry.js"),
      "--authorization", authorizationPath, "--package", startupPackagePath()], { env: environment, stdio: ["ignore", "pipe", "ignore"] });
    let output = "", overLimit = false, timedOut = false, settled = false;
    const finish = (status: WorkerStartupStatus): void => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(status); } };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
    child.stdout.on("data", (bytes: Buffer) => {
      if (Buffer.byteLength(output) + bytes.length > 8192) { overLimit = true; child.kill("SIGKILL"); }
      else output += bytes.toString("utf8");
    });
    child.once("error", () => finish({ state: "unavailable", errorCode: "worker-startup-launch-failed" }));
    child.once("close", code => {
      if (timedOut || overLimit) return finish({ state: "unavailable", errorCode: timedOut ? "worker-startup-timeout" : "worker-startup-output-limit" });
      try {
        const result = JSON.parse(output.trim());
        if (code === 0 && result.ready === true) return finish({ state: "ready", changed: result.changed === true });
        const reason = typeof result.reason === "string" && /^[a-z][a-z0-9-]{0,80}$/.test(result.reason) ? result.reason : "worker-startup-refused";
        finish({ state: "unavailable", errorCode: reason });
      } catch { finish({ state: "unavailable", errorCode: "worker-startup-refused" }); }
    });
  });
}
