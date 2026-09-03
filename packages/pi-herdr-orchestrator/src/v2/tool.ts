import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli, HerdrCliError } from "./herdr-cli.js";
import { RegistryError, RegistryStore } from "./store.js";
import {
  CANARY_PROTOCOL,
  CANARY_VERSION,
  type AgentRecord,
  type JsonObject,
  type OrchestrateV2Params,
  type ParentIdentity,
} from "./types.js";

const execFile = promisify(execFileCallback);
const MAX_TASK_BYTES = 8192;
const MAX_MESSAGE_BYTES = 8192;
const MAX_LABEL_BYTES = 160;
const MAX_PATH_BYTES = 4096;
const MAX_LINES = 40;
const CAPABILITIES = {
  visiblePaneCreation: true,
  namedAgentStart: true,
  prompt: true,
  inspectRead: true,
  close: true,
} as const;

const stringProperty = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const ORCHESTRATE_V2_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["action"], properties: { action: { const: "health" } } },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "task"],
      properties: { action: { const: "spawn" }, task: stringProperty(MAX_TASK_BYTES), label: stringProperty(MAX_LABEL_BYTES), cwd: stringProperty(MAX_PATH_BYTES) },
    },
    { type: "object", additionalProperties: false, required: ["action"], properties: { action: { const: "list" } } },
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: { action: { const: "inspect" }, agentId: stringProperty(128), runId: stringProperty(128), lines: { type: "integer", minimum: 1, maximum: MAX_LINES } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "agentId", "message"],
      properties: { action: { const: "send" }, agentId: stringProperty(128), message: stringProperty(MAX_MESSAGE_BYTES) },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "agentId"],
      properties: { action: { const: "close" }, agentId: stringProperty(128) },
    },
  ],
} as const;

type PiContext = { cwd: string };
type ToolRegistration = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: PiContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: JsonObject }>;
};
type CanaryApi = { registerTool(tool: ToolRegistration): void };

class CanaryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CanaryError";
    this.code = code;
  }
}

interface V2Context {
  cli: HerdrCli;
  parent: ParentIdentity;
  store: RegistryStore;
}

type IdentityResult =
  | { kind: "present"; agent: JsonObject; pane: JsonObject; attention: string }
  | { kind: "absent" }
  | { kind: "mismatch" };

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown, maxBytes: number, allowWhitespace = true): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes)
    throw new CanaryError("INVALID_REQUEST");
  const invalid = allowWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (invalid.test(value)) throw new CanaryError("INVALID_REQUEST");
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function idFrom(value: unknown, key: string): string | undefined {
  return stringValue(object(value)?.[key]);
}

function now(): string {
  return new Date().toISOString();
}

function attention(agent: JsonObject): string {
  const value = stringValue(agent.agent_status);
  return value && value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "unknown";
}

function paneAgentName(pane: JsonObject): string | undefined {
  const direct = stringValue(pane.name) ?? stringValue(pane.agent_name);
  if (direct) return direct;
  return stringValue(object(pane.agent_session)?.name);
}

function isNotFound(error: unknown): boolean {
  return error instanceof HerdrCliError && error.notFound;
}

function publicError(error: unknown): CanaryError {
  if (error instanceof CanaryError) return error;
  if (error instanceof RegistryError) return new CanaryError(error.code);
  if (error instanceof HerdrCliError) return new CanaryError(error.code);
  return new CanaryError("V2_OPERATION_FAILED");
}

async function projectRoot(cwd: string): Promise<string> {
  try {
    const result = await execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024,
    });
    const root = result.stdout.trim();
    if (root && isAbsolute(root)) return resolve(root);
  } catch {
    // A non-repository cwd is still a valid Herdr working directory.
  }
  return resolve(cwd);
}

function parentFromPane(pane: JsonObject): ParentIdentity {
  const workspaceId = idFrom(pane, "workspace_id") ?? process.env.HERDR_WORKSPACE_ID;
  const tabId = idFrom(pane, "tab_id") ?? process.env.HERDR_TAB_ID;
  const paneId = idFrom(pane, "pane_id") ?? process.env.HERDR_PANE_ID;
  if (!workspaceId || !tabId || !paneId) throw new CanaryError("HERDR_CONTEXT_INCOMPLETE");
  for (const [name, actual, expected] of [
    ["workspace", workspaceId, process.env.HERDR_WORKSPACE_ID],
    ["tab", tabId, process.env.HERDR_TAB_ID],
    ["pane", paneId, process.env.HERDR_PANE_ID],
  ] as const)
    if (expected && actual !== expected) throw new CanaryError(`PARENT_${name.toUpperCase()}_MISMATCH`);
  return { workspaceId, tabId, paneId };
}

async function requireContext(context: PiContext): Promise<V2Context> {
  if (process.env.HERDR_ENV !== "1") throw new CanaryError("NOT_IN_HERDR");
  if (!process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID)
    throw new CanaryError("HERDR_CONTEXT_INCOMPLETE");
  const cli = new HerdrCli();
  const pane = await cli.paneCurrent();
  const parent = parentFromPane(pane);
  const root = await projectRoot(context.cwd);
  const store = new RegistryStore(root, parent);
  await store.load();
  return { cli, parent, store };
}

async function identity(cli: HerdrCli, agent: AgentRecord): Promise<IdentityResult> {
  let herdrAgent: JsonObject;
  try {
    herdrAgent = await cli.agentGet(agent.herdrAgentName);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    try {
      await cli.paneGet(agent.paneId);
    } catch (paneError) {
      if (isNotFound(paneError)) return { kind: "absent" };
      throw paneError;
    }
    return { kind: "mismatch" };
  }

  if (idFrom(herdrAgent, "pane_id") !== agent.paneId) return { kind: "mismatch" };
  if (stringValue(herdrAgent.name) && herdrAgent.name !== agent.herdrAgentName)
    return { kind: "mismatch" };
  let pane: JsonObject;
  try {
    pane = await cli.paneGet(agent.paneId);
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    throw error;
  }
  if (idFrom(pane, "pane_id") !== agent.paneId) return { kind: "mismatch" };
  const currentName = paneAgentName(pane);
  if (currentName && currentName !== agent.herdrAgentName) return { kind: "mismatch" };
  return { kind: "present", agent: herdrAgent, pane, attention: attention(herdrAgent) };
}

function recordView(agent: AgentRecord, identityState?: IdentityResult["kind"]): JsonObject {
  return {
    agentId: agent.agentId,
    agentName: agent.herdrAgentName,
    runId: agent.runId,
    assignmentGeneration: agent.assignmentGeneration,
    paneId: agent.paneId,
    processState: agent.processState,
    herdrAttention: agent.herdrAttention,
    delegatedRunPhase: agent.runPhase,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    label: agent.label,
    ...(identityState ? { identityState } : {}),
  };
}

async function refresh(
  store: RegistryStore,
  cli: HerdrCli,
  agent: AgentRecord,
): Promise<{ agent: AgentRecord; identityState: IdentityResult["kind"] }> {
  if (agent.processState === "closed") return { agent, identityState: "absent" };
  const result = await identity(cli, agent);
  if (result.kind === "present") {
    const updated = await store.updateAgent(agent.agentId, {
      processState: "live",
      herdrAttention: result.attention,
    });
    return { agent: updated, identityState: "present" };
  }
  const updated = await store.updateAgent(agent.agentId, {
    processState: result.kind === "absent" ? "missing" : "missing",
    runPhase: agent.runPhase === "closed" || agent.runPhase === "failed" ? agent.runPhase : "unknown",
    herdrAttention: "unknown",
  });
  return { agent: updated, identityState: result.kind };
}

function parseParams(value: unknown): OrchestrateV2Params {
  const params = object(value);
  const action = stringValue(params?.action) as OrchestrateV2Params["action"] | undefined;
  if (!action || !["health", "spawn", "list", "inspect", "send", "close"].includes(action))
    throw new CanaryError("INVALID_REQUEST");
  return {
    action,
    ...(params?.task !== undefined ? { task: text(params.task, MAX_TASK_BYTES) } : {}),
    ...(params?.label !== undefined ? { label: text(params.label, MAX_LABEL_BYTES, false) } : {}),
    ...(params?.cwd !== undefined ? { cwd: text(params.cwd, MAX_PATH_BYTES, false) } : {}),
    ...(params?.agentId !== undefined ? { agentId: text(params.agentId, 128, false) } : {}),
    ...(params?.runId !== undefined ? { runId: text(params.runId, 128, false) } : {}),
    ...(params?.message !== undefined ? { message: text(params.message, MAX_MESSAGE_BYTES) } : {}),
    ...(params?.lines !== undefined ? { lines: params.lines as number } : {}),
  };
}

function requireAgentId(params: OrchestrateV2Params): string {
  if (!params.agentId) throw new CanaryError("AGENT_ID_REQUIRED");
  return params.agentId;
}

async function health(context: PiContext): Promise<JsonObject> {
  const cli = new HerdrCli();
  const [herdrVersion, piVersion] = await Promise.all([
    cli.version().catch(() => undefined),
    cli.piVersion(),
  ]);
  const inside = process.env.HERDR_ENV === "1";
  let running = false;
  if (inside) running = await cli.status().then(() => true).catch(() => false);
  const base: JsonObject = {
    ok: true,
    canaryProtocol: CANARY_PROTOCOL,
    canaryVersion: CANARY_VERSION,
    domainId: null,
    parent: null,
    piVersion: piVersion ?? null,
    herdrVersion: herdrVersion ?? null,
    capabilities:
      running && inside && process.env.HERDR_SOCKET_PATH && process.env.HERDR_PANE_ID
        ? CAPABILITIES
        : Object.fromEntries(Object.keys(CAPABILITIES).map((key) => [key, false])),
    registryPath: null,
    trackedAgentCount: 0,
  };
  if (!inside) return { ...base, ok: false, errorCode: "NOT_IN_HERDR" };
  if (!running) return { ...base, ok: false, errorCode: "HERDR_UNAVAILABLE" };
  try {
    const current = await requireContext(context);
    const agents = await current.store.list();
    return {
      ...base,
      domainId: current.store.domainId,
      parent: current.parent,
      registryPath: current.store.path,
      trackedAgentCount: agents.length,
    };
  } catch (error) {
    const safe = publicError(error);
    return { ...base, ok: false, errorCode: safe.code };
  }
}

async function spawn(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  const task = params.task;
  if (!task) throw new CanaryError("TASK_REQUIRED");
  const current = await requireContext(context);
  const cwdInput = params.cwd ? text(params.cwd, MAX_PATH_BYTES, false) : context.cwd;
  const cwd = resolve(context.cwd, cwdInput);
  const label = params.label ? text(params.label, MAX_LABEL_BYTES, false) : "v2-agent";
  const agentId = `a-${randomUUID()}`;
  const runId = `r-${randomUUID()}`;
  const herdrAgentName = `v2-${randomUUID().replaceAll("-", "").slice(0, 27)}`;
  const createdAt = now();
  const environment = {
    PI_HERDR_DOMAIN_ID: current.store.domainId,
    PI_HERDR_PARENT_PANE_ID: current.parent.paneId,
    PI_HERDR_AGENT_ID: agentId,
    PI_HERDR_RUN_ID: runId,
    PI_HERDR_AGENT_GENERATION: "1",
    PI_HERDR_ASSIGNMENT_GENERATION: "1",
  };
  let paneId: string | undefined;
  let recordAdded = false;
  const agent: AgentRecord = {
    domainId: current.store.domainId,
    agentId,
    runId,
    herdrAgentName,
    agentGeneration: 1,
    assignmentGeneration: 1,
    workspaceId: current.parent.workspaceId,
    tabId: current.parent.tabId,
    paneId: "pending",
    cwd,
    label,
    processState: "starting",
    runPhase: "starting",
    herdrAttention: "unknown",
    createdAt,
    updatedAt: createdAt,
  };
  try {
    const split = await current.cli.paneSplit(current.parent.paneId, cwd, environment);
    paneId = idFrom(split, "pane_id");
    if (!paneId) throw new CanaryError("PANE_CREATE_FAILED");
    agent.paneId = paneId;
    await current.store.addAgent(agent);
    recordAdded = true;
    await current.cli.agentStart(herdrAgentName, paneId);
    const started = await identity(current.cli, agent);
    if (started.kind !== "present") throw new CanaryError("AGENT_START_FAILED");
    await current.store.updateAgent(agentId, {
      processState: "live",
      runPhase: "running",
      herdrAttention: started.attention,
    });
    await current.cli.agentPrompt(herdrAgentName, task);
    const prompted = await identity(current.cli, agent);
    if (prompted.kind !== "present") throw new CanaryError("AGENT_PROMPT_FAILED");
    const live = await current.store.updateAgent(agentId, {
      processState: "live",
      runPhase: "running",
      herdrAttention: prompted.attention,
    });
    return {
      ok: true,
      action: "spawn",
      domainId: current.store.domainId,
      agentId: live.agentId,
      runId: live.runId,
      agentName: live.herdrAgentName,
      agentGeneration: live.agentGeneration,
      assignmentGeneration: live.assignmentGeneration,
      workspaceId: live.workspaceId,
      tabId: live.tabId,
      paneId: live.paneId,
      cwd: live.cwd,
      processState: live.processState,
      delegatedRunPhase: live.runPhase,
      herdrAttention: live.herdrAttention,
    };
  } catch (error) {
    if (paneId) {
      try {
        const pane = await current.cli.paneGet(paneId);
        if (
          idFrom(pane, "pane_id") === paneId &&
          idFrom(pane, "workspace_id") === current.parent.workspaceId &&
          idFrom(pane, "tab_id") === current.parent.tabId
        )
          await current.cli.paneClose(paneId);
      } catch {
        // The cleanup target is intentionally only this request's exact pane.
      }
    }
    if (recordAdded) {
      await current.store
        .updateAgent(agentId, {
          processState: "failed",
          runPhase: "failed",
          herdrAttention: "unknown",
        })
        .catch(() => undefined);
    }
    throw publicError(error);
  }
}

async function list(context: PiContext): Promise<JsonObject> {
  const current = await requireContext(context);
  const rows: JsonObject[] = [];
  for (const agent of await current.store.list()) {
    const refreshed = await refresh(current.store, current.cli, agent);
    rows.push(recordView(refreshed.agent, refreshed.identityState));
  }
  return { ok: true, action: "list", domainId: current.store.domainId, agents: rows };
}

async function inspect(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  const current = await requireContext(context);
  if (!params.agentId && !params.runId) throw new CanaryError("AGENT_OR_RUN_ID_REQUIRED");
  const agent = await current.store.getAgent(params.agentId, params.runId);
  if (!agent) throw new CanaryError("AGENT_NOT_REGISTERED");
  const lines = params.lines === undefined ? MAX_LINES : params.lines;
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_LINES) throw new CanaryError("INVALID_LINE_COUNT");
  let refreshed = agent;
  let identityState: IdentityResult["kind"] = "absent";
  if (agent.processState !== "closed") {
    const result = await identity(current.cli, agent);
    identityState = result.kind;
    if (result.kind === "mismatch") throw new CanaryError("IDENTITY_MISMATCH");
    if (result.kind === "absent") {
      refreshed = await current.store.updateAgent(agent.agentId, {
        processState: "missing",
        runPhase: agent.runPhase === "failed" ? "failed" : "unknown",
        herdrAttention: "unknown",
      });
    } else {
      refreshed = await current.store.updateAgent(agent.agentId, {
        processState: "live",
        herdrAttention: result.attention,
      });
      const output = await current.cli.agentRead(agent.herdrAgentName, lines);
      const clean = output
        .replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
      const recentLines = clean.replace(/\r\n?/gu, "\n").split("\n").slice(-lines);
      const recentOutput = recentLines.join("\n").slice(-6000);
      return {
        ok: true,
        action: "inspect",
        domainId: current.store.domainId,
        ...recordView(refreshed, identityState),
        agentGeneration: refreshed.agentGeneration,
        recentOutput,
        recentOutputLineCount: recentOutput.length === 0 ? 0 : recentOutput.split("\n").length,
      };
    }
  }
  return {
    ok: true,
    action: "inspect",
    domainId: current.store.domainId,
    ...recordView(refreshed, identityState),
    agentGeneration: refreshed.agentGeneration,
    recentOutput: "",
    recentOutputLineCount: 0,
  };
}

async function send(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  const current = await requireContext(context);
  const agentId = requireAgentId(params);
  if (!params.message) throw new CanaryError("MESSAGE_REQUIRED");
  const agent = await current.store.getAgent(agentId);
  if (!agent) throw new CanaryError("AGENT_NOT_REGISTERED");
  if (agent.processState === "closed") throw new CanaryError("AGENT_CLOSED");
  const result = await identity(current.cli, agent);
  if (result.kind === "mismatch") throw new CanaryError("IDENTITY_MISMATCH");
  if (result.kind === "absent") throw new CanaryError("AGENT_MISSING");
  await current.cli.agentPrompt(agent.herdrAgentName, params.message);
  const afterPrompt = await identity(current.cli, agent);
  if (afterPrompt.kind === "mismatch") throw new CanaryError("IDENTITY_MISMATCH");
  const updated = await current.store.updateAgent(agent.agentId, {
    processState: afterPrompt.kind === "present" ? "live" : "missing",
    herdrAttention: afterPrompt.kind === "present" ? afterPrompt.attention : "unknown",
    runPhase: afterPrompt.kind === "present" ? (agent.runPhase === "starting" ? "running" : agent.runPhase) : "unknown",
  });
  return {
    ok: true,
    action: "send",
    domainId: current.store.domainId,
    agentId: updated.agentId,
    runId: updated.runId,
    agentName: updated.herdrAgentName,
    paneId: updated.paneId,
    assignmentGeneration: updated.assignmentGeneration,
    delegatedRunPhase: updated.runPhase,
    herdrAttention: updated.herdrAttention,
  };
}

async function close(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  const current = await requireContext(context);
  const agentId = requireAgentId(params);
  const agent = await current.store.getAgent(agentId);
  if (!agent) throw new CanaryError("AGENT_NOT_REGISTERED");
  if (agent.processState === "closed")
    return { ok: true, action: "close", domainId: current.store.domainId, agentId, paneId: agent.paneId, alreadyAbsent: true, processState: "closed", delegatedRunPhase: "closed" };
  const result = await identity(current.cli, agent);
  if (result.kind === "mismatch") throw new CanaryError("IDENTITY_MISMATCH");
  if (result.kind === "absent") {
    const updated = await current.store.updateAgent(agentId, {
      processState: "closed",
      runPhase: "closed",
      herdrAttention: "unknown",
    });
    return { ok: true, action: "close", domainId: current.store.domainId, agentId, paneId: updated.paneId, alreadyAbsent: true, processState: updated.processState, delegatedRunPhase: updated.runPhase };
  }
  try {
    await current.cli.paneClose(agent.paneId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const updated = await current.store.updateAgent(agentId, {
    processState: "closed",
    runPhase: "closed",
    herdrAttention: "unknown",
  });
  return { ok: true, action: "close", domainId: current.store.domainId, agentId, paneId: updated.paneId, alreadyAbsent: false, processState: updated.processState, delegatedRunPhase: updated.runPhase };
}

async function execute(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  switch (params.action) {
    case "health":
      return health(context);
    case "spawn":
      return spawn(context, params);
    case "list":
      return list(context);
    case "inspect":
      return inspect(context, params);
    case "send":
      return send(context, params);
    case "close":
      return close(context, params);
  }
}

export function registerOrchestrateV2(api: ExtensionAPI): void {
  const tool: ToolRegistration = {
    name: "orchestrate_v2",
    label: "Orchestrate v2 Canary",
    description:
      "M01 canary: directly control visible Herdr Pi agent panes with health, spawn, list, inspect, send, and close. This is independent of legacy orchestrate and has no task-completion inference: Herdr idle/done and Pi settlement never complete a delegated run.",
    promptSnippet: "Direct Herdr visible-agent canary control",
    parameters: ORCHESTRATE_V2_SCHEMA as unknown as ToolRegistration["parameters"],
    async execute(_toolCallId, rawParams, _signal, _onUpdate, context) {
      try {
        const result = await execute(context, parseParams(rawParams));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        throw publicError(error);
      }
    },
  };
  (api as unknown as CanaryApi).registerTool(tool);
}
