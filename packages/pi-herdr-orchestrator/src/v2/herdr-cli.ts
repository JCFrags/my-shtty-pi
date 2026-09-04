import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { JsonObject } from "./types.js";

const execFile = promisify(execFileCallback);
const MAX_BUFFER = 256 * 1024;

export class HerdrCliError extends Error {
  readonly code: string;
  readonly notFound: boolean;

  constructor(code: string, notFound = false) {
    super(code);
    this.name = "HerdrCliError";
    this.code = code;
    this.notFound = notFound;
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nestedObject(value: unknown, key: string): JsonObject | undefined {
  return object(object(value)?.[key]);
}

function errorCode(stderr: string): string | undefined {
  try {
    const parsed = object(JSON.parse(stderr));
    const error = object(parsed?.error);
    const code = error?.code ?? parsed?.code;
    if (typeof code === "string" && code.length > 0) return code;
  } catch {
    // Herdr normally emits JSON errors, but a command can fail before the API responds.
  }
  return undefined;
}

function isNotFound(code: string): boolean {
  return /(?:not[_-]?found|unknown[_-]?(?:agent|pane|tab)|missing)/iu.test(code);
}

function responseResult(value: unknown): JsonObject {
  return object(object(value)?.result) ?? object(value) ?? {};
}

function responseObject(value: unknown, key: string): JsonObject {
  return nestedObject(responseResult(value), key) ?? responseResult(value);
}

function environmentArgs(environment: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))
    args.push("--env", `${key}=${value}`);
  return args;
}

export class HerdrCli {
  readonly binary: string;

  constructor(binary = process.env.HERDR_BIN_PATH || "herdr") {
    this.binary = binary;
  }

  private async run(binary: string, args: string[]): Promise<string> {
    try {
      const result = await execFile(binary, args, {
        env: { ...process.env },
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
      });
      return result.stdout;
    } catch (cause: unknown) {
      const failure = cause as { code?: string | number; stderr?: unknown };
      const parsedCode =
        typeof failure.stderr === "string" ? errorCode(failure.stderr) : undefined;
      const systemCode = typeof failure.code === "string" ? failure.code : undefined;
      const code = parsedCode ?? (systemCode === "ENOENT" ? "HERDR_UNAVAILABLE" : "HERDR_COMMAND_FAILED");
      throw new HerdrCliError(code, isNotFound(code));
    }
  }

  private async json(args: string[]): Promise<unknown> {
    const stdout = (await this.run(this.binary, args)).trim();
    if (stdout.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout) as unknown;
    } catch {
      throw new HerdrCliError("HERDR_INVALID_JSON");
    }
    const parsedObject = object(parsed);
    const error = object(parsedObject?.error);
    const code = error?.code ?? parsedObject?.code;
    if (typeof code === "string" && code.length > 0)
      throw new HerdrCliError(code, isNotFound(code));
    return parsed;
  }

  async status(): Promise<void> {
    await this.run(this.binary, ["status"]);
  }

  async version(): Promise<string> {
    const output = await this.run(this.binary, ["--version"]);
    return output.trim().split(/\r?\n/u)[0]?.slice(0, 64) || "unknown";
  }

  async piVersion(): Promise<string | undefined> {
    try {
      const output = await this.run(process.env.PI_BIN_PATH || "pi", ["--version"]);
      return output.trim().split(/\r?\n/u)[0]?.slice(0, 64) || undefined;
    } catch {
      return undefined;
    }
  }

  async tabCreate(
    workspaceId: string,
    cwd: string,
    label: string,
    environment: Record<string, string>,
  ): Promise<{ tab: JsonObject; rootPane: JsonObject }> {
    const result = responseResult(
      await this.json([
        "tab", "create", "--workspace", workspaceId, "--cwd", cwd,
        "--label", label, "--no-focus", ...environmentArgs(environment),
      ]),
    );
    return {
      tab: nestedObject(result, "tab") ?? {},
      rootPane: nestedObject(result, "root_pane") ?? {},
    };
  }

  async tabGet(tabId: string): Promise<JsonObject> {
    return responseObject(await this.json(["tab", "get", tabId]), "tab");
  }

  async tabClose(tabId: string): Promise<JsonObject> {
    return responseResult(await this.json(["tab", "close", tabId]));
  }

  async paneCurrent(): Promise<JsonObject> {
    return responseObject(await this.json(["pane", "current", "--current"]), "pane");
  }

  async paneGet(paneId: string): Promise<JsonObject> {
    return responseObject(await this.json(["pane", "get", paneId]), "pane");
  }

  async paneList(workspaceId: string): Promise<JsonObject[]> {
    const result = responseResult(await this.json(["pane", "list", "--workspace", workspaceId]));
    const panes = result.panes;
    return Array.isArray(panes) ? panes.map(object).filter((pane): pane is JsonObject => pane !== undefined) : [];
  }

  async paneLayout(paneId: string): Promise<JsonObject> {
    return responseObject(await this.json(["pane", "layout", "--pane", paneId]), "layout");
  }

  async paneSplit(
    paneId: string,
    direction: "right" | "down",
    cwd: string,
    environment: Record<string, string>,
  ): Promise<JsonObject> {
    return responseObject(
      await this.json([
        "pane", "split", "--pane", paneId, "--direction", direction,
        "--cwd", cwd, "--no-focus", ...environmentArgs(environment),
      ]),
      "pane",
    );
  }

  async paneClose(paneId: string): Promise<JsonObject> {
    return responseResult(await this.json(["pane", "close", paneId]));
  }

  async agentGet(target: string): Promise<JsonObject> {
    return responseObject(await this.json(["agent", "get", target]), "agent");
  }

  async agentStart(name: string, paneId: string, extensionPath: string): Promise<JsonObject> {
    return responseObject(
      await this.json([
        "agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "30000",
        "--", "--extension", extensionPath,
      ]),
      "agent",
    );
  }

  async agentPrompt(target: string, text: string): Promise<JsonObject> {
    return responseResult(await this.json(["agent", "prompt", target, text]));
  }

  async agentInterrupt(target: string): Promise<JsonObject> {
    return responseResult(await this.json(["agent", "send-keys", target, "esc"]));
  }

  async agentRead(target: string, lines: number): Promise<string> {
    return this.run(this.binary, [
      "agent", "read", target, "--source", "recent-unwrapped",
      "--lines", String(lines), "--format", "text",
    ]);
  }
}
