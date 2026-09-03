import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
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
import type { ProjectGlanceRelayRuntime } from "./lifecycle.js";

const execFileAsync = promisify(execFile);
const COMMAND_OUTPUT_LIMIT = 128 * 1024;
const PANE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

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
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  herdrEnvironment?: NodeJS.ProcessEnv;
  runner?: HerdrCommandRunner;
}

export interface OpenProjectGlanceResult {
  action: "opened" | "focused";
  paneId: string;
}

function validatePaneId(value: string): string {
  if (!PANE_ID_PATTERN.test(value)) throw new Error("INVALID_PANE_ID");
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
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error("INVALID_HERDR_PATH");
    await access(configured);
    const entry = await stat(configured);
    if (!entry.isFile() || (entry.mode & 0o111) === 0) {
      throw new Error("INVALID_HERDR_PATH");
    }
    return configured;
  }
  return "herdr";
}

function requireHerdrContext(environment: NodeJS.ProcessEnv): { paneId: string } {
  if (environment.HERDR_ENV !== "1") throw new Error("HERDR_CONTEXT_REQUIRED");
  return { paneId: validatePaneId(environment.HERDR_PANE_ID ?? "") };
}

export function buildPaneOpenArgs(options: {
  descriptorPath: string;
  currentPaneId: string;
  workspaceId?: string;
  cwd?: string;
}): string[] {
  const currentPaneId = validatePaneId(options.currentPaneId);
  if (!isAbsolute(options.descriptorPath)) throw new Error("INVALID_DESCRIPTOR_PATH");
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
  if (options.cwd) args.push("--cwd", options.cwd);
  args.push(
    "--env",
    `${PROJECT_GLANCE_DESCRIPTOR_ENV}=${options.descriptorPath}`,
    "--focus",
  );
  return args;
}

function findPaneId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    const candidates = value.flatMap((item) => {
      const found = findPaneId(item);
      return found ? [found] : [];
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  const source = value as Record<string, unknown>;
  for (const key of ["pane_id", "paneId"]) {
    if (typeof source[key] === "string" && PANE_ID_PATTERN.test(source[key])) {
      return source[key];
    }
  }
  const candidates = Object.values(source).flatMap((item) => {
    const found = findPaneId(item);
    return found ? [found] : [];
  });
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

export function parsePaneOpenOutput(stdout: string): string {
  if (Buffer.byteLength(stdout, "utf8") > COMMAND_OUTPUT_LIMIT) {
    throw new Error("INVALID_PANE_RESPONSE");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new Error("INVALID_PANE_RESPONSE");
  }
  const result =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).result ?? value
      : value;
  const paneId = findPaneId(result);
  if (!paneId) throw new Error("INVALID_PANE_RESPONSE");
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

async function paneIsPresent(
  executable: string,
  paneId: string,
  environment: NodeJS.ProcessEnv,
  runner: HerdrCommandRunner,
): Promise<boolean> {
  const result = await runCommand(
    executable,
    ["plugin", "pane", "get", paneId],
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
  const paths = runtimePathsForSession(options.sessionKey, environment);
  const registry = new ProjectGlancePaneRegistry(paths);
  const registered = await registry.get(options.sessionKey);
  if (registered) {
    const focus = await runCommand(
      executable,
      ["plugin", "pane", "focus", registered.paneId],
      commandEnvironment,
      runner,
    );
    if (focus.ok) return { action: "focused", paneId: registered.paneId };
    if (await paneIsPresent(executable, registered.paneId, commandEnvironment, runner)) {
      throw new Error("PROJECT_GLANCE_FOCUS_FAILED");
    }
    await registry.remove(options.sessionKey);
  }
  const args = buildPaneOpenArgs({
    descriptorPath: options.descriptorPath,
    currentPaneId,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const opened = await runCommand(executable, args, commandEnvironment, runner);
  if (!opened.ok) throw new Error("PROJECT_GLANCE_OPEN_FAILED");
  const paneId = parsePaneOpenOutput(opened.stdout);
  await registry.set(options.sessionKey, paneId);
  return { action: "opened", paneId };
}

export async function handleProjectGlanceCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: ProjectGlanceRelayRuntime,
): Promise<void> {
  try {
    const environment = process.env;
    const herdr = requireHerdrContext(environment);
    await runtime.ensureForContext(ctx);
    const descriptorPath = runtime.descriptorPath;
    const sessionKey = runtime.sessionKey;
    if (!descriptorPath || !sessionKey) throw new Error("PROJECT_GLANCE_RUNTIME_MISSING");
    const result = await openOrFocusProjectGlancePane({
      sessionKey,
      descriptorPath,
      currentPaneId: herdr.paneId,
      cwd: ctx.cwd,
      environment,
    });
    ctx.ui.notify(
      result.action === "opened"
        ? "Project Glance opened."
        : "Project Glance focused.",
      "info",
    );
  } catch {
    ctx.ui.notify("Project Glance could not open in the current Herdr pane.", "error");
  }
  void pi;
}
