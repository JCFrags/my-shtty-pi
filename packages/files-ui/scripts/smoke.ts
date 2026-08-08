import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface CommandRegistration {
  description: string;
  handler(args: string, ctx: SmokeContext): Promise<void> | void;
}

interface SmokeContext {
  cwd: string;
  mode: string;
  hasUI: boolean;
  ui: {
    notify(message: string, level?: string): void;
    pasteToEditor(text: string): void;
    custom<T>(factory: (tui: SmokeTui, theme: unknown, keys: unknown, done: (result: T | undefined) => void) => SmokeComponent): Promise<T | undefined>;
  };
}

interface SmokeTui {
  mode: "fullscreen";
  terminal: { rows: number; columns: number };
  requestRender(): void;
}

interface SmokeComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  isDisposed?: boolean;
}

function run(command: string, args: string[], cwd: string, environment?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: environment ? { ...process.env, ...environment } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const smokeRoot = path.join(packageRoot, ".tmp-smoke");
  await fs.rm(smokeRoot, { recursive: true, force: true });
  await fs.mkdir(smokeRoot, { recursive: true });

  const packOutput = run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", smokeRoot],
    packageRoot,
    { npm_config_dry_run: "false" },
  );
  const packed = JSON.parse(packOutput) as Array<{ filename: string; files?: Array<{ path: string }> }>;
  const entry = packed[0];
  assert.ok(entry?.filename, "npm pack did not return a tarball name");
  const packagedPaths = new Set((entry.files ?? []).map((file) => file.path));
  for (const required of [
    "package.json",
    "extensions/files/index.ts",
    "src/filesystem.ts",
    "dist/extensions/files/index.js",
    "dist/src/filesystem.js",
  ]) {
    assert.ok(packagedPaths.has(required), `tarball is missing ${required}`);
  }

  const extractRoot = path.join(smokeRoot, "unpacked");
  await fs.mkdir(extractRoot, { recursive: true });
  run("tar", ["-xzf", path.join(smokeRoot, entry.filename), "-C", extractRoot], packageRoot);
  const packageDirectory = path.join(extractRoot, "package");
  const sourceExtensionUrl = pathToFileURL(path.join(packageDirectory, "extensions/files/index.ts")).href;
  run(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const module = await import(${JSON.stringify(sourceExtensionUrl)}); if (typeof module.default !== "function") process.exit(1);`,
    ],
    packageRoot,
  );
  const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8")) as {
    pi?: { extensions?: string[] };
    engines?: { node?: string };
  };
  assert.deepEqual(manifest.pi?.extensions, ["./extensions"]);
  assert.equal(manifest.engines?.node, ">=22.19.0");

  const extensionModule = (await import(
    `${pathToFileURL(path.join(packageDirectory, "dist/extensions/files/index.js")).href}?smoke=${Date.now()}`
  )) as { default?: (pi: SmokePi) => void };
  assert.equal(typeof extensionModule.default, "function");

  const commands = new Map<string, CommandRegistration>();
  const events = new Map<string, Array<(event: unknown, ctx: SmokeContext) => Promise<void> | void>>();
  const pi: SmokePi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
    },
  };
  extensionModule.default?.(pi);
  const filesCommand = commands.get("files");
  assert.ok(filesCommand, "packed extension did not register /files");

  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "pi-files-ui-smoke-"));
  try {
    await fs.writeFile(path.join(repository, "README.md"), "smoke\n");
    const pastes: string[] = [];
    let rendered = false;
    let component: SmokeComponent | undefined;
    let markComponentReady: (() => void) | undefined;
    const componentReady = new Promise<void>((resolve) => {
      markComponentReady = resolve;
    });
    const context: SmokeContext = {
      cwd: repository,
      mode: "tui",
      hasUI: true,
      ui: {
        notify: () => {},
        pasteToEditor(text) {
          pastes.push(text);
        },
        custom<T>(factory: (tui: SmokeTui, theme: unknown, keys: unknown, done: (result: T | undefined) => void) => SmokeComponent): Promise<T | undefined> {
          return new Promise<T | undefined>((resolve) => {
            const tui: SmokeTui = {
              mode: "fullscreen",
              terminal: { rows: 18, columns: 90 },
              requestRender: () => {},
            };
            component = factory(tui, {}, {}, resolve);
            const lines = component.render(tui.terminal.columns);
            assert.equal(lines.length, tui.terminal.rows);
            rendered = true;
            markComponentReady?.();
          });
        },
      },
    };
    const commandPromise = Promise.resolve(filesCommand?.handler("", context));
    await componentReady;
    assert.equal(rendered, true);
    assert.deepEqual(pastes, [], "opening /files must not paste or submit anything");
    for (const handler of events.get("session_shutdown") ?? []) await handler({}, context);
    await commandPromise;
    assert.equal(component?.isDisposed, true);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }

  console.log(`package load smoke passed: ${entry.filename}`);
}

interface SmokePi {
  registerCommand(name: string, command: CommandRegistration): void;
  on(event: string, handler: (event: unknown, ctx: SmokeContext) => Promise<void> | void): void;
}

await main();
