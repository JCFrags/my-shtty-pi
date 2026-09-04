import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
const MAX_BUFFER = 256 * 1024;
export class HerdrCliError extends Error {
    code;
    notFound;
    constructor(code, notFound = false) {
        super(code);
        this.name = "HerdrCliError";
        this.code = code;
        this.notFound = notFound;
    }
}
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function nestedObject(value, key) {
    return object(object(value)?.[key]);
}
function errorCode(stderr) {
    try {
        const parsed = object(JSON.parse(stderr));
        const error = object(parsed?.error);
        const code = error?.code ?? parsed?.code;
        if (typeof code === "string" && code.length > 0)
            return code;
    }
    catch {
        // Herdr normally emits JSON errors, but a command can fail before the API responds.
    }
    return undefined;
}
function isNotFound(code) {
    return /(?:not[_-]?found|unknown[_-]?(?:agent|pane|tab)|missing)/iu.test(code);
}
function responseResult(value) {
    return object(object(value)?.result) ?? object(value) ?? {};
}
function responseObject(value, key) {
    return nestedObject(responseResult(value), key) ?? responseResult(value);
}
function environmentArgs(environment) {
    const args = [];
    for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))
        args.push("--env", `${key}=${value}`);
    return args;
}
export class HerdrCli {
    binary;
    constructor(binary = process.env.HERDR_BIN_PATH || "herdr") {
        this.binary = binary;
    }
    async run(binary, args) {
        try {
            const result = await execFile(binary, args, {
                env: { ...process.env },
                encoding: "utf8",
                maxBuffer: MAX_BUFFER,
            });
            return result.stdout;
        }
        catch (cause) {
            const failure = cause;
            const parsedCode = typeof failure.stderr === "string"
                ? errorCode(failure.stderr)
                : undefined;
            const systemCode = typeof failure.code === "string" ? failure.code : undefined;
            const code = parsedCode ??
                (systemCode === "ENOENT"
                    ? "HERDR_UNAVAILABLE"
                    : "HERDR_COMMAND_FAILED");
            throw new HerdrCliError(code, isNotFound(code));
        }
    }
    async json(args) {
        const stdout = (await this.run(this.binary, args)).trim();
        if (stdout.length === 0)
            return {};
        let parsed;
        try {
            parsed = JSON.parse(stdout);
        }
        catch {
            throw new HerdrCliError("HERDR_INVALID_JSON");
        }
        const parsedObject = object(parsed);
        const error = object(parsedObject?.error);
        const code = error?.code ?? parsedObject?.code;
        if (typeof code === "string" && code.length > 0)
            throw new HerdrCliError(code, isNotFound(code));
        return parsed;
    }
    async status() {
        await this.run(this.binary, ["status"]);
    }
    async version() {
        const output = await this.run(this.binary, ["--version"]);
        return output.trim().split(/\r?\n/u)[0]?.slice(0, 64) || "unknown";
    }
    async piVersion() {
        try {
            const output = await this.run(process.env.PI_BIN_PATH || "pi", [
                "--version",
            ]);
            return output.trim().split(/\r?\n/u)[0]?.slice(0, 64) || undefined;
        }
        catch {
            return undefined;
        }
    }
    async tabCreate(workspaceId, cwd, label, environment) {
        const result = responseResult(await this.json([
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            cwd,
            "--label",
            label,
            "--no-focus",
            ...environmentArgs(environment),
        ]));
        return {
            tab: nestedObject(result, "tab") ?? {},
            rootPane: nestedObject(result, "root_pane") ?? {},
        };
    }
    async tabGet(tabId) {
        return responseObject(await this.json(["tab", "get", tabId]), "tab");
    }
    async tabClose(tabId) {
        return responseResult(await this.json(["tab", "close", tabId]));
    }
    async paneCurrent() {
        return responseObject(await this.json(["pane", "current", "--current"]), "pane");
    }
    async paneGet(paneId) {
        return responseObject(await this.json(["pane", "get", paneId]), "pane");
    }
    async paneList(workspaceId) {
        const result = responseResult(await this.json(["pane", "list", "--workspace", workspaceId]));
        const panes = result.panes;
        return Array.isArray(panes)
            ? panes
                .map(object)
                .filter((pane) => pane !== undefined)
            : [];
    }
    async paneLayout(paneId) {
        return responseObject(await this.json(["pane", "layout", "--pane", paneId]), "layout");
    }
    async paneSplit(paneId, direction, cwd, environment) {
        return responseObject(await this.json([
            "pane",
            "split",
            "--pane",
            paneId,
            "--direction",
            direction,
            "--cwd",
            cwd,
            "--no-focus",
            ...environmentArgs(environment),
        ]), "pane");
    }
    async paneClose(paneId) {
        return responseResult(await this.json(["pane", "close", paneId]));
    }
    async agentGet(target) {
        return responseObject(await this.json(["agent", "get", target]), "agent");
    }
    async agentStart(name, paneId, extensionPath) {
        const args = [
            "agent",
            "start",
            name,
            "--kind",
            "pi",
            "--pane",
            paneId,
            "--timeout",
            "30000",
        ];
        if (extensionPath)
            args.push("--", "--extension", extensionPath);
        return responseObject(await this.json(args), "agent");
    }
    async agentPrompt(target, text) {
        return responseResult(await this.json(["agent", "prompt", target, text]));
    }
    async agentInterrupt(target) {
        return responseResult(await this.json(["agent", "send-keys", target, "esc"]));
    }
    async agentRead(target, lines) {
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
