import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  PROJECT_GLANCE_DESCRIPTOR_ENV,
  PROJECT_GLANCE_ENTRYPOINT,
  PROJECT_GLANCE_PLUGIN_ID,
  type ProjectGlanceRuntimeDescriptor,
} from "../protocol/model.js";
import { runtimePathsForSession } from "../runtime/paths.js";
import { ProjectGlancePaneRegistry } from "../runtime/pane-registry.js";
import {
  ProjectGlanceCommandError,
  projectGlanceDiagnostic,
  projectGlanceError,
  type ProjectGlanceErrorCode,
} from "./errors.js";
import type { ProjectGlanceRelayRuntime } from "./lifecycle.js";

const execFileAsync = promisify(execFile);
const COMMAND_OUTPUT_LIMIT = 128 * 1024;
const PANE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const EXPECTED_PANE_COMMAND = ["./bin/pi-project-glance", "glance"] as const;
const PROJECT_GLANCE_PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export interface HerdrCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type HerdrCommandRunner = (
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<HerdrCommandResult>;

export interface OpenProjectGlanceOptions {
  sessionKey: string;
  descriptorPath: string;
  currentPaneId: string;
  workspaceId?: string;
  environment?: NodeJS.ProcessEnv;
  herdrEnvironment?: NodeJS.ProcessEnv;
  runner?: HerdrCommandRunner;
}

export interface ProjectGlanceCommandPreparation {
  sessionKey: string;
  descriptorPath: string;
  currentPaneId: string;
  environment: NodeJS.ProcessEnv;
}

export interface OpenProjectGlanceResult {
  action: "opened" | "focused";
  paneId: string;
}

function validatePaneId(value: string): string {
  if (!PANE_ID_PATTERN.test(value)) {
    throw projectGlanceError("PROJECT_GLANCE_PANE_ID_MISSING");
  }
  return value;
}

function outputText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length > COMMAND_OUTPUT_LIMIT
    ? value.slice(0, COMMAND_OUTPUT_LIMIT)
    : value;
}

export function defaultHerdrRunner(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<HerdrCommandResult> {
  return execFileAsync(executable, [...args], {
    env: environment,
    encoding: "utf8",
    maxBuffer: COMMAND_OUTPUT_LIMIT,
    windowsHide: true,
  })
    .then(({ stdout, stderr }) => ({
      ok: true,
      stdout: outputText(stdout),
      stderr: outputText(stderr),
    }))
    .catch((error: unknown) => {
      const record =
        error && typeof error === "object"
          ? (error as Record<string, unknown>)
          : {};
      return {
        ok: false,
        stdout: outputText(record.stdout),
        stderr: outputText(record.stderr),
      };
    });
}

async function resolveHerdrExecutable(environment: NodeJS.ProcessEnv): Promise<string> {
  const configured = environment.HERDR_BIN_PATH;
  if (configured === undefined) return "herdr";
  try {
    if (!isAbsolute(configured)) throw new Error("relative");
    await access(configured);
    const entry = await stat(configured);
    if (!entry.isFile() || (entry.mode & 0o111) === 0) throw new Error("not executable");
    return configured;
  } catch {
    throw projectGlanceError("PROJECT_GLANCE_HERDR_UNAVAILABLE");
  }
}

function requireHerdrContext(environment: NodeJS.ProcessEnv): { paneId: string } {
  if (environment.HERDR_ENV !== "1") {
    throw projectGlanceError("PROJECT_GLANCE_HERDR_CONTEXT_REQUIRED");
  }
  return { paneId: validatePaneId(environment.HERDR_PANE_ID ?? "") };
}

export function buildPaneOpenArgs(options: {
  descriptorPath: string;
  currentPaneId: string;
  workspaceId?: string;
}): string[] {
  const currentPaneId = validatePaneId(options.currentPaneId);
  if (!isAbsolute(options.descriptorPath)) {
    throw projectGlanceError("PROJECT_GLANCE_DESCRIPTOR_UNAVAILABLE");
  }
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    PROJECT_GLANCE_PLUGIN_ID,
    "--entrypoint",
    PROJECT_GLANCE_ENTRYPOINT,
    "--placement",
    "split",
  ];
  if (options.workspaceId) args.push("--workspace", options.workspaceId);
  args.push("--target-pane", currentPaneId, "--direction", "right");
  args.push(
    "--env",
    `${PROJECT_GLANCE_DESCRIPTOR_ENV}=${options.descriptorPath}`,
    "--focus",
  );
  return args;
}

export function parsePaneOpenOutput(stdout: string): string {
  if (Buffer.byteLength(stdout, "utf8") > COMMAND_OUTPUT_LIMIT) {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  const envelope = value as Record<string, unknown>;
  const result = envelope.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  const resultRecord = result as Record<string, unknown>;
  const pluginPane = resultRecord.plugin_pane;
  if (pluginPane === null || typeof pluginPane !== "object" || Array.isArray(pluginPane)) {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  const pluginPaneRecord = pluginPane as Record<string, unknown>;
  if (
    pluginPaneRecord.plugin_id !== PROJECT_GLANCE_PLUGIN_ID ||
    pluginPaneRecord.entrypoint !== PROJECT_GLANCE_ENTRYPOINT
  ) {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  const pane = pluginPaneRecord.pane;
  if (pane === null || typeof pane !== "object" || Array.isArray(pane)) {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  const paneId = (pane as Record<string, unknown>).pane_id;
  if (typeof paneId !== "string" || !PANE_ID_PATTERN.test(paneId)) {
    throw projectGlanceError("PROJECT_GLANCE_OPEN_RESPONSE_INVALID");
  }
  return paneId;
}

async function runCommand(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  runner: HerdrCommandRunner,
): Promise<HerdrCommandResult> {
  return runner(executable, args, {
    ...environment,
    HERDR_ENV: "1",
  });
}

async function inspectProjectGlancePlugin(
  executable: string,
  environment: NodeJS.ProcessEnv,
  runner: HerdrCommandRunner,
): Promise<void> {
  const result = await runCommand(
    executable,
    ["plugin", "list", "--json"],
    environment,
    runner,
  );
  if (!result.ok) {
    throw projectGlanceError("PROJECT_GLANCE_HERDR_INSPECTION_FAILED");
  }
  let plugins: unknown;
  try {
    plugins = JSON.parse(result.stdout).result?.plugins;
  } catch {
    throw projectGlanceError("PROJECT_GLANCE_HERDR_INSPECTION_FAILED");
  }
  if (!Array.isArray(plugins)) {
    throw projectGlanceError("PROJECT_GLANCE_HERDR_INSPECTION_FAILED");
  }
  const matches = plugins.filter(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      (item as Record<string, unknown>).plugin_id === PROJECT_GLANCE_PLUGIN_ID,
  );
  if (matches.length === 0) {
    throw projectGlanceError("PROJECT_GLANCE_PLUGIN_NOT_LINKED");
  }
  if (matches.length !== 1) {
    throw projectGlanceError("PROJECT_GLANCE_PLUGIN_ROOT_MISMATCH");
  }
  const plugin = matches[0] as Record<string, unknown>;
  if (typeof plugin.plugin_root !== "string") {
    throw projectGlanceError("PROJECT_GLANCE_PLUGIN_ROOT_MISMATCH");
  }
  try {
    if ((await realpath(plugin.plugin_root)) !== (await realpath(PROJECT_GLANCE_PACKAGE_ROOT))) {
      throw projectGlanceError("PROJECT_GLANCE_PLUGIN_ROOT_MISMATCH");
    }
  } catch (error) {
    if (error instanceof ProjectGlanceCommandError) throw error;
    throw projectGlanceError("PROJECT_GLANCE_PLUGIN_ROOT_MISMATCH");
  }
  if (plugin.enabled !== true) {
    throw projectGlanceError("PROJECT_GLANCE_PLUGIN_DISABLED");
  }
  const panes = Array.isArray(plugin.panes) ? plugin.panes : [];
  const pane = panes.find(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      (item as Record<string, unknown>).id === PROJECT_GLANCE_ENTRYPOINT,
  ) as Record<string, unknown> | undefined;
  if (!pane || JSON.stringify(pane.command) !== JSON.stringify(EXPECTED_PANE_COMMAND)) {
    throw projectGlanceError("PROJECT_GLANCE_ENTRYPOINT_MISSING");
  }
}

async function paneIsPresent(
  executable: string,
  paneId: string,
  environment: NodeJS.ProcessEnv,
  runner: HerdrCommandRunner,
): Promise<boolean> {
  const result = await runCommand(
    executable,
    ["pane", "get", paneId],
    environment,
    runner,
  );
  return result.ok;
}

export async function openOrFocusProjectGlancePane(
  options: OpenProjectGlanceOptions,
): Promise<OpenProjectGlanceResult> {
  const environment = options.environment ?? process.env;
  const commandEnvironment = options.herdrEnvironment ?? environment;
  const currentPaneId = validatePaneId(options.currentPaneId);
  const executable = await resolveHerdrExecutable(commandEnvironment);
  const runner = options.runner ?? defaultHerdrRunner;
  await inspectProjectGlancePlugin(executable, commandEnvironment, runner);
  const paths = runtimePathsForSession(options.sessionKey, environment);
  const registry = new ProjectGlancePaneRegistry(paths);
  try {
    return await registry.withSessionLock(options.sessionKey, async (lockedRegistry) => {
      const registered = await lockedRegistry.get(options.sessionKey);
      if (registered) {
        const focus = await runCommand(
          executable,
          ["plugin", "pane", "focus", registered.paneId],
          commandEnvironment,
          runner,
        );
        if (focus.ok) return { action: "focused", paneId: registered.paneId };
        if (await paneIsPresent(executable, registered.paneId, commandEnvironment, runner)) {
          throw projectGlanceError("PROJECT_GLANCE_FOCUS_FAILED");
        }
        await lockedRegistry.remove(options.sessionKey);
      }
      const args = buildPaneOpenArgs({
        descriptorPath: options.descriptorPath,
        currentPaneId,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      });
      const opened = await runCommand(executable, args, commandEnvironment, runner);
      if (!opened.ok) throw projectGlanceError("PROJECT_GLANCE_OPEN_FAILED");
      const paneId = parsePaneOpenOutput(opened.stdout);
      try {
        await lockedRegistry.set(options.sessionKey, paneId);
      } catch {
        throw projectGlanceError("PROJECT_GLANCE_REGISTRY_FAILED");
      }
      return { action: "opened", paneId };
    });
  } catch (error) {
    if (error instanceof ProjectGlanceCommandError) throw error;
    throw projectGlanceError("PROJECT_GLANCE_REGISTRY_FAILED");
  }
}

export async function prepareProjectGlanceCommand(
  ctx: ExtensionCommandContext,
  runtime: ProjectGlanceRelayRuntime,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectGlanceCommandPreparation> {
  try {
    await runtime.ensureForContext(ctx);
  } catch (error) {
    if (error instanceof ProjectGlanceCommandError) throw error;
    throw projectGlanceError("PROJECT_GLANCE_RUNTIME_START_FAILED");
  }
  runtime.refreshCurrent();
  const descriptorPath = runtime.descriptorPath;
  const sessionKey = runtime.sessionKey;
  if (!descriptorPath || !sessionKey) {
    throw projectGlanceError("PROJECT_GLANCE_RUNTIME_MISSING");
  }
  const herdr = requireHerdrContext(environment);
  return {
    sessionKey,
    descriptorPath,
    currentPaneId: herdr.paneId,
    environment,
  };
}

export async function handleProjectGlanceCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: ProjectGlanceRelayRuntime,
): Promise<void> {
  try {
    const preparation = await prepareProjectGlanceCommand(ctx, runtime);
    const result = await openOrFocusProjectGlancePane(preparation);
    ctx.ui.notify(
      result.action === "opened"
        ? "Project Glance opened."
        : "Project Glance focused.",
      "info",
    );
  } catch (error) {
    ctx.ui.notify(projectGlanceDiagnostic(error), "error");
  }
  void pi;
}
