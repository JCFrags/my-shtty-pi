#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { initializeTrustedWorkerRuntime } from "./worker-runtime-startup.js";

export async function runWorkerRuntimeStartupEntry(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 4 || argv[0] !== "--authorization" || !argv[1] || argv[2] !== "--package" || !argv[3]) throw new Error("invalid-arguments");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_CHRONO_") || key === "TMPDIR" || key === "TMP" || key === "TEMP") throw new Error("environment-override-refused");
  }
  const result = await initializeTrustedWorkerRuntime({ authorizationPath: argv[1], expectedPackagePath: argv[3] });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkerRuntimeStartupEntry().catch(error => {
    const message = error instanceof Error && /^[a-z][a-z0-9-]{0,80}$/.test(error.message) ? error.message : "worker-startup-refused";
    process.stderr.write(JSON.stringify({ ready: false, refused: true, reason: message, cleanupPerformed: false }) + "\n");
    process.exitCode = 1;
  });
}
