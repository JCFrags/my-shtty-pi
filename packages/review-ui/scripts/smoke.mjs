import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(resolve(tmpdir(), "pi-review-ui-smoke-"));
try {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
    cwd: root,
    encoding: "utf8",
  });
  const pack = JSON.parse(output);
  const filename = pack[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a filename");
  execFileSync("tar", ["-xzf", resolve(temp, filename), "-C", temp]);
  const packageRoot = resolve(temp, "package");
  execFileSync(
    process.execPath,
    [resolve(root, "scripts/prepare-test-peers.mjs"), resolve(packageRoot, "node_modules")],
    { cwd: root, stdio: "inherit" },
  );

  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const extensionPath = packageJson.pi?.extensions?.[0];
  if (typeof extensionPath !== "string") throw new Error("packed package has no Pi extension manifest entry");

  const declaredEntry = resolve(packageRoot, extensionPath);
  await readFile(declaredEntry, "utf8");
  const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const loader = await import(pathToFileURL(resolve(dirname(piMain), "core/extensions/index.js")).href);
  const loaded = await loader.loadExtensions([declaredEntry], packageRoot);
  if (loaded.errors.length > 0 || loaded.extensions.length !== 1) {
    throw new Error(`Pi loader rejected the declared extension entry: ${loaded.errors.join("; ")}`);
  }

  const module = await import(pathToFileURL(resolve(packageRoot, "dist/extension.js")).href + `?t=${Date.now()}`);
  if (typeof module.default !== "function") throw new Error("packed compiled extension default export is not a function");

  const handlers = new Map();
  const bus = new Map();
  module.default({
    events: {
      on(name, handler) {
        const list = bus.get(name) ?? [];
        list.push(handler);
        bus.set(name, list);
        return () => bus.set(name, (bus.get(name) ?? []).filter((value) => value !== handler));
      },
      emit(name, value) {
        for (const handler of bus.get(name) ?? []) handler(value);
      },
    },
    getAllTools() {
      return [
        { name: "edit", sourceInfo: { path: "<builtin:edit>", source: "builtin", scope: "temporary", origin: "top-level" } },
        { name: "write", sourceInfo: { path: "<builtin:write>", source: "builtin", scope: "temporary", origin: "top-level" } },
      ];
    },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  });
  for (const required of [
    "tool_call",
    "turn_start",
    "turn_end",
    "session_start",
    "session_shutdown",
    "session_before_switch",
    "session_before_fork",
    "resources_discover",
  ]) {
    if (!handlers.has(required)) throw new Error(`extension did not register ${required}`);
  }

  const toolHandler = handlers.get("tool_call")?.[0];
  if (typeof toolHandler !== "function") throw new Error("tool_call handler was not callable");
  const context = {
    cwd: packageRoot,
    mode: "print",
    hasUI: false,
    signal: undefined,
    ui: {
      notify() {},
      async custom() {
        throw new Error("non-interactive smoke must not create an overlay");
      },
    },
  };
  const ignored = await toolHandler(
    { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "README.md" } },
    context,
  );
  if (ignored !== undefined) throw new Error("non-edit/write tool was not ignored");
  const blocked = await toolHandler(
    { type: "tool_call", toolCallId: "write-1", toolName: "write", input: { path: "smoke.txt", content: "x" } },
    context,
  );
  if (blocked?.block !== true || !String(blocked.reason).includes("non-interactive mode (print)")) {
    throw new Error("packed extension did not enforce the default non-interactive block policy");
  }

  console.log(`local package smoke: loaded ${packageJson.name}@${packageJson.version} with ${handlers.size} event groups`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
