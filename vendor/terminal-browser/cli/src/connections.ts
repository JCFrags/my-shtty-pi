import fs from "node:fs";
import path from "node:path";
import { DAEMON_SOCKET, INTEROP_INSTANCES_DIR, runtimeMatches } from "pixel-store";
import { daemonRequest } from "./daemon-status";
import { safeDaemonStatus } from "./doctor";

/** Owner-free metadata only. Never opens storage, prunes records, or starts a daemon. */
export async function connectionInventory() {
  if (!path.isAbsolute(INTEROP_INSTANCES_DIR)) throw new Error("invalid browser instances directory");
  let value: unknown;
  try { value = await daemonRequest({ cmd: "status" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { fs.lstatSync(DAEMON_SOCKET); }
    catch (observed) {
      if ((observed as NodeJS.ErrnoException).code !== "ENOENT") throw observed;
      return { schemaVersion: 1 as const, instancesDirectory: INTEROP_INSTANCES_DIR, identity: null, matchesCandidate: null, sessions: [], complete: true as const };
    }
    throw new Error("existing daemon status is uncertain; inspect doctor before explicit recovery");
  }
  const status = safeDaemonStatus(value, true);
  return { schemaVersion: 1 as const, instancesDirectory: INTEROP_INSTANCES_DIR, ...status, matchesCandidate: runtimeMatches(status.identity) };
}
