import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundedOutput } from "@grounded/pi-core/output";
import { ProcessManager, type ProcessSnapshot } from "@grounded/pi-core/process-manager";

function processToolName(name: string): string {
  return process.env.GROUNDED_TRIAL_MODE === "1" ? `grounded_${name}` : name;
}

const BashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 86400, description: "Maximum command lifetime in seconds" })),
  yieldMs: Type.Optional(
    Type.Number({ minimum: 0, maximum: 30000, description: "Return a process id if still running after this many milliseconds" }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Start and return immediately with a process id" })),
  pty: Type.Optional(Type.Boolean({ description: "Allocate a PTY through the bundled Python bridge on POSIX" })),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session cwd or absolute" })),
});

const MAX_STREAMING_VIEW_CHARS = 200_000;

const ProcessParams = Type.Object({
  action: StringEnum(["list", "poll", "input", "interrupt", "kill"] as const),
  id: Type.Optional(Type.String({ description: "Process id for all actions except list" })),
  data: Type.Optional(Type.String({ description: "Text or C-style control escape for input" })),
  dataBase64: Type.Optional(Type.String({ description: "Exact base64 bytes for input" })),
  waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 30000 })),
  signal: Type.Optional(StringEnum(["SIGTERM", "SIGKILL", "SIGINT"] as const)),
});

function decodeInput(value: string): Buffer {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char !== "\\" || index === value.length - 1) {
      result += char;
      continue;
    }
    const next = value[++index]!;
    if (next === "n") result += "\n";
    else if (next === "r") result += "\r";
    else if (next === "t") result += "\t";
    else if (next === "e") result += "\x1b";
    else if (next === "0") result += "\0";
    else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      result += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else result += `\\${next}`;
  }
  return Buffer.from(result);
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("dataBase64 is not valid base64");
  }
  return Buffer.from(value, "base64");
}

function sessionEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT: "true",
    PI_SESSION_ID: ctx.sessionManager.getSessionId(),
    ...(ctx.sessionManager.getSessionFile() ? { PI_SESSION_FILE: ctx.sessionManager.getSessionFile()! } : {}),
    ...(ctx.model ? { PI_PROVIDER: ctx.model.provider, PI_MODEL: ctx.model.id } : {}),
    PI_REASONING_LEVEL: ctx.thinkingLevel,
  };
}

interface ProcessToolDetails {
  sessions: ProcessSnapshot[];
  snapshot: ProcessSnapshot | null;
  fullOutputPath: string | null;
  visibleOutputTruncated: boolean;
}

function statusText(snapshot: ProcessSnapshot): string {
  const logError = snapshot.logError ? `\nlog_error: ${snapshot.logError}` : "";
  if (snapshot.running) return `[still running]\nprocess_id: ${snapshot.id}\npid: ${snapshot.pid ?? "unknown"}${logError}`;
  return `[exited]\nexit_code: ${snapshot.exitCode ?? "null"}${snapshot.signal ? `\nsignal: ${snapshot.signal}` : ""}${logError}`;
}

export default function groundedProcess(pi: ExtensionAPI) {
  const manager = new ProcessManager();
  let currentContext: ExtensionContext | undefined;

  const refreshStatus = () => {
    const count = manager.runningCount();
    currentContext?.ui.setStatus("grounded-process", count > 0 ? `processes: ${count}` : undefined);
  };
  manager.setOnChange(refreshStatus);

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    await manager.cleanupOldLogs();
    refreshStatus();
  });
  pi.on("session_shutdown", async () => {
    await manager.shutdown();
    currentContext = undefined;
  });

  pi.registerTool({
    name: processToolName("bash"),
    label: "bash (grounded)",
    description: "Execute shell commands without semantic compression. Commands wait normally unless background or yieldMs is requested. Exact output is bounded with a pointer to the complete log.",
    promptSnippet: "Run shell commands with optional yielding, background execution, PTY, and complete logs",
    promptGuidelines: [
      "Use bash normally for finite commands; set background=true or yieldMs only for commands expected to outlive the call.",
      "Use process to poll, drive, interrupt, or kill a yielded bash process.",
    ],
    parameters: BashParams,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      let streamUpdates = true;
      let streamedOutput = "";
      const snapshot = await manager.start({
        command: params.command,
        cwd,
        env: sessionEnv(ctx),
        ...(params.pty !== undefined ? { pty: params.pty } : {}),
        ...(params.timeout !== undefined ? { timeoutMs: params.timeout * 1000 } : {}),
        onData: (text) => {
          streamedOutput += text;
          if (streamedOutput.length > MAX_STREAMING_VIEW_CHARS) {
            streamedOutput = `[Earlier output omitted from this transient streaming view; the final result links the complete log.]\n${streamedOutput.slice(-MAX_STREAMING_VIEW_CHARS)}`;
          }
          if (streamUpdates) onUpdate?.({ content: [{ type: "text", text: streamedOutput }], details: {} });
        },
      });

      if (!params.background) {
        const onAbort = () => manager.kill(snapshot.id, "SIGTERM");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        try {
          await manager.wait(snapshot.id, params.yieldMs);
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }

      streamUpdates = false;
      const current = manager.get(snapshot.id)!;
      const drained = manager.drain(snapshot.id);
      const bounded = await boundedOutput(drained.output, { prefix: "grounded-bash", direction: "tail" });
      const dropped = drained.droppedBytes > 0
        ? `\n[${drained.droppedBytes} unread in-memory bytes were dropped; the complete stream remains in the log.]`
        : "";
      const output = `${statusText(current)}\nlog_path: ${current.logPath}\ncwd: ${current.cwd}${dropped}${bounded.text ? `\n---\n${bounded.text}` : ""}`;
      return {
        content: [{ type: "text", text: output }],
        details: {
          processId: current.id,
          pid: current.pid,
          running: current.running,
          exitCode: current.exitCode,
          signal: current.signal,
          cwd: current.cwd,
          pty: current.pty,
          fullOutputPath: current.logPath,
          visibleOutputTruncated: bounded.truncated,
        },
      };
    },
  });

  pi.registerTool({
    name: processToolName("process"),
    label: "Process",
    description: "List, poll, write exact input to, interrupt, or kill processes started by grounded bash. Poll output is exact and the complete stream remains in the process log.",
    promptSnippet: "Drive and inspect yielded shell processes",
    parameters: ProcessParams,
    executionMode: "sequential",
    async execute(_id, params) {
      if (params.action === "list") {
        const sessions = manager.list();
        return {
          content: [{
            type: "text",
            text: sessions.length
              ? sessions.map((entry) => `${entry.id}\t${entry.running ? "running" : `exit ${entry.exitCode}`}\t${entry.command}\t${entry.logPath}`).join("\n")
              : "No processes",
          }],
          details: {
            sessions,
            snapshot: null,
            fullOutputPath: null,
            visibleOutputTruncated: false,
          } as ProcessToolDetails,
        };
      }
      if (!params.id) throw new Error(`id is required for process action=${params.action}`);

      if (params.action === "input") {
        if ((params.data === undefined) === (params.dataBase64 === undefined)) {
          throw new Error("Provide exactly one of data or dataBase64");
        }
        const bytes = params.dataBase64 !== undefined ? decodeBase64(params.dataBase64) : decodeInput(params.data!);
        manager.input(params.id, bytes);
        if (params.waitMs) await manager.wait(params.id, params.waitMs);
      } else if (params.action === "poll") {
        await manager.wait(params.id, params.waitMs ?? 0);
      } else if (params.action === "interrupt") {
        manager.interrupt(params.id);
        if (params.waitMs) await manager.wait(params.id, params.waitMs);
      } else if (params.action === "kill") {
        manager.kill(params.id, params.signal ?? "SIGTERM");
        await manager.wait(params.id, params.waitMs ?? 2000);
      }

      const snapshot = manager.get(params.id)!;
      const drained = manager.drain(params.id);
      const bounded = await boundedOutput(drained.output, { prefix: "grounded-process", direction: "tail" });
      return {
        content: [{
          type: "text",
          text: `${statusText(snapshot)}\nlog_path: ${snapshot.logPath}${bounded.text ? `\n---\n${bounded.text}` : ""}`,
        }],
        details: {
          sessions: [],
          snapshot,
          fullOutputPath: snapshot.logPath,
          visibleOutputTruncated: bounded.truncated,
        } as ProcessToolDetails,
      };
    },
  });

  pi.registerCommand("grounded-processes", {
    description: "List grounded background processes",
    handler: async (_args, ctx) => {
      const sessions = manager.list();
      ctx.ui.notify(
        sessions.length
          ? sessions.map((entry) => `${entry.id}: ${entry.running ? "running" : `exit ${entry.exitCode}`} ${entry.command}`).join("\n")
          : "No processes",
        "info",
      );
    },
  });
}
