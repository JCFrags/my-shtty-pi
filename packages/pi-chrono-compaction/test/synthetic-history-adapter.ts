import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import extension from "../src/pi-extension.js";
import { handleHistoryWorkerRequest } from "../src/history-worker-handler.js";
import type { HistoryWorkerTransport } from "../src/history-worker-contract.js";

/** Unit semantics only: deliberately executes the child handler in-process.
 * The marker satisfies dispatch injection, NOT proof of OS memory containment.
 * Production containment belongs to separate shared-runtime integration tests. */
export function syntheticInProcessHistoryAdapter(beforeRun?: (wire: string) => void | Promise<void>): HistoryWorkerTransport {
  return {
    isolation: "os-bounded-child-v1",
    async run(wire) {
      await beforeRun?.(wire);
      return handleHistoryWorkerRequest(wire);
    },
  };
}

/** Set only a synthetic config path for factory loading and retain shutdown for
 * tests whose mock Pi does not dispatch lifecycle events. */
export function installSyntheticHistoryExtension(pi: ExtensionAPI, directory: string, beforeRun?: (wire: string) => void | Promise<void>): () => void {
  const previous = process.env.PI_CHRONO_CONFIG_PATH;
  const shutdown: Array<() => void> = [];
  const wrapped = Object.create(pi) as ExtensionAPI;
  wrapped.on = ((name: string, callback: (...args: any[]) => unknown) => {
    if (name === "session_shutdown") shutdown.push(() => { callback({}, {}); });
    (pi.on as any)(name, callback);
  }) as ExtensionAPI["on"];
  process.env.PI_CHRONO_CONFIG_PATH = join(directory, "synthetic-history-config.json");
  try { extension(wrapped, { historyTransport: syntheticInProcessHistoryAdapter(beforeRun) }); }
  finally {
    if (previous === undefined) delete process.env.PI_CHRONO_CONFIG_PATH;
    else process.env.PI_CHRONO_CONFIG_PATH = previous;
  }
  return () => { for (const callback of shutdown.splice(0)) callback(); };
}
