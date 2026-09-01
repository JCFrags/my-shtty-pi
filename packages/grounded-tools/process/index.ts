import { isAbsolute, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundedOutput } from "@grounded/pi-core/output";
import { LocalSessionProvider } from "@grounded/pi-core/local-session";
import { ProcessManager, type ProcessSnapshot } from "@grounded/pi-core/process-manager";
import {
  SESSION_OPERATION_SERVICE_PROTOCOL_VERSION,
  SESSION_OPERATION_SERVICE_READY_EVENT,
  SESSION_OPERATION_SERVICE_REQUEST_EVENT,
  SESSION_OPERATION_SERVICE_V2_READY_EVENT,
  SESSION_OPERATION_SERVICE_V2_REQUEST_EVENT,
  SESSION_PROVIDER_PROTOCOL_VERSION,
  SESSION_PROVIDER_READY_EVENT,
  SESSION_PROVIDER_REGISTER_EVENT,
  SessionServiceError,
  type SessionOperationService,
  type SessionOperationServiceRequestEvent,
  type SessionOperationServiceV2,
  type SessionOperationServiceV2RequestEvent,
  type SessionProviderRegistrationEvent,
  type SessionProviderReadyEvent,
} from "@grounded/pi-core/session-contract";
import { cleanupOldSessionLogs } from "@grounded/pi-core/session-logs";
import { SessionRegistry, type SessionSnapshot } from "@grounded/pi-core/session-registry";

function processToolName(name: string): string {
  return process.env.GROUNDED_TRIAL_MODE === "1" ? `grounded_${name}` : name;
}

export const BashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 86400, description: "Maximum command lifetime in seconds" })),
  yieldMs: Type.Optional(
    Type.Number({ minimum: 0, maximum: 30000, description: "Return a process id if still running after this many milliseconds" }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Start and return immediately with a process id" })),
  pty: Type.Optional(Type.Boolean({ description: "Allocate a PTY through the bundled Python bridge on POSIX" })),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session cwd or absolute" })),
  sessionId: Type.Optional(Type.String({ description: "Explicit persistent session id; incompatible with cwd, background, yieldMs, and pty" })),
});

const MAX_STREAMING_VIEW_CHARS = 200_000;

export const ProcessParams = Type.Object({
  action: StringEnum(["list", "poll", "input", "interrupt", "kill"] as const),
  id: Type.Optional(Type.String({ description: "Process id for all actions except list" })),
  data: Type.Optional(Type.String({ description: "Text or C-style control escape for input" })),
  dataBase64: Type.Optional(Type.String({ description: "Exact base64 bytes for input" })),
  waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 30000 })),
  signal: Type.Optional(StringEnum(["SIGTERM", "SIGKILL", "SIGINT"] as const)),
});

export const SessionParams = Type.Object({
  action: StringEnum(["capabilities", "open", "list", "status", "input", "interrupt", "close"] as const),
  sessionId: Type.Optional(Type.String({ description: "Opaque session id for status, input, interrupt, and close" })),
  backend: Type.Optional(StringEnum(["local", "ssh"] as const)),
  target: Type.Optional(Type.String({ description: "Configured Native SSH target alias" })),
  cwd: Type.Optional(Type.String({ description: "Initial working directory" })),
  pty: Type.Optional(Type.Boolean({ description: "Request a PTY when the selected backend supports it" })),
  data: Type.Optional(Type.String({ description: "Literal UTF-8 terminal input text" })),
  dataBase64: Type.Optional(Type.String({ description: "Exact base64 terminal input bytes" })),
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

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SessionServiceError("SESSION_INPUT_INVALID", "dataBase64 must use canonical padded base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new SessionServiceError("SESSION_INPUT_INVALID", "dataBase64 must use canonical padded base64");
  }
  return bytes;
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

interface SessionToolDetails {
  capabilities: ReturnType<SessionRegistry["capabilities"]>;
  sessions: SessionSnapshot[];
  snapshot: SessionSnapshot | null;
}

function renderSessionOutput(result: Awaited<ReturnType<SessionRegistry["execute"]>>): string {
  const parts: Buffer[] = [];
  let stream: string | undefined;
  for (const chunk of result.chunks) {
    if (chunk.stream !== stream) {
      stream = chunk.stream;
      parts.push(Buffer.from(`${parts.length > 0 ? "\n" : ""}[${stream}]\n`, "utf8"));
    }
    parts.push(Buffer.from(chunk.dataBase64, "base64"));
  }
  return Buffer.concat(parts).toString("utf8");
}

function statusText(snapshot: ProcessSnapshot): string {
  const logError = snapshot.logError ? `\nlog_error: ${snapshot.logError}` : "";
  if (snapshot.running) return `[still running]\nprocess_id: ${snapshot.id}\npid: ${snapshot.pid ?? "unknown"}${logError}`;
  return `[exited]\nexit_code: ${snapshot.exitCode ?? "null"}${snapshot.signal ? `\nsignal: ${snapshot.signal}` : ""}${logError}`;
}

export default function groundedProcess(pi: ExtensionAPI) {
  const manager = new ProcessManager();
  const sessions = new SessionRegistry();
  sessions.registerProvider(new LocalSessionProvider());
  let currentContext: ExtensionContext | undefined;

  const registerSessionProvider = (provider: SessionProviderRegistrationEvent["provider"]) => sessions.registerProvider(provider);
  pi.events.on(SESSION_PROVIDER_REGISTER_EVENT, (value) => {
    const event = value as SessionProviderRegistrationEvent;
    if (event?.protocolVersion !== SESSION_PROVIDER_PROTOCOL_VERSION || !event.provider) {
      throw new SessionServiceError("SESSION_PROVIDER_VERSION_UNSUPPORTED", "Invalid session provider registration event");
    }
    registerSessionProvider(event.provider);
  });
  pi.events.emit(SESSION_PROVIDER_READY_EVENT, {
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    register: registerSessionProvider,
  } satisfies SessionProviderReadyEvent);

  const sessionOperationService: SessionOperationService = {
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    withLocalSession: (sessionId, operation, options) => sessions.withLocalSession(sessionId, operation, options),
  };
  pi.events.on(SESSION_OPERATION_SERVICE_REQUEST_EVENT, (value) => {
    const event = value as SessionOperationServiceRequestEvent;
    if (event?.protocolVersion !== SESSION_PROVIDER_PROTOCOL_VERSION || typeof event.accept !== "function") {
      throw new SessionServiceError("SESSION_SERVICE_VERSION_UNSUPPORTED", "Invalid session operation service request");
    }
    event.accept(sessionOperationService);
  });
  pi.events.emit(SESSION_OPERATION_SERVICE_READY_EVENT, sessionOperationService);

  const sessionOperationServiceV2: SessionOperationServiceV2 = {
    protocolVersion: SESSION_OPERATION_SERVICE_PROTOCOL_VERSION,
    withSession: (sessionId, operation, options) => sessions.withSession(sessionId, operation, options),
  };
  pi.events.on(SESSION_OPERATION_SERVICE_V2_REQUEST_EVENT, (value) => {
    const event = value as SessionOperationServiceV2RequestEvent;
    if (event?.protocolVersion !== SESSION_OPERATION_SERVICE_PROTOCOL_VERSION || typeof event.accept !== "function") {
      throw new SessionServiceError("SESSION_SERVICE_VERSION_UNSUPPORTED", "Invalid session operation service v2 request");
    }
    event.accept(sessionOperationServiceV2);
  });
  pi.events.emit(SESSION_OPERATION_SERVICE_V2_READY_EVENT, sessionOperationServiceV2);

  const refreshStatus = () => {
    const processCount = manager.runningCount();
    const sessionCount = sessions.list().length;
    const parts = [
      ...(processCount > 0 ? [`processes: ${processCount}`] : []),
      ...(sessionCount > 0 ? [`sessions: ${sessionCount}`] : []),
    ];
    currentContext?.ui.setStatus("grounded-process", parts.length > 0 ? parts.join(" · ") : undefined);
  };
  manager.setOnChange(refreshStatus);

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    await Promise.all([manager.cleanupOldLogs(), cleanupOldSessionLogs()]);
    refreshStatus();
  });
  pi.on("session_tree", async () => {
    await sessions.shutdown();
    refreshStatus();
  });
  pi.on("session_shutdown", async () => {
    await Promise.all([manager.shutdown(), sessions.shutdown()]);
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
      if (params.sessionId !== undefined) {
        const conflicts = (["cwd", "background", "yieldMs", "pty"] as const).filter((name) => params[name] !== undefined);
        if (conflicts.length > 0) {
          throw new SessionServiceError(
            "SESSION_BASH_ARGUMENT_CONFLICT",
            `bash sessionId cannot be combined with: ${conflicts.join(", ")}`,
          );
        }
        const result = await sessions.execute(params.sessionId, params.command, {
          ...(params.timeout !== undefined ? { timeoutMs: params.timeout * 1000 } : {}),
          ...(signal ? { signal } : {}),
        });
        const visible = renderSessionOutput(result);
        const bounded = await boundedOutput(visible, { prefix: "grounded-session-bash", direction: "tail" });
        const status = result.cancelled
          ? `[cancelled${result.timedOut ? ": timeout" : ""}]`
          : `[exited]\nexit_code: ${result.exitCode ?? "null"}${result.signal ? `\nsignal: ${result.signal}` : ""}`;
        return {
          content: [{
            type: "text",
            text: `${status}\nsession_id: ${params.sessionId}\nrequest_id: ${result.requestId}\nlog_path: ${result.logPath}\ncwd: ${result.cwd}${bounded.text ? `\n---\n${bounded.text}` : ""}`,
          }],
          details: {
            sessionId: params.sessionId,
            result,
            fullOutputPath: result.logPath,
            visibleFullOutputPath: bounded.fullOutputPath ?? null,
            visibleOutputTruncated: bounded.truncated,
          },
        };
      }
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

  pi.registerTool({
    name: "session",
    label: "Session",
    description: "Open and manage explicit persistent local or SSH shell sessions. Stateless bash remains the default. Capabilities report which backends and input modes are available.",
    promptSnippet: "Manage explicit persistent local or SSH shell sessions",
    promptGuidelines: [
      "Use session only when work needs state across commands; use bash for normal one-shot commands.",
      "Call session capabilities before requesting PTY input or an SSH backend.",
    ],
    parameters: SessionParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.action === "capabilities") {
        const capabilities = sessions.capabilities();
        return {
          content: [{ type: "text", text: JSON.stringify({ maximumLiveSessions: 4, capabilities }, null, 2) }],
          details: { capabilities, sessions: [], snapshot: null } as SessionToolDetails,
        };
      }
      if (params.action === "list") {
        const listed = sessions.list();
        return {
          content: [{
            type: "text",
            text: listed.length > 0
              ? listed.map((entry) => `${entry.id}\t${entry.backend}\t${entry.state}\t${entry.cwd}`).join("\n")
              : "No live sessions",
          }],
          details: { capabilities: sessions.capabilities(), sessions: listed, snapshot: null } as SessionToolDetails,
        };
      }
      if (params.action === "open") {
        if (!params.backend) throw new SessionServiceError("SESSION_BACKEND_REQUIRED", "backend is required for session action=open");
        if (params.backend === "local" && params.target !== undefined) {
          throw new SessionServiceError("SESSION_TARGET_INVALID", "target is valid only for backend=ssh");
        }
        if (params.backend === "ssh" && !params.target) {
          throw new SessionServiceError("SESSION_TARGET_REQUIRED", "target is required for backend=ssh");
        }
        if (params.backend === "ssh" && params.cwd !== undefined && !isAbsolute(params.cwd)) {
          throw new SessionServiceError("SESSION_CWD_INVALID", "SSH session cwd must be absolute");
        }
        const cwd = params.backend === "local" ? resolve(ctx.cwd, params.cwd ?? ctx.cwd) : params.cwd ?? "/";
        const snapshot = await sessions.open({
          backend: params.backend,
          cwd,
          env: sessionEnv(ctx),
          ...(params.pty !== undefined ? { pty: params.pty } : {}),
          ...(params.target !== undefined ? { target: params.target } : {}),
        });
        refreshStatus();
        return {
          content: [{ type: "text", text: `Opened ${snapshot.backend} session ${snapshot.id}\nstate: ${snapshot.state}\ncwd: ${snapshot.cwd}` }],
          details: { capabilities: sessions.capabilities(), sessions: [], snapshot } as SessionToolDetails,
        };
      }
      if (!params.sessionId) throw new SessionServiceError("SESSION_ID_REQUIRED", `sessionId is required for session action=${params.action}`);
      if (params.action === "status") {
        const snapshot = sessions.status(params.sessionId);
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
          details: { capabilities: sessions.capabilities(), sessions: [], snapshot } as SessionToolDetails,
        };
      }
      if (params.action === "input") {
        if ((params.data === undefined) === (params.dataBase64 === undefined)) {
          throw new SessionServiceError("SESSION_INPUT_INVALID", "Provide exactly one of data or dataBase64");
        }
        const bytes = params.dataBase64 !== undefined ? decodeCanonicalBase64(params.dataBase64) : Buffer.from(params.data!, "utf8");
        sessions.input(params.sessionId, bytes);
        const snapshot = sessions.status(params.sessionId);
        return {
          content: [{ type: "text", text: `Queued ${bytes.length} terminal input bytes for ${params.sessionId}` }],
          details: { capabilities: sessions.capabilities(), sessions: [], snapshot } as SessionToolDetails,
        };
      }
      if (params.action === "interrupt") {
        sessions.interrupt(params.sessionId);
        const snapshot = sessions.status(params.sessionId);
        return {
          content: [{ type: "text", text: `Interrupt requested for ${params.sessionId}` }],
          details: { capabilities: sessions.capabilities(), sessions: [], snapshot } as SessionToolDetails,
        };
      }
      await sessions.close(params.sessionId);
      refreshStatus();
      return {
        content: [{ type: "text", text: `Closed session ${params.sessionId}` }],
        details: { capabilities: sessions.capabilities(), sessions: [], snapshot: null } as SessionToolDetails,
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
