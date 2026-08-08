import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length !== 1) {
  throw new Error("Pi package manifest must declare exactly one extension directory");
}
if (manifest.pi.extensions[0] !== "./extensions") {
  throw new Error(`Unexpected Pi extension path: ${String(manifest.pi.extensions[0])}`);
}

process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "smoke-pane";
process.env.HERDR_BIN_PATH = resolve(root, "test/fixtures/fake-herdr.mjs");

const extensionModule = await import(resolve(root, "dist/extensions/herdr-status.js"));
const extension = extensionModule.default;
if (typeof extension !== "function") {
  throw new Error("Built Pi extension has no default registration function");
}

const handlers = new Map();
const commands = new Map();
const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerCommand(name, definition) {
    commands.set(name, definition);
  },
};

extension(pi);

if (!commands.has("herdr-status")) {
  throw new Error("Pi extension smoke load did not register /herdr-status");
}
if (!handlers.has("session_start") || !handlers.has("session_shutdown")) {
  throw new Error("Pi extension smoke load did not register lifecycle handlers");
}

process.stdout.write("Pi package manifest and extension load smoke test passed\n");
