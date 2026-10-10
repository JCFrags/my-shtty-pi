import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cliCommand } from "./launch.js";
import { PI_ORIGIN_ENV, launchInstruction, parsePiOrigin, selectedOwner } from "./owner-binding.js";
import type { BrowserOwnerMetadata, PiOrigin, SelectedOwner } from "./owner-binding.js";
const OUTPUT_LIMIT = 256 * 1024;

export interface ToolContext {
  cwd: string;
  sessionId: string;
  owner?: SelectedOwner;
  storageIdentity?: string;
  associationId?: string;
  branchIds?: string[];
  origin?: PiOrigin;
  signal?: AbortSignal;
}

export interface CommandRequest {
  args: string[];
  context: ToolContext;
  stdin?: string;
  timeoutMs?: number;
}

export type CommandRunner = (request: CommandRequest) => Promise<unknown>;

function ownerEnvironment(context: ToolContext): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TERMINAL_BROWSER_OWNER_")) delete environment[name];
  }
  if (context.origin) {
    const origin = parsePiOrigin(context.origin);
    if (origin.piSessionId !== context.sessionId) throw new Error("Browser launch origin does not match the current Pi conversation.");
    environment[PI_ORIGIN_ENV] = JSON.stringify(origin);
    environment.PI_SESSION_ID = context.sessionId;
  }
  const owner = context.owner;
  if (!owner) throw new Error("No browser associated. Use /browser Connect existing browser or Open/focus browser.");
  // A native association overrides Herdr. Never inherit the containing pane's route.
  if (owner.kind === "native") {
    delete environment.HERDR_ENV;
    delete environment.PI_SESSION_ID;
    return environment;
  }
  return {
    ...environment,
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: owner.workspaceId,
    HERDR_TAB_ID: owner.tabId,
    HERDR_PANE_ID: owner.paneId,
    TERMINAL_BROWSER_OWNER_WORKSPACE_ID: owner.workspaceId,
    TERMINAL_BROWSER_OWNER_TAB_ID: owner.tabId,
    TERMINAL_BROWSER_OWNER_PANE_ID: owner.paneId,
    TERMINAL_BROWSER_OWNER_SESSION_ID: context.sessionId,
    TERMINAL_BROWSER_OWNER_PROJECT_DIR: owner.projectDir,
  };
}

function executeCli({ args, context, stdin, timeoutMs = 30_000 }: CommandRequest, environment: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    if (context.signal?.aborted) return reject(new Error("Browser operation cancelled before dispatch."));
    const [command, commandArgs] = cliCommand(args);
    const child = spawn(command, commandArgs, {
      cwd: context.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (exceeded) return;
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > OUTPUT_LIMIT) {
        exceeded = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) abort();
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      if (context.signal?.aborted) return reject(new Error("Browser operation cancelled."));
      if (exceeded) return reject(new Error("Browser response exceeded its safe limit."));
      if (code !== 0) return reject(actionableError(stderr));
      try {
        resolveResult(JSON.parse(stdout));
      } catch {
        reject(new Error("Browser returned an invalid response."));
      }
    });
    child.stdin.end(stdin);
  });
}

const runCli: CommandRunner = request => {
  if (request.context.signal?.aborted) return Promise.reject(new Error("Browser operation cancelled before dispatch."));
  return executeCli(request, ownerEnvironment(request.context));
};

export function connectionEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...environment };
  for (const name of Object.keys(clean)) {
    if (name.startsWith("TERMINAL_BROWSER_OWNER_") || name.startsWith("HERDR_") ||
        name.startsWith("PI_SESSION_") || name === PI_ORIGIN_ENV) delete clean[name];
  }
  return clean;
}

/** Only this metadata command can run without a selected owner. It cannot launch a browser. */
export const connectionCommandRunner: CommandRunner = request => {
  if (request.args.length !== 2 || request.args[0] !== "daemon-status" || request.args[1] !== "--connections" || request.stdin !== undefined) {
    return Promise.reject(new Error("Unsupported browser connection discovery command."));
  }
  return executeCli({ ...request, timeoutMs: 5_000 }, connectionEnvironment());
};

export interface BrowserConnection {
  key: string;
  owner: BrowserOwnerMetadata | null;
  origin: PiOrigin | null;
  terminal: string | null;
  tab: string | null;
  pane: string | null;
}
export interface ConnectionInventory {
  schemaVersion: 1;
  instancesDirectory: string;
  identity: { instanceId: string } | null;
  matchesCandidate: boolean | null;
  sessions: BrowserConnection[];
  complete: true;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const cleanText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export const RUNTIME_REMEDY = "The loaded Pi browser package does not match the running browser artifact. Use terminal-browser doctor --json, then reload only this idle Pi session from the matching package. Do not launch a duplicate or replace the daemon.";

export function parseConnectionInventory(value: unknown): ConnectionInventory {
  const item = value as ConnectionInventory;
  if (!item || typeof item !== "object" || item.schemaVersion !== 1 || item.complete !== true ||
      !cleanText(item.instancesDirectory, 4096) || !isAbsolute(item.instancesDirectory) ||
      !Array.isArray(item.sessions) || item.sessions.length > 128 ||
      !(item.identity === null ? item.matchesCandidate === null && item.sessions.length === 0 :
        item.identity && typeof item.identity === "object" && cleanText(item.identity.instanceId, 128) && UUID.test(item.identity.instanceId) &&
        typeof item.matchesCandidate === "boolean")) throw new Error("Browser connection inventory is incomplete. Use terminal-browser doctor --json, then /browser Connect existing browser. No browser was selected.");
  if (item.matchesCandidate === false) throw new Error(RUNTIME_REMEDY);
  const keys = new Set<string>();
  const sessions = item.sessions.map(entry => {
    if (!entry || typeof entry !== "object" || !cleanText(entry.key, 256) || keys.has(entry.key) ||
        ![entry.terminal, entry.tab, entry.pane].every(place => place === null || cleanText(place, 128))) throw new Error("Invalid browser connection metadata.");
    keys.add(entry.key);
    if (entry.owner !== null) selectedOwner(entry.owner);
    const owner = entry.owner === null ? null : { workspaceId: entry.owner.workspaceId, tabId: entry.owner.tabId,
      paneId: entry.owner.paneId, sessionId: entry.owner.sessionId, projectDir: entry.owner.projectDir };
    return { key: entry.key, owner, origin: entry.origin === null ? null : parsePiOrigin(entry.origin),
      terminal: entry.terminal, tab: entry.tab, pane: entry.pane };
  });
  return { schemaVersion: 1, instancesDirectory: item.instancesDirectory, identity: item.identity === null ? null : { instanceId: item.identity.instanceId },
    matchesCandidate: item.matchesCandidate, sessions, complete: true };
}

export async function discoverConnections(context: ToolContext, run: CommandRunner = connectionCommandRunner): Promise<ConnectionInventory> {
  return parseConnectionInventory(await run({ context, args: ["daemon-status", "--connections"], timeoutMs: 5_000 }));
}

// Keep every adapter operation on the native CLI. Non-Herdr hosts attach only;
// a piped child process must not take over the terminal that is running Pi.
export function ownerCommandRunner(run: CommandRunner): CommandRunner {
  return async (request) => {
    if (request.context.signal?.aborted) throw new Error("Browser operation cancelled before dispatch.");
    const selected = request.context.owner;
    if (!selected) throw new Error("No browser associated. Use /browser Settings to select an exact owner.");
    // Run under the fixed launch directory, even after Pi changes its working directory.
    request = { ...request, context: { ...request.context, cwd: selected.projectDir } };
    if (selected.kind === "herdr") return run(request);
    const { args } = request;
    const owner = ["--session", selected.sessionId, "--project", selected.projectDir];
    const call = (command: string[]) => run({ ...request, args: [...command, ...owner] });
    if (args[0] === "agent" || args[0] === "session") return call(args);
    if (args[0] !== "companion") throw new Error("Unsupported Pi browser adapter command.");
    if (args[1] === "tabs") return call(["session", "tabs", ...args.slice(2)]);
    if (args[1] !== "open") throw new Error("Unsupported Pi browser companion command.");

    const list = () => call(["session", "tabs", "--action", "list"]);
    let value: unknown;
    try {
      value = await list();
    } catch (error) {
      if (error instanceof BrowserCommandError && error.code === "SESSION_NOT_FOUND") {
        throw new BrowserCommandError(error.code,
          `Launch the owned browser in a separate visible terminal, then open /browser again: ${launchInstruction(selected)}. Pi will not take over its own terminal.`);
      }
      throw error;
    }
    const url = args.slice(2).find(arg => arg !== "--new-tab" && arg !== "--no-focus");
    if (args.includes("--new-tab")) {
      value = await call(["session", "tabs", "--action", "open", "--url", url ?? "about:blank"]);
    } else if (url) {
      const status = await call(["agent", "status"]) as ControlStatus;
      if (!agentEligible(status.state)) throw new Error("Browser control is with the user. Resume only when the user explicitly asks.");
      const outcome = await call(["agent", "navigate", url, "--control-epoch", String(status.controlEpoch)]) as Record<string, unknown>;
      if (outcome.dialog) return { ...await list() as Record<string, unknown>, action: "reused", dialog: outcome.dialog };
      value = await list();
    }
    return { ...value as Record<string, unknown>, action: "reused" };
  };
}

export const defaultCommandRunner: CommandRunner = ownerCommandRunner(runCli);

export interface BrowserStartupReport {
  version: 1;
  attempt: string;
  state: "failed";
  code: string;
  message: string;
  pane: string | null;
  exitCode: number | null;
  signal: string | null;
  doctorCommand: "terminal-browser doctor --json";
  cleanup: { status: string; nextStep: string; error?: string };
}

export class BrowserStartupError extends Error {
  constructor(readonly report: BrowserStartupReport) {
    super(JSON.stringify(report));
    this.name = "BrowserStartupError";
  }
}

function parseStartupReport(message: string): BrowserStartupReport | null {
  if (Buffer.byteLength(message) > 16 * 1024) return null;
  try {
    const value = JSON.parse(message) as BrowserStartupReport;
    return value?.version === 1 && value.state === "failed" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.attempt) &&
      /^[A-Z0-9_]{1,64}$/.test(value.code) && typeof value.message === "string" && Buffer.byteLength(value.message) <= 8192 &&
      (value.pane === null || (typeof value.pane === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.pane))) &&
      (value.exitCode === null || (Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255)) &&
      (value.signal === null || (typeof value.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(value.signal))) &&
      value.doctorCommand === "terminal-browser doctor --json" &&
      ["not-attempted", "exited", "retained", "failed"].includes(value.cleanup?.status) &&
      typeof value.cleanup.nextStep === "string" && Buffer.byteLength(value.cleanup.nextStep) <= 4096 &&
      (value.cleanup.error === undefined || (typeof value.cleanup.error === "string" && Buffer.byteLength(value.cleanup.error) <= 4096)) ? value : null;
  } catch {
    return null;
  }
}

export class BrowserCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "BrowserCommandError";
  }
}

export function actionableError(stderr: string): Error {
  let message = stderr.replace(/^terminal-browser:\s*/u, "").trim();
  const startup = parseStartupReport(message);
  if (startup) return new BrowserStartupError(startup);
  let code: string | undefined;
  if (Buffer.byteLength(message) <= 16 * 1024) {
    try {
      const response = JSON.parse(message);
      if (response?.ok === false && /^[A-Z0-9_]{1,64}$/.test(response.error?.code) &&
          typeof response.error?.message === "string" && Buffer.byteLength(response.error.message) <= 8192) {
        code = response.error.code;
        message = response.error.message;
      }
    } catch {}
  }
  if (/runtime mismatch|runtime identity mismatch|runtime instance mismatch/iu.test(message)) {
    message = RUNTIME_REMEDY;
  } else if (code === "CONTROL_NOT_AGENT" || /agent control is human|agent control is paused|browser control is with the user/iu.test(message)) {
    message = "Browser control is with the user. Read browser_control status and resume only when the user explicitly asks.";
  } else if (code === "STATE_CHANGED" || /stale control epoch|page changed|stale or unknown observation/iu.test(message)) {
    message = "Browser state changed. Call browser_observe and inspect the outcome before deciding on another action.";
  } else if (code === "SESSION_NOT_FOUND" || /no browser companion/iu.test(message)) {
    message = "No owned browser is open. Call browser_open for launch or attachment guidance.";
  }
  return code ? new BrowserCommandError(code, message) : new Error(message || "Browser operation failed.");
}

export interface BrowserStateCache {
  frame?: string;
  frameIsMain?: boolean;
  contextId: number;
  observationId: string;
  controlEpoch: number;
  visual?: {
    width: number;
    height: number;
    rect: { x: number; y: number; width: number; height: number };
  };
}

export type LocatorSpec = Array<
  | { kind: "css" | "testid"; value: string }
  | { kind: "role"; value: string; name?: string; exact?: boolean }
  | { kind: "text" | "label" | "placeholder"; value: string; exact?: boolean }
  | { kind: "filter"; hasText: string }
  | { kind: "nth"; index: number }
>;
export type BrowserElementTarget = { ref: string } | { locator: LocatorSpec };
export type BrowserActionTarget = BrowserElementTarget | { x: number; y: number };
export type BlockingAction = "status" | "enable" | "disable" | "allow-site" | "block-site" | "clear-diagnostics" | "reload";

export type BrowserAction = { frame?: string } & (
  | { action: "dialog"; contextId?: number; dialogId: string; accept: boolean; text?: string }
  | ({ action: "upload"; files: string[] } & BrowserElementTarget)
  | ({ action: "click" } & BrowserElementTarget)
  | { action: "hover"; target: BrowserActionTarget }
  | { action: "drag"; from: BrowserActionTarget; to: BrowserActionTarget; button?: "left" | "middle" | "right" }
  | ({ action: "type"; text: string; replace?: boolean } & BrowserElementTarget)
  | { action: "press_key"; key: string }
  | { action: "scroll"; dy: number; dx?: number }
  | { action: "navigate"; url: string }
  | { action: "get_url" }
  | { action: "wait_for"; ref?: string; locator?: LocatorSpec; text?: string; condition?: "exists" | "visible" | "text" | "actionable"; timeoutMs?: number });

export type ControlMode = "agent" | "human" | "shared";
export function agentEligible(state: string): boolean { return state === "agent" || state === "shared"; }

export interface ControlStatus {
  state: ControlMode | "paused";
  controlEpoch: number;
  reason: string | null;
  busy: boolean;
  interactionStyle: "slow-natural";
}

function boundedDownload(value: unknown) {
  const item = value as Record<string, unknown>;
  if (!item || typeof item.id !== "string" || typeof item.contextId !== "number") throw new Error("Invalid download state");
  return { id: item.id.slice(0, 128), contextId: item.contextId, state: String(item.state).slice(0, 32), received: Number(item.received), total: Number(item.total), name: String(item.name).slice(0, 160), savePath: String(item.savePath).slice(0, 4096) };
}

function boundedTabs(value: unknown) {
  const tabs = (value as { tabs?: unknown[] })?.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.slice(0, 32).map((item) => {
    const tab = item as Record<string, unknown>;
    return {
      id: tab.id,
      contextId: tab.contextId,
      openerId: tab.openerId,
      kind: tab.kind,
      url: typeof tab.url === "string" ? tab.url.slice(0, 8192) : "",
      title: typeof tab.title === "string" ? tab.title.slice(0, 512) : "",
      active: tab.active === true,
    };
  });
}

function parseVisualState(value: Record<string, unknown>): NonNullable<BrowserStateCache["visual"]> {
  const rect = value.rect as Record<string, unknown> | undefined;
  const width = Number(value.width);
  const height = Number(value.height);
  const parsedRect = {
    x: Number(rect?.x),
    y: Number(rect?.y),
    width: Number(rect?.width),
    height: Number(rect?.height),
  };
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      !Object.values(parsedRect).every(Number.isFinite) || parsedRect.width <= 0 || parsedRect.height <= 0) {
    throw new Error("Browser returned invalid visual geometry.");
  }
  return { width, height, rect: parsedRect };
}

function targetArguments(
  observation: BrowserStateCache,
  target: BrowserActionTarget,
  prefix?: "from" | "to",
): string[] {
  if ("locator" in target) return [prefix ? `--${prefix}-locator-json` : "--locator-json", JSON.stringify(target.locator)];
  if ("ref" in target) return prefix ? [`--${prefix}-ref`, target.ref] : [target.ref];
  const visual = observation.visual;
  if (!visual) throw new Error("Coordinate actions require the latest visual browser_observe result.");
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y) ||
      target.x < 0 || target.y < 0 || target.x > visual.width || target.y > visual.height) {
    throw new Error("Action coordinates are outside the latest visual observation.");
  }
  const x = visual.rect.x + target.x * visual.rect.width / visual.width;
  const y = visual.rect.y + target.y * visual.rect.height / visual.height;
  return prefix
    ? [`--${prefix}-x`, String(x), `--${prefix}-y`, String(y)]
    : ["--x", String(x), "--y", String(y)];
}

export class PiBrowserClient {
  private observation: BrowserStateCache | null = null;
  private contextId: number | null = null;
  private pendingDialog: { id: string; contextId: number; controlEpoch: number } | null = null;
  private contextKey: string | null = null;
  private branchAnchor: string | undefined;

  private bindContext(context: ToolContext) {
    const key = JSON.stringify([context.sessionId, context.storageIdentity, context.associationId, context.owner ?? context.cwd]);
    const sameBranch = !this.branchAnchor || !context.branchIds || context.branchIds.includes(this.branchAnchor);
    this.branchAnchor = context.branchIds?.at(-1);
    if (key === this.contextKey && sameBranch) return;
    this.contextKey = key;
    this.observation = null;
    this.contextId = null;
    this.pendingDialog = null;
  }

  private cacheDialog(value: unknown) {
    this.pendingDialog = null;
    this.observation = null;
    const { controlEpoch, ...dialog } = value as Record<string, unknown>;
    if (typeof dialog.id !== "string" || !dialog.id ||
        typeof dialog.contextId !== "number" || !Number.isSafeInteger(dialog.contextId) || dialog.contextId < 1 ||
        typeof controlEpoch !== "number" || !Number.isSafeInteger(controlEpoch) || controlEpoch < 1) {
      throw new Error("Browser returned invalid dialog identity. Call browser_observe again.");
    }
    this.pendingDialog = { id: dialog.id, contextId: dialog.contextId, controlEpoch };
    this.contextId = dialog.contextId;
    return dialog;
  }

  constructor(private readonly runner: CommandRunner = defaultCommandRunner) {}

  async open(context: ToolContext, options: { url?: string; newTab?: boolean; focus?: boolean }) {
    this.bindContext(context);
    const args = ["companion", "open"];
    if (options.newTab) args.push("--new-tab");
    if (options.focus === false) args.push("--no-focus");
    if (options.url) args.push(options.url);
    const value = await this.runner({ args, context, timeoutMs: 30_000 }) as Record<string, unknown>;
    this.observation = null;
    this.pendingDialog = null;
    const tabs = boundedTabs(value);
    this.contextId = Number(tabs.find(tab => tab.active)?.id) || null;
    return { action: value.action, tabs, ...(value.dialog ? { dialog: this.cacheDialog(value.dialog), completed: false } : {}) };
  }

  async tabs(context: ToolContext, request: { action: "list" | "activate" | "open" | "close" | "wait" | "downloads" | "download_wait" | "download_cancel"; downloadId?: string; contextId?: number; url?: string; afterId?: number; timeoutMs?: number }) {
    this.bindContext(context);
    const args = ["companion", "tabs", "--action", request.action];
    if (request.contextId !== undefined) args.push("--tab", String(request.contextId));
    if (request.downloadId !== undefined) args.push("--download-id", request.downloadId);
    if (request.afterId !== undefined) args.push("--after-id", String(request.afterId));
    if (request.timeoutMs !== undefined) args.push("--timeout-ms", String(request.timeoutMs));
    if (request.url !== undefined) args.push("--url", request.url);
    const value = await this.runner({ args, context, timeoutMs: (request.action === "wait" || request.action === "download_wait") ? (request.timeoutMs ?? 10000) + 5000 : 30000 }) as Record<string, unknown>;
    if (request.action === "downloads") return { projectRoot: typeof value.projectRoot === "string" ? value.projectRoot.slice(0, 4096) : undefined, downloads: Array.isArray(value.downloads) ? value.downloads.slice(0, 64).map(boundedDownload) : [] };
    if (request.action === "download_wait" || request.action === "download_cancel") return { projectRoot: typeof value.projectRoot === "string" ? value.projectRoot.slice(0, 4096) : undefined, download: boundedDownload(value.download) };
    const tabs = boundedTabs(value);
    const active = Number(tabs.find(tab => tab.active)?.id) || null;
    if (active !== this.contextId || (request.action !== "list" && request.action !== "wait")) {
      this.observation = null;
      this.pendingDialog = null;
    }
    this.contextId = active;
    return { tabs, ...(value.dialog ? { dialog: this.cacheDialog(value.dialog), completed: false } : {}), ...(request.action === "wait" ? { matched: value.matched === true } : {}) };
  }

  async observe(context: ToolContext, options: {
    frame?: string;
    contextId?: number;
    maxElements?: number;
    includeText?: boolean;
    view?: "semantic" | "visual" | "both";
    scope?: "viewport" | "element";
    filter?: LocatorSpec;
    ref?: string;
  } = {}) {
    this.bindContext(context);
    const view = options.view ?? "semantic";
    const scope = options.scope ?? "viewport";
    const args = [
      "agent", "observe",
      "--max-elements", String(options.maxElements ?? 120),
      "--view", view,
      "--scope", scope,
    ];
    const contextId = options.contextId ?? this.contextId;
    if (contextId !== null) args.push("--tab", String(contextId));
    if (options.frame) args.push("--frame", options.frame);
    if (options.includeText === false) args.push("--no-text");
    if (options.ref) args.push("--ref", options.ref);
    if (options.filter) args.push("--filter-json", JSON.stringify(options.filter));
    let directory: string | null = null;
    let imagePath: string | null = null;
    if (view !== "semantic") {
      directory = await mkdtemp(join(tmpdir(), "pi-terminal-browser-"));
      imagePath = join(directory, "observation.png");
      args.push("--image-output", imagePath);
    }
    try {
      const value = await this.runner({ args, context }) as Record<string, unknown>;
      if (value.dialog) {
        const dialog = this.cacheDialog(value.dialog);
        return { contextId: dialog.contextId, dialog, completed: false };
      }
      this.pendingDialog = null;
      const snapshot = value.snapshot as Record<string, unknown>;
      const elements = Array.isArray(snapshot?.elements) ? snapshot.elements.slice(0, options.maxElements ?? 120) : [];
      const visual = value.visual && typeof value.visual === "object"
        ? value.visual as Record<string, unknown>
        : undefined;
      this.observation = {
        contextId: Number(value.contextId),
        ...(typeof value.frame === "string" ? { frame: value.frame, frameIsMain: Array.isArray(value.frames) && value.frames.some(frame => frame.ref === value.frame && !frame.parent) } : {}),
        observationId: String(value.observationId),
        controlEpoch: Number(value.controlEpoch),
        ...(visual ? { visual: parseVisualState(visual) } : {}),
      };
      if (!Number.isSafeInteger(this.observation.contextId) || this.observation.contextId < 1) throw new Error("Browser returned no context ID.");
      this.contextId = this.observation.contextId;
      const semantic = {
        url: typeof snapshot.url === "string" ? snapshot.url.slice(0, 8192) : "",
        title: typeof snapshot.title === "string" ? snapshot.title.slice(0, 512) : "",
        viewport: snapshot.viewport,
        elements,
        ...(typeof snapshot.text === "string" ? { text: snapshot.text.slice(0, 12_000) } : {}),
        truncated: typeof snapshot.text === "string" && snapshot.text.length > 12_000,
      };
      const image = imagePath ? await readFile(imagePath) : null;
      return {
        contextId: this.contextId,
        ...(typeof value.frame === "string" ? { frame: value.frame, frames: Array.isArray(value.frames) ? value.frames.slice(0,24).map(frame => ({ ref: String(frame.ref).slice(0,10), ...(typeof frame.parent === "string" ? { parent: frame.parent.slice(0,10) } : {}), name: String(frame.name ?? "").slice(0,100), url: String(frame.url ?? "").slice(0,500), selected: frame.selected === true })) : [], framesTruncated: value.framesTruncated === true } : {}),
        ...(view === "visual" ? {
          url: semantic.url,
          title: semantic.title,
          viewport: semantic.viewport,
        } : semantic),
        ...(visual ? { visual } : {}),
        ...(image ? { image: { data: image.toString("base64"), mimeType: "image/png" as const } } : {}),
      };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  private async status(context: ToolContext): Promise<ControlStatus> {
    this.bindContext(context);
    const status = await this.runner({ args: ["agent", "status"], context }) as ControlStatus;
    if (!agentEligible(status.state) || (this.pendingDialog && this.pendingDialog.controlEpoch !== status.controlEpoch)) {
      this.pendingDialog = null;
      this.observation = null;
    }
    return status;
  }

  async control(context: ToolContext, action: "status" | "pause" | "resume" | "mode", mode?: ControlMode) {
    if (action === "mode" && !mode) throw new Error("mode selection requires agent, human, or shared");
    const before = await this.status(context);
    const { controlEpoch: _epoch, ...visibleBefore } = before;
    if (action === "status") return visibleBefore;
    if (action === "mode") {
      const result = await this.runner({ args: ["agent", "control", "--mode", mode!, "--control-epoch", String(before.controlEpoch)], context }) as ControlStatus;
      this.observation = null;
      this.pendingDialog = null;
      const { controlEpoch: _epoch, ...visibleResult } = result;
      return visibleResult;
    }
    if (action === "pause") {
      const result = await this.runner({
        args: ["agent", "pause", "--control-epoch", String(before.controlEpoch)], context,
      }) as ControlStatus;
      this.observation = null;
      this.pendingDialog = null;
      const { controlEpoch: _epoch, ...visibleResult } = result;
      return visibleResult;
    }
    const result = before.state === "agent" ? before : await this.runner({
      args: ["agent", "resume", "--control-epoch", String(before.controlEpoch)], context,
    }) as ControlStatus;
    this.pendingDialog = null;
    const observation = await this.observe(context);
    const { controlEpoch: _resultEpoch, ...visibleResult } = result;
    return { ...visibleResult, observationReady: !observation.dialog, url: "url" in observation ? observation.url : undefined, ...(observation.dialog ? { dialog: observation.dialog } : {}) };
  }

  async blocking(context: ToolContext, request: { action: BlockingAction; site?: string; contextId?: number }) {
    this.bindContext(context);
    const args = ["agent", "blocking", request.action];
    if (request.site !== undefined) args.push("--site", request.site);
    const targetContext = request.contextId ?? this.contextId;
    if (targetContext !== null) args.push("--tab", String(targetContext));
    if (request.action !== "status") {
      const status = await this.status(context);
      if (!agentEligible(status.state)) throw new Error("Browser control is with the user. Resume only when the user explicitly asks.");
      args.push("--control-epoch", String(status.controlEpoch));
      this.observation = null;
      this.pendingDialog = null;
    }
    return this.runner({ args, context });
  }

  async act(context: ToolContext, request: BrowserAction) {
    const status = await this.status(context);
    if (!agentEligible(status.state)) {
      throw new Error("Browser control is with the user. Wait for control to be returned, or call browser_control with resume when asked.");
    }
    if (request.frame !== undefined && ["navigate", "get_url", "dialog"].includes(request.action)) throw new Error("Frame selection applies to observed element and pointer actions; omit frame for context navigation, URL, or dialogs.");
    if (request.action === "dialog") {
      const dialog = this.pendingDialog;
      if (!dialog || dialog.id !== request.dialogId ||
          (request.contextId !== undefined && request.contextId !== dialog.contextId)) {
        throw new Error("Stale or unknown dialog. Call browser_observe before responding.");
      }
      await this.runner({
        args: ["agent", "dialog", "--tab", String(dialog.contextId), "--dialog-id", dialog.id,
          "--control-epoch", String(dialog.controlEpoch), request.accept ? "--accept" : "--dismiss",
          ...(request.text !== undefined ? ["--stdin"] : [])],
        context, ...(request.text !== undefined ? { stdin: request.text } : {}),
      });
      this.observation = null;
      if (this.pendingDialog === dialog) this.pendingDialog = null;
      return { contextId: dialog.contextId, completed: true };
    }
    if (request.frame !== undefined && request.frame !== this.observation?.frame && !(request.frame === "main" && this.observation?.frameIsMain)) throw new Error("Frame must match the current observation. Call browser_observe with frame first.");
    const args = ["agent"];
    const needsObservation = request.action !== "navigate" && request.action !== "get_url";
    if (needsObservation) {
      if (!this.observation || this.observation.controlEpoch !== status.controlEpoch) {
        this.observation = null;
        throw new Error("Call browser_observe before this action so it uses the current page state.");
      }
    }
    if (request.action === "upload") args.push("upload", ...targetArguments(this.observation!, request), "--files-json", JSON.stringify(request.files));
    if (request.action === "click") args.push("click", ...targetArguments(this.observation!, request));
    if (request.action === "hover") {
      args.push("hover", ...targetArguments(this.observation!, request.target));
    }
    if (request.action === "drag") {
      args.push("drag", ...targetArguments(this.observation!, request.from, "from"),
        ...targetArguments(this.observation!, request.to, "to"));
      if (request.button) args.push("--button", request.button);
    }
    if (request.action === "type") args.push("type", ...targetArguments(this.observation!, request), "--stdin", ...(request.replace ? ["--replace"] : []));
    if (request.action === "press_key") args.push("press-key", request.key);
    if (request.action === "scroll") args.push("scroll", "--dy", String(request.dy), "--dx", String(request.dx ?? 0));
    if (request.action === "navigate") args.push("navigate", request.url);
    if (request.action === "get_url") args.push("get-url");
    if (request.action === "wait_for") {
      args.push("wait-for");
      if (request.ref) args.push("--ref", request.ref);
      if (request.locator) args.push("--locator-json", JSON.stringify(request.locator));
      if (request.text) args.push("--text", request.text);
      if (request.condition) args.push("--condition", request.condition);
      if (request.timeoutMs !== undefined) args.push("--timeout-ms", String(request.timeoutMs));
    }
    if (this.observation && needsObservation) {
      args.push("--observation", this.observation.observationId);
    }
    const targetContext = this.observation?.contextId ?? this.contextId;
    if (targetContext !== null) args.push("--tab", String(targetContext));
    args.push("--control-epoch", String(status.controlEpoch));
    let value: Record<string, unknown>;
    try {
      value = await this.runner({
      args,
      context,
      ...(request.action === "type" ? { stdin: request.text } : {}),
      timeoutMs: request.action === "wait_for" ? (request.timeoutMs ?? 10_000) + 5_000 : 300_000,
      }) as Record<string, unknown>;
    } catch (error) {
      if (needsObservation) {
        this.observation = null;
        const message = error instanceof Error ? error.message : "Browser operation failed.";
        if (!/browser_observe|control is with the user/i.test(message)) {
          throw new Error(`${message} Call browser_observe and inspect the outcome before deciding on another action.`);
        }
      }
      throw error;
    }
    if (value.dialog) {
      const dialog = this.cacheDialog(value.dialog);
      return { action: request.action, completed: false, contextId: dialog.contextId, dialog };
    }
    if (value.openedContextId) { this.observation = null; this.pendingDialog = null; return { action: request.action, completed: false, openedContextId: value.openedContextId }; }
    if (request.action !== "get_url") this.pendingDialog = null;
    if (request.action !== "get_url" && request.action !== "wait_for") this.observation = null;
    if (request.action === "get_url") return { url: typeof value.url === "string" ? value.url.slice(0, 8192) : "" };
    if (request.action === "wait_for") return { matched: value.matched === true, condition: value.condition };
    if (request.action === "scroll") return { action: request.action, completed: true, completion: "input-dispatched", movementMeasured: false };
    return { action: request.action, completed: true };
  }
}
