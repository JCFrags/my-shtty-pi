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
    // Herdr normally emits JSON errors, but the command can fail before the API responds.
  }
  return undefined;
}

function isNotFound(code: string): boolean {
  return /(?:not[_-]?found|unknown[_-]?(?:agent|pane)|missing)/iu.test(code);
}

function responseResult(value: unknown): JsonObject {
  return object(object(value)?.result) ?? object(value) ?? {};
}

function responseObject(value: unknown, key: string): JsonObject {
  return nestedObject(responseResult(value), key) ?? responseResult(value);
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

  async paneCurrent(): Promise<JsonObject> {
    return responseObject(await this.json(["pane", "current", "--current"]), "pane");
  }

  async paneGet(paneId: string): Promise<JsonObject> {
    return responseObject(await this.json(["pane", "get", paneId]), "pane");
  }

  async paneSplit(
    paneId: string,
    cwd: string,
    environment: Record<string, string>,
  ): Promise<JsonObject> {
    const args = [
      "pane",
      "split",
      "--pane",
      paneId,
      "--direction",
      "right",
      "--cwd",
      cwd,
      "--no-focus",
    ];
    for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))
      args.push("--env", `${key}=${value}`);
    return responseObject(await this.json(args), "pane");
  }

  async paneClose(paneId: string): Promise<JsonObject> {
    return responseResult(await this.json(["pane", "close", paneId]));
  }

  async agentGet(target: string): Promise<JsonObject> {
    return responseObject(await this.json(["agent", "get", target]), "agent");
  }

  async agentStart(name: string, paneId: string): Promise<JsonObject> {
    return responseObject(
      await this.json([
        "agent",
        "start",
        name,
        "--kind",
        "pi",
        "--pane",
        paneId,
        "--timeout",
        "30000",
      ]),
      "agent",
    );
  }

  async agentPrompt(target: string, text: string): Promise<JsonObject> {
    return responseResult(await this.json(["agent", "prompt", target, text]));
  }

  async agentRead(target: string, lines: number): Promise<string> {
    return this.run(this.binary, [
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(lines),
      "--format",
      "text",
    ]);
  }
}
