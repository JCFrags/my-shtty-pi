import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadTestRuntime() {
  const testEntry = join(process.cwd(), "dist-test", "test", "support", "index.js");
  const entry = existsSync(testEntry) ? testEntry : join(process.cwd(), "dist", "src", "index.js");
  return import(pathToFileURL(entry).href);
}
