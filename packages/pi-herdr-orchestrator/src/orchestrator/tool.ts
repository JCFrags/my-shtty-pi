import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChannelStore, ChannelStoreError } from "./channel-store.js";
import { HerdrCli, HerdrCliError } from "./herdr-cli.js";
import { RegistryError, RegistryStore } from "./store.js";
import {
  PROTOCOL,
  PROTOCOL_VERSION,
  type AgentRecord,
  type JsonObject,
  type ManagedTabRecord,
  type OrchestrateParams,
  type ParentIdentity,
  type RunRecord,
  type RunResult,
} from "./types.js";

const execFile = promisify(execFileCallback);
const MAX_TASK_BYTES = 8192;
const MAX_MESSAGE_BYTES = 8192;
const MAX_LABEL_BYTES = 160;
const MAX_PATH_BYTES = 4096;
const MAX_LINES = 40;
const MAX_ACTIVE_CHILDREN = 6;
const MAX_LIST_AGENTS = 32;
const MAX_RECENT_RUNS = 8;
const MAX_RECONCILE_RUNS_PER_DRAIN = 32;
const MANAGED_TAB_LABEL = "subagents";
const CAPABILITIES = {
  visiblePaneCreation: true,
  managedSubagentTab: true,
  namedAgentStart: true,
  prompt: true,
  inspectRead: true,
  close: true,
  explicitResults: true,
  agentMessaging: true,
  waitCollect: true,
  reuse: true,
  cancel: true,
  recover: true,
} as const;

const stringProperty = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const ORCHESTRATE_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: { action: { const: "health" } },
    },
    ...["run", "spawn"].map((action) => ({
      type: "object",
      additionalProperties: false,
      required: ["action", "task"],
      properties: {
        action: { const: action },
        task: stringProperty(MAX_TASK_BYTES),
        label: stringProperty(MAX_LABEL_BYTES),
        cwd: stringProperty(MAX_PATH_BYTES),
      },
    })),
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: { action: { const: "list" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { const: "inspect" },
        agentId: stringProperty(128),
        runId: stringProperty(128),
        lines: { type: "integer", minimum: 1, maximum: MAX_LINES },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "agentId", "message"],
      properties: {
        action: { const: "send" },
        agentId: stringProperty(128),
        message: stringProperty(MAX_MESSAGE_BYTES),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "agentId"],
      properties: { action: { const: "close" }, agentId: stringProperty(128) },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "runIds"],
      properties: {
        action: { const: "wait" },
        runIds: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: stringProperty(128),
        },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120000 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "runId"],
      properties: { action: { const: "collect" }, runId: stringProperty(128) },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "agentId", "task"],
      properties: {
        action: { const: "reuse" },
        agentId: stringProperty(128),
        task: stringProperty(MAX_TASK_BYTES),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "runId"],
      properties: { action: { const: "cancel" }, runId: stringProperty(128) },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: { action: { const: "recover" } },
    },
  ],
} as const;

type PiContext = {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
};
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
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: JsonObject;
  }>;
};
type OrchestrationApi = {
  registerTool(tool: ToolRegistration): void;
  on(
    event: string,
    handler: (event: unknown, context: unknown) => void | Promise<void>,
  ): void;
};

class OrchestrationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OrchestrationError";
    this.code = code;
  }
}

interface OrchestrationContext {
  cli: HerdrCli;
  parent: ParentIdentity;
  store: RegistryStore;
}

type IdentityResult =
  | { kind: "present"; agent: JsonObject; pane: JsonObject; attention: string }
  | { kind: "absent" }
  | { kind: "mismatch" };

type ManagedTabState = "absent" | "live" | "missing" | "mismatch";
type ManagedTabResult = {
  record: ManagedTabRecord;
  rootPaneId?: string;
  created: boolean;
  active: AgentRecord[];
};

const domainLocks = new Map<string, Promise<void>>();

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(
  value: unknown,
  maxBytes: number,
  allowWhitespace = true,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  )
    throw new OrchestrationError("INVALID_REQUEST");
  const invalid = allowWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (invalid.test(value)) throw new OrchestrationError("INVALID_REQUEST");
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function idFrom(value: unknown, key: string): string | undefined {
  return stringValue(object(value)?.[key]);
}

function now(): string {
  return new Date().toISOString();
}

function attention(agent: JsonObject): string {
  const value = stringValue(agent.agent_status);
  return value && value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : "unknown";
}

function paneAgentName(pane: JsonObject): string | undefined {
  return (
    stringValue(pane.name) ??
    stringValue(pane.agent_name) ??
    stringValue(object(pane.agent_session)?.name)
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof HerdrCliError && error.notFound;
}

function publicError(error: unknown): OrchestrationError {
  if (error instanceof OrchestrationError) return error;
  if (error instanceof RegistryError || error instanceof ChannelStoreError)
    return new OrchestrationError(error.code);
  if (error instanceof HerdrCliError) return new OrchestrationError(error.code);
  return new OrchestrationError("ORCHESTRATION_OPERATION_FAILED");
}

async function withDomainLock<T>(
  domainId: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  const previous = domainLocks.get(domainId) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const queued = previous.then(() => gate);
  domainLocks.set(domainId, queued);
  const cleanup = () => {
    if (domainLocks.get(domainId) === queued) domainLocks.delete(domainId);
  };
  void queued.then(cleanup, cleanup);
  if (signal) {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Aborted"));
        signal.addEventListener("abort", abort, { once: true });
        void previous.finally(() => signal.removeEventListener("abort", abort));
      }),
    ]).catch((error) => {
      // Release only this waiter's gate. Keep the queued chain mapped until the
      // previous holder has settled, so a later caller cannot bypass it.
      release();
      throw error;
    });
  } else await previous;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    return await action();
  } finally {
    release();
  }
}

async function projectRoot(cwd: string): Promise<string> {
  try {
    const result = await execFile(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024,
      },
    );
    const root = result.stdout.trim();
    if (root && isAbsolute(root)) return resolve(root);
  } catch {
    // A non-repository cwd is still a valid Herdr working directory.
  }
  return resolve(cwd);
}

function parentFromPane(pane: JsonObject): ParentIdentity {
  const workspaceId =
    idFrom(pane, "workspace_id") ?? process.env.HERDR_WORKSPACE_ID;
  const tabId = idFrom(pane, "tab_id") ?? process.env.HERDR_TAB_ID;
  const paneId = idFrom(pane, "pane_id") ?? process.env.HERDR_PANE_ID;
  if (!workspaceId || !tabId || !paneId)
    throw new OrchestrationError("HERDR_CONTEXT_INCOMPLETE");
  for (const [name, actual, expected] of [
    ["workspace", workspaceId, process.env.HERDR_WORKSPACE_ID],
    ["tab", tabId, process.env.HERDR_TAB_ID],
    ["pane", paneId, process.env.HERDR_PANE_ID],
  ] as const)
    if (expected && actual !== expected)
      throw new OrchestrationError(`PARENT_${name.toUpperCase()}_MISMATCH`);
  return { workspaceId, tabId, paneId };
}

async function requireContext(context: PiContext): Promise<OrchestrationContext> {
  if (process.env.HERDR_ENV !== "1") throw new OrchestrationError("NOT_IN_HERDR");
  if (!process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID)
    throw new OrchestrationError("HERDR_CONTEXT_INCOMPLETE");
  const cli = new HerdrCli();
  const pane = await cli.paneCurrent();
  const parent = parentFromPane(pane);
  const root = await projectRoot(context.cwd);
  const store = new RegistryStore(root, parent);
  return { cli, parent, store };
}

async function identity(
  cli: HerdrCli,
  agent: AgentRecord,
): Promise<IdentityResult> {
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
  if (
    idFrom(herdrAgent, "pane_id") !== agent.paneId ||
    idFrom(herdrAgent, "workspace_id") !== agent.workspaceId ||
    idFrom(herdrAgent, "tab_id") !== agent.tabId ||
    stringValue(herdrAgent.name) !== agent.herdrAgentName
  )
    return { kind: "mismatch" };
  let pane: JsonObject;
  try {
    pane = await cli.paneGet(agent.paneId);
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    throw error;
  }
  if (
    idFrom(pane, "pane_id") !== agent.paneId ||
    idFrom(pane, "workspace_id") !== agent.workspaceId ||
    idFrom(pane, "tab_id") !== agent.tabId
  )
    return { kind: "mismatch" };
  const currentName = paneAgentName(pane);
  if (currentName && currentName !== agent.herdrAgentName)
    return { kind: "mismatch" };
  return {
    kind: "present",
    agent: herdrAgent,
    pane,
    attention: attention(herdrAgent),
  };
}

function recordView(
  agent: AgentRecord,
  identityState?: IdentityResult["kind"],
): JsonObject {
  return {
    agentId: agent.agentId,
    agentName: agent.herdrAgentName,
    runId: agent.runId,
    agentGeneration: agent.agentGeneration,
    assignmentGeneration: agent.assignmentGeneration,
    topology: agent.topology,
    workspaceId: agent.workspaceId,
    tabId: agent.tabId,
    paneId: agent.paneId,
    processState: agent.processState,
    herdrAttention: agent.herdrAttention,
    delegatedRunPhase: agent.runPhase,
    latestProgress: agent.latestProgress,
    explicitTerminal: agent.terminal,
    runCount: agent.runs.length,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    label: agent.label,
    ...(identityState ? { identityState } : {}),
  };
}

function listRecordView(
  agent: AgentRecord,
  identityState?: IdentityResult["kind"],
): JsonObject {
  return {
    agentId: agent.agentId,
    agentName: agent.herdrAgentName,
    runId: agent.runId,
    agentGeneration: agent.agentGeneration,
    assignmentGeneration: agent.assignmentGeneration,
    topology: agent.topology,
    workspaceId: agent.workspaceId,
    tabId: agent.tabId,
    paneId: agent.paneId,
    processState: agent.processState,
    herdrAttention: agent.herdrAttention,
    delegatedRunPhase: agent.runPhase,
    latestProgress: agent.latestProgress
      ? {
          eventSequence: agent.latestProgress.eventSequence,
          summary: agent.latestProgress.summary.slice(0, 256),
          createdAt: agent.latestProgress.createdAt,
        }
      : null,
    terminal: agent.terminal
      ? {
          status: agent.terminal.status,
          completedAt: agent.terminal.completedAt,
          resultAvailable: true,
        }
      : null,
    runCount: agent.runs.length,
    updatedAt: agent.updatedAt,
    label: agent.label,
    ...(identityState ? { identityState } : {}),
  };
}

function runFacts(run: RunRecord): JsonObject {
  return {
    runId: run.runId,
    assignmentGeneration: run.assignmentGeneration,
    phase: run.phase,
    assignmentState: run.assignmentState,
    latestProgress: run.latestProgress,
    terminal: run.terminal,
    deliveredSequence: run.deliveredSequence,
    terminalDelivered: run.terminalDelivered,
    notifiedSequence: run.notifiedSequence,
    terminalNotified: run.terminalNotified,
    cancelRequestedAt: run.cancelRequestedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function recentRunHistory(agent: AgentRecord): JsonObject[] {
  return agent.runs.slice(-MAX_RECENT_RUNS).reverse().map((run) => ({
    runId: run.runId,
    assignmentGeneration: run.assignmentGeneration,
    phase: run.phase,
    terminalStatus: run.terminal?.status ?? null,
    completedAt: run.terminal?.completedAt ?? null,
    resultAvailable: run.terminal !== null,
  }));
}

function newestAgents(agents: AgentRecord[]): AgentRecord[] {
  const priority = (agent: AgentRecord) =>
    agent.processState === "live" && !agent.terminal
      ? 0
      : !agent.terminal && agent.processState !== "closed" && agent.processState !== "failed"
        ? 1
        : 2;
  return [...agents]
    .sort(
      (left, right) =>
        priority(left) - priority(right) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.agentId.localeCompare(right.agentId),
    )
    .slice(0, MAX_LIST_AGENTS);
}

async function refresh(
  store: RegistryStore,
  cli: HerdrCli,
  agent: AgentRecord,
): Promise<{ agent: AgentRecord; identityState: IdentityResult["kind"] }> {
  if (agent.processState === "closed")
    return { agent, identityState: "absent" };
  const result = await identity(cli, agent);
  if (result.kind === "present") {
    const updated = await store.updateAgent(agent.agentId, {
      processState: "live",
      herdrAttention: result.attention,
    });
    return { agent: updated, identityState: "present" };
  }
  const updated = await store.updateAgent(agent.agentId, {
    processState: "missing",
    runPhase:
      agent.terminal ||
      agent.runPhase === "failed" ||
      agent.runPhase === "cancel_requested"
        ? agent.runPhase
        : "unknown",
    herdrAttention: "unknown",
  });
  return { agent: updated, identityState: result.kind };
}

async function verifyTab(
  current: OrchestrationContext,
  record: ManagedTabRecord,
): Promise<"live" | "missing" | "mismatch"> {
  let tab: JsonObject;
  try {
    tab = await current.cli.tabGet(record.tabId);
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
  return idFrom(tab, "tab_id") === record.tabId &&
    idFrom(tab, "workspace_id") === current.parent.workspaceId &&
    record.workspaceId === current.parent.workspaceId
    ? "live"
    : "mismatch";
}

async function activeManagedAgents(
  current: OrchestrationContext,
  tabId: string,
): Promise<AgentRecord[]> {
  const active: AgentRecord[] = [];
  for (const agent of await current.store.list()) {
    if (
      agent.topology !== "managed-subagents-tab-v2" ||
      agent.tabId !== tabId ||
      agent.processState === "closed" ||
      agent.processState === "failed"
    )
      continue;
    const result = await identity(current.cli, agent);
    if (result.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
    if (result.kind === "present") {
      active.push(
        await current.store.updateAgent(agent.agentId, {
          processState: "live",
          herdrAttention: result.attention,
        }),
      );
    } else {
      await current.store.updateAgent(agent.agentId, {
        processState: "missing",
        runPhase:
          agent.terminal || agent.runPhase === "cancel_requested"
            ? agent.runPhase
            : "unknown",
        herdrAttention: "unknown",
      });
    }
  }
  return active;
}

async function clearMissingTab(
  current: OrchestrationContext,
  record: ManagedTabRecord,
): Promise<void> {
  await current.store.markManagedTabAgentsMissing(record.tabId);
  await current.store.clearManagedTab(record.tabId);
}

async function cleanCreatedTab(
  current: OrchestrationContext,
  tabId: string,
  paneId?: string,
): Promise<void> {
  try {
    const tab = await current.cli.tabGet(tabId);
    if (
      idFrom(tab, "tab_id") !== tabId ||
      idFrom(tab, "workspace_id") !== current.parent.workspaceId
    )
      return;
    const panes = (
      await current.cli.paneList(current.parent.workspaceId)
    ).filter((pane) => idFrom(pane, "tab_id") === tabId);
    if (
      panes.length === 1 &&
      (!paneId || idFrom(panes[0], "pane_id") === paneId)
    ) {
      await current.cli.tabClose(tabId);
    } else if (paneId) {
      const exact = panes.find((pane) => idFrom(pane, "pane_id") === paneId);
      if (exact) await current.cli.paneClose(paneId);
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  } finally {
    await current.store.clearManagedTab(tabId).catch(() => false);
  }
}

async function createManagedTab(
  current: OrchestrationContext,
  cwd: string,
  environment: Record<string, string>,
): Promise<ManagedTabResult> {
  const created = await current.cli.tabCreate(
    current.parent.workspaceId,
    cwd,
    MANAGED_TAB_LABEL,
    { ...environment, PI_HERDR_PARENT_PANE_ID: current.parent.paneId },
  );
  const tabId = idFrom(created.tab, "tab_id");
  const paneId = idFrom(created.rootPane, "pane_id");
  if (!tabId) throw new OrchestrationError("MANAGED_TAB_CREATE_FAILED");
  if (!paneId) {
    await cleanCreatedTab(current, tabId).catch(() => undefined);
    throw new OrchestrationError("MANAGED_TAB_CREATE_FAILED");
  }
  const timestamp = now();
  const record: ManagedTabRecord = {
    workspaceId: current.parent.workspaceId,
    tabId,
    requestedLabel: MANAGED_TAB_LABEL,
    createdAt: timestamp,
    verifiedAt: timestamp,
  };
  try {
    await current.store.setManagedTab(record);
    if (
      idFrom(created.tab, "workspace_id") !== current.parent.workspaceId ||
      idFrom(created.rootPane, "workspace_id") !== current.parent.workspaceId ||
      idFrom(created.rootPane, "tab_id") !== tabId
    )
      throw new OrchestrationError("MANAGED_TAB_IDENTITY_MISMATCH");
    const [tab, pane] = await Promise.all([
      current.cli.tabGet(tabId),
      current.cli.paneGet(paneId),
    ]);
    if (
      idFrom(tab, "tab_id") !== tabId ||
      idFrom(tab, "workspace_id") !== current.parent.workspaceId ||
      idFrom(pane, "pane_id") !== paneId ||
      idFrom(pane, "workspace_id") !== current.parent.workspaceId ||
      idFrom(pane, "tab_id") !== tabId
    )
      throw new OrchestrationError("MANAGED_TAB_IDENTITY_MISMATCH");
    return { record, rootPaneId: paneId, created: true, active: [] };
  } catch (error) {
    await cleanCreatedTab(current, tabId, paneId).catch(() => undefined);
    throw error;
  }
}

async function ensureManagedSubagentTab(
  current: OrchestrationContext,
  cwd: string,
  environment: Record<string, string>,
): Promise<ManagedTabResult> {
  const existing = await current.store.managedTab();
  if (!existing) return createManagedTab(current, cwd, environment);
  const state = await verifyTab(current, existing);
  if (state === "mismatch")
    throw new OrchestrationError("MANAGED_TAB_IDENTITY_MISMATCH");
  if (state === "missing") {
    await clearMissingTab(current, existing);
    return createManagedTab(current, cwd, environment);
  }
  const verified = { ...existing, verifiedAt: now() };
  await current.store.setManagedTab(verified);
  const active = await activeManagedAgents(current, existing.tabId);
  if (active.length === 0) {
    await current.store.clearManagedTab(existing.tabId);
    return createManagedTab(current, cwd, environment);
  }
  return { record: verified, created: false, active };
}

function layoutChoice(
  layout: JsonObject,
  active: AgentRecord[],
): {
  paneId: string;
  direction: "right" | "down";
} {
  const owned = new Map(active.map((agent) => [agent.paneId, agent]));
  const panes = Array.isArray(layout.panes)
    ? layout.panes.map(object).filter(Boolean)
    : [];
  const geometry = panes.flatMap((pane) => {
    if (!pane) return [];
    const paneId = idFrom(pane, "pane_id");
    const rect = object(pane.rect);
    const width = numberValue(rect?.width);
    const height = numberValue(rect?.height);
    if (!paneId || !owned.has(paneId) || !width || !height) return [];
    return [{ paneId, width, height, area: width * height }];
  });
  if (geometry.length > 0) {
    geometry.sort(
      (a, b) => b.area - a.area || a.paneId.localeCompare(b.paneId),
    );
    const target = geometry[0];
    if (target)
      return {
        paneId: target.paneId,
        direction: target.width >= target.height * 3 ? "right" : "down",
      };
  }
  const paneIds = active.map((agent) => agent.paneId).sort();
  const index = active.length <= 2 ? 0 : (active.length - 2) % paneIds.length;
  const paneId = paneIds[index];
  if (!paneId) throw new OrchestrationError("MANAGED_TAB_HAS_NO_TARGET");
  return { paneId, direction: active.length === 1 ? "right" : "down" };
}

async function createChildPane(
  current: OrchestrationContext,
  managed: ManagedTabResult,
  cwd: string,
  environment: Record<string, string>,
): Promise<string> {
  if (managed.created) {
    if (!managed.rootPaneId)
      throw new OrchestrationError("MANAGED_TAB_HAS_NO_ROOT_PANE");
    return managed.rootPaneId;
  }
  if (managed.active.length >= MAX_ACTIVE_CHILDREN)
    throw new OrchestrationError("SUBAGENT_CAPACITY_REACHED");
  let layout: JsonObject = {};
  try {
    const first = managed.active[0];
    if (first) layout = await current.cli.paneLayout(first.paneId);
  } catch {
    // Deterministic fallback below is sufficient when geometry is unavailable.
  }
  const target = layoutChoice(layout, managed.active);
  const pane = await current.cli.paneSplit(
    target.paneId,
    target.direction,
    cwd,
    {
      ...environment,
      PI_HERDR_PARENT_PANE_ID: current.parent.paneId,
      PI_HERDR_SUBAGENT_TAB_ID: managed.record.tabId,
    },
  );
  const paneId = idFrom(pane, "pane_id");
  try {
    if (!paneId) throw new OrchestrationError("PANE_CREATE_FAILED");
    const exact = await current.cli.paneGet(paneId);
    if (
      idFrom(pane, "workspace_id") !== current.parent.workspaceId ||
      idFrom(pane, "tab_id") !== managed.record.tabId ||
      idFrom(exact, "pane_id") !== paneId ||
      idFrom(exact, "workspace_id") !== current.parent.workspaceId ||
      idFrom(exact, "tab_id") !== managed.record.tabId
    )
      throw new OrchestrationError("PANE_CREATE_FAILED");
    return paneId;
  } catch (error) {
    if (paneId) {
      try {
        const exact = await current.cli.paneGet(paneId);
        if (
          idFrom(exact, "pane_id") === paneId &&
          idFrom(exact, "workspace_id") === current.parent.workspaceId &&
          idFrom(exact, "tab_id") === managed.record.tabId
        )
          await current.cli.paneClose(paneId);
      } catch {
        // Do not guess when the returned pane identity is absent or incompatible.
      }
    }
    throw error;
  }
}

function parseParams(value: unknown): OrchestrateParams {
  const params = object(value);
  const action = stringValue(params?.action) as
    OrchestrateParams["action"] | undefined;
  if (
    !action ||
    ![
      "health",
      "run",
      "spawn",
      "list",
      "inspect",
      "send",
      "close",
      "wait",
      "collect",
      "reuse",
      "cancel",
      "recover",
    ].includes(action)
  )
    throw new OrchestrationError("INVALID_REQUEST");
  return {
    action,
    ...(params?.task !== undefined
      ? { task: text(params.task, MAX_TASK_BYTES) }
      : {}),
    ...(params?.label !== undefined
      ? { label: text(params.label, MAX_LABEL_BYTES, false) }
      : {}),
    ...(params?.cwd !== undefined
      ? { cwd: text(params.cwd, MAX_PATH_BYTES, false) }
      : {}),
    ...(params?.agentId !== undefined
      ? { agentId: text(params.agentId, 128, false) }
      : {}),
    ...(params?.runId !== undefined
      ? { runId: text(params.runId, 128, false) }
      : {}),
    ...(params?.message !== undefined
      ? { message: text(params.message, MAX_MESSAGE_BYTES) }
      : {}),
    ...(params?.lines !== undefined ? { lines: params.lines as number } : {}),
    ...(params?.runIds !== undefined
      ? { runIds: params.runIds as string[] }
      : {}),
    ...(params?.timeoutMs !== undefined
      ? { timeoutMs: params.timeoutMs as number }
      : {}),
  };
}

function requireAgentId(params: OrchestrateParams): string {
  if (!params.agentId) throw new OrchestrationError("AGENT_ID_REQUIRED");
  return params.agentId;
}

async function managedHealth(current: OrchestrationContext): Promise<{
  tabId: string | null;
  state: ManagedTabState;
  activePaneCount: number;
}> {
  const record = await current.store.managedTab();
  if (!record) return { tabId: null, state: "absent", activePaneCount: 0 };
  const state = await verifyTab(current, record);
  if (state === "missing") {
    await clearMissingTab(current, record);
    return { tabId: record.tabId, state, activePaneCount: 0 };
  }
  if (state === "mismatch")
    return { tabId: record.tabId, state, activePaneCount: 0 };
  await current.store.setManagedTab({ ...record, verifiedAt: now() });
  try {
    const active = await activeManagedAgents(current, record.tabId);
    if (active.length === 0) {
      await current.store.clearManagedTab(record.tabId);
      return { tabId: null, state: "absent", activePaneCount: 0 };
    }
    return {
      tabId: record.tabId,
      state: "live",
      activePaneCount: active.length,
    };
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === "IDENTITY_MISMATCH")
      return { tabId: record.tabId, state: "mismatch", activePaneCount: 0 };
    throw error;
  }
}

async function health(context: PiContext): Promise<JsonObject> {
  const cli = new HerdrCli();
  const [herdrVersion, piVersion] = await Promise.all([
    cli.version().catch(() => undefined),
    cli.piVersion(),
  ]);
  const inside = process.env.HERDR_ENV === "1";
  let running = false;
  if (inside)
    running = await cli
      .status()
      .then(() => true)
      .catch(() => false);
  const base: JsonObject = {
    ok: true,
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    registryVersion: 5,
    domainId: null,
    parent: null,
    piVersion: piVersion ?? null,
    herdrVersion: herdrVersion ?? null,
    capabilities:
      running &&
      inside &&
      process.env.HERDR_SOCKET_PATH &&
      process.env.HERDR_PANE_ID
        ? CAPABILITIES
        : Object.fromEntries(
            Object.keys(CAPABILITIES).map((key) => [key, false]),
          ),
    registryPath: null,
    trackedAgentCount: 0,
    managedTabId: null,
    managedTabState: "absent",
    managedActivePaneCount: 0,
    capacityLimit: MAX_ACTIVE_CHILDREN,
  };
  if (!inside) return { ...base, ok: false, errorCode: "NOT_IN_HERDR" };
  if (!running) return { ...base, ok: false, errorCode: "HERDR_UNAVAILABLE" };
  try {
    const scope = await requireContext(context);
    return await withDomainLock(scope.store.domainId, async () => {
      const current = await requireContext(context);
      const managed = await managedHealth(current);
      const agents = await current.store.list();
      return {
        ...base,
        domainId: current.store.domainId,
        parent: current.parent,
        registryPath: current.store.path,
        trackedAgentCount: agents.length,
        managedTabId: managed.tabId,
        managedTabState: managed.state,
        managedActivePaneCount: managed.activePaneCount,
      };
    });
  } catch (error) {
    const safe = publicError(error);
    return { ...base, ok: false, errorCode: safe.code };
  }
}

function assignmentPrompt(
  runId: string,
  assignmentGeneration: number,
  task: string,
): string {
  return `[orchestrate assignment]\nrunId: ${runId}\nassignmentGeneration: ${assignmentGeneration}\nThe run and assignment generation above are authoritative state metadata. Every subagent_channel call must include these exact values; calls from older assignments are rejected. Report meaningful progress while working. When finished, explicitly call subagent_channel action complete with a useful finalResult. If the parent requests cancellation, stop dependent work and call action acknowledge_cancel with a concise summary.\n\n<task>\n${task}\n</task>`;
}

async function spawnUnlocked(
  context: PiContext,
  params: OrchestrateParams,
  extensionPath?: string,
): Promise<JsonObject> {
  const task = params.task;
  if (!task) throw new OrchestrationError("TASK_REQUIRED");
  const current = await requireContext(context);
  const cwdInput = params.cwd
    ? text(params.cwd, MAX_PATH_BYTES, false)
    : context.cwd;
  const cwd = resolve(context.cwd, cwdInput);
  const label = params.label
    ? text(params.label, MAX_LABEL_BYTES, false)
    : "subagent";
  const agentId = `a-${randomUUID()}`;
  const runId = `r-${randomUUID()}`;
  const herdrAgentName = `agent-${randomUUID().replaceAll("-", "").slice(0, 26)}`;
  const createdAt = now();
  const environment = {
    PI_HERDR_DOMAIN_ID: current.store.domainId,
    PI_HERDR_ROOT_PARENT_PANE_ID: current.parent.paneId,
    PI_HERDR_AGENT_ID: agentId,
    PI_HERDR_RUN_ID: runId,
    PI_HERDR_AGENT_GENERATION: "1",
    PI_HERDR_ASSIGNMENT_GENERATION: "1",
  };
  const managed = await ensureManagedSubagentTab(current, cwd, environment);
  let paneId: string | undefined;
  let recordAdded = false;
  let childStarted = false;
  const initialRun: RunRecord = {
    runId,
    assignmentGeneration: 1,
    phase: "starting",
    latestProgress: null,
    terminal: null,
    deliveredSequence: 0,
    terminalDelivered: false,
    notifiedSequence: 0,
    terminalNotified: false,
    cancelRequestedAt: null,
    assignmentState: "pending-prompt",
    pendingTask: task,
    legacyDeliveredEventIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  const agent: AgentRecord = {
    domainId: current.store.domainId,
    agentId,
    runId,
    herdrAgentName,
    agentGeneration: 1,
    assignmentGeneration: 1,
    topology: "managed-subagents-tab-v2",
    workspaceId: current.parent.workspaceId,
    tabId: managed.record.tabId,
    paneId: "pending",
    cwd,
    label,
    processState: "starting",
    runPhase: "starting",
    herdrAttention: "unknown",
    latestProgress: null,
    terminal: null,
    runs: [initialRun],
    createdAt,
    updatedAt: createdAt,
  };
  try {
    paneId = await createChildPane(current, managed, cwd, environment);
    if (paneId === current.parent.paneId)
      throw new OrchestrationError("PARENT_PANE_TARGET_REFUSED");
    agent.paneId = paneId;
    await current.store.addAgent(agent);
    recordAdded = true;
    await current.cli.agentStart(herdrAgentName, paneId, extensionPath);
    const started = await identity(current.cli, agent);
    if (started.kind !== "present") throw new OrchestrationError("AGENT_START_FAILED");
    childStarted = true;
    await current.store.updateAgent(agentId, {
      processState: "live",
      runPhase: "running",
      herdrAttention: started.attention,
    });
    await current.cli.agentPrompt(
      herdrAgentName,
      assignmentPrompt(runId, 1, task),
    );
    await current.store.updateRun(agentId, runId, {
      assignmentState: "delivered",
      pendingTask: null,
    });
    const prompted = await identity(current.cli, agent);
    if (prompted.kind !== "present")
      throw new OrchestrationError("AGENT_PROMPT_FAILED");
    const live = await current.store.updateAgent(agentId, {
      processState: "live",
      runPhase: "running",
      herdrAttention: prompted.attention,
    });
    return {
      ok: true,
      action: params.action,
      domainId: current.store.domainId,
      ...recordView(live),
      managedTabId: live.tabId,
      tabCreatedByRequest: managed.created,
      cwd: live.cwd,
    };
  } catch (error) {
    // Preserve an exact started child and its durable pending assignment. A
    // failed prompt call is delivery uncertainty, not proof of non-delivery.
    if (childStarted) throw publicError(error);
    if (paneId) {
      if (managed.created) {
        await cleanCreatedTab(current, managed.record.tabId, paneId).catch(
          () => undefined,
        );
      } else {
        try {
          const pane = await current.cli.paneGet(paneId);
          if (
            idFrom(pane, "pane_id") === paneId &&
            idFrom(pane, "workspace_id") === current.parent.workspaceId &&
            idFrom(pane, "tab_id") === managed.record.tabId
          )
            await current.cli.paneClose(paneId);
        } catch {
          // Cleanup is intentionally limited to this request's exact pane.
        }
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

async function spawn(
  context: PiContext,
  params: OrchestrateParams,
  extensionPath?: string,
): Promise<JsonObject> {
  return spawnUnlocked(context, params, extensionPath);
}

function resultValid(
  result: RunResult,
  agent: AgentRecord,
  run: RunRecord,
): boolean {
  return (
    (Number(result.version) === 1 || result.version === 2) &&
    result.domainId === agent.domainId &&
    result.agentId === agent.agentId &&
    result.runId === run.runId &&
    result.agentGeneration === agent.agentGeneration &&
    result.assignmentGeneration === run.assignmentGeneration &&
    (result.status === "completed" ||
      result.status === "cancelled" ||
      result.status === "failed") &&
    typeof result.summary === "string" &&
    typeof result.completedAt === "string"
  );
}

function terminalPhase(status: RunResult["status"]): RunRecord["phase"] {
  return status === "completed"
    ? "completed"
    : status === "cancelled"
      ? "cancelled"
      : "failed";
}

async function reconcile(
  current: OrchestrationContext,
  runIds?: Set<string>,
  options: { migrateLegacy?: boolean } = {},
): Promise<void> {
  const channel = new ChannelStore(current.store.domainId);
  const originals = runIds
    ? (await Promise.all([...runIds].map((runId) => current.store.getRun(runId))))
        .filter((entry): entry is { agent: AgentRecord; run: RunRecord } => !!entry)
        .map((entry) => ({ ...entry.agent, runs: [entry.run] }))
    : await current.store.list();
  for (const original of originals) {
    for (const originalRun of original.runs) {
      let run = originalRun;
      if (run.legacyDeliveredEventIds.length) {
        await channel.discardLegacy(run.legacyDeliveredEventIds);
        await current.store.updateRun(original.agentId, run.runId, {
          legacyDeliveredEventIds: [],
        });
        run = (await current.store.getRun(run.runId))!.run;
      }
      const events = await channel.events(
        [run.runId],
        new Map([[run.runId, run.deliveredSequence]]),
        options,
      );
      const progress = events
        .filter(
          (event) =>
            event.version === 2 &&
            event.domainId === original.domainId &&
            event.agentId === original.agentId &&
            event.runId === run.runId &&
            event.agentGeneration === original.agentGeneration &&
            event.assignmentGeneration === run.assignmentGeneration &&
            event.kind === "progress" &&
            Number.isSafeInteger(event.sequence),
        )
        .sort((a, b) => a.sequence - b.sequence)
        .at(-1);
      if (progress && progress.sequence !== run.latestProgress?.eventSequence) {
        await current.store.updateRun(original.agentId, run.runId, {
          latestProgress: {
            eventSequence: progress.sequence,
            summary: progress.summary.slice(0, 2048),
            createdAt: progress.createdAt,
          },
        });
        run = (await current.store.getRun(run.runId))!.run;
      }
      const result = await channel.result(run.runId);
      if (!result) continue;
      if (!resultValid(result, original, run))
        throw new OrchestrationError("RESULT_IDENTITY_MISMATCH");
      if (!run.terminal)
        await current.store.updateRun(original.agentId, run.runId, {
          terminal: {
            status: result.status,
            summary: result.summary.slice(0, 4096),
            completedAt: result.completedAt,
            resultFile: `results/${run.runId}.json`,
          },
          phase: terminalPhase(result.status),
        });
      else if (
        run.terminal.status !== result.status ||
        run.terminal.summary !== result.summary ||
        run.terminal.completedAt !== result.completedAt
      )
        throw new OrchestrationError("COMPLETION_CONFLICT");
    }
  }
}

const MAX_NOTIFICATIONS_PER_DRAIN = 24;

function notify(
  context: PiContext,
  status: string,
  summary: string,
  agentId: string,
  runId: string,
): void {
  if (!context.hasUI || !context.ui?.notify) return;
  const body = JSON.stringify({ status, summary, agentId, runId });
  const level =
    status === "failed" ? "error" : status === "cancelled" ? "warning" : "info";
  context.ui.notify(body, level);
}

async function drainNotificationsUnlocked(
  current: OrchestrationContext,
  context: PiContext,
): Promise<void> {
  if (!context.hasUI || !context.ui?.notify) return;
  const selectedAgents = newestAgents(await current.store.list());
  const candidates = selectedAgents
    .flatMap((agent) => {
      // startAssignment appends the authoritative current run; inspect only a
      // fixed tail window so the periodic path never traverses full history.
      const currentRun = agent.runs.at(-1)!;
      const fixedWindow = [currentRun, ...agent.runs.slice(-2)].filter(
        (run, index, runs) =>
          runs.findIndex((candidate) => candidate.runId === run.runId) === index,
      );
      return fixedWindow.map((run) => ({
        agent,
        run,
        current: run.runId === agent.runId,
      }));
    })
    .filter(
      ({ run, current }) =>
        (current && !run.terminal) ||
        run.notifiedSequence < (run.latestProgress?.eventSequence ?? 0) ||
        (!!run.terminal && !run.terminalNotified),
    )
    .sort(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        left.run.runId.localeCompare(right.run.runId),
    )
    .slice(0, MAX_RECONCILE_RUNS_PER_DRAIN);
  const channel = new ChannelStore(current.store.domainId);
  let remaining = MAX_NOTIFICATIONS_PER_DRAIN;

  for (const { run: snapshot } of candidates) {
    if (remaining <= 0) return;
    try {
      await reconcile(current, new Set([snapshot.runId]), {
        migrateLegacy: false,
      });
      let entry = await current.store.getRun(snapshot.runId);
      if (!entry) continue;
      const fresh = (await channel.events(
        [snapshot.runId],
        new Map([[snapshot.runId, entry.run.deliveredSequence]]),
        { migrateLegacy: false },
      ))
        .filter(
          (event) =>
            event.version === 2 &&
            event.domainId === entry!.agent.domainId &&
            event.agentId === entry!.agent.agentId &&
            event.runId === entry!.run.runId &&
            event.agentGeneration === entry!.agent.agentGeneration &&
            event.assignmentGeneration === entry!.run.assignmentGeneration &&
            event.sequence > entry!.run.notifiedSequence,
        )
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, remaining);

      for (const event of fresh) {
        notify(
          context,
          event.kind,
          event.summary.slice(0, 2048),
          event.agentId,
          event.runId,
        );
        await current.store.updateRun(entry.agent.agentId, entry.run.runId, {
          notifiedSequence: event.sequence,
        });
        remaining -= 1;
      }

      entry = await current.store.getRun(snapshot.runId);
      if (!entry || remaining <= 0) return;
      if (entry.run.terminal && !entry.run.terminalNotified) {
        notify(
          context,
          entry.run.terminal.status,
          entry.run.terminal.summary.slice(0, 2048),
          entry.agent.agentId,
          entry.run.runId,
        );
        await current.store.updateRun(entry.agent.agentId, entry.run.runId, {
          terminalNotified: true,
        });
        remaining -= 1;
      }
    } catch {
      // One malformed or concurrently removed run must not block other notices.
    }
  }
}

async function waitRuns(
  context: PiContext,
  params: OrchestrateParams,
  signal?: AbortSignal,
): Promise<JsonObject> {
  if (
    !Array.isArray(params.runIds) ||
    params.runIds.length < 1 ||
    params.runIds.length > 8 ||
    params.runIds.some(
      (id) => typeof id !== "string" || !/^r-[0-9a-f-]{36}$/u.test(id),
    )
  )
    throw new OrchestrationError("INVALID_RUN_IDS");
  const timeoutMs = params.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000)
    throw new OrchestrationError("INVALID_TIMEOUT");
  const current = await requireContext(context),
    wanted = new Set(params.runIds),
    channel = new ChannelStore(current.store.domainId);
  for (const runId of wanted)
    if (!(await current.store.getRun(runId)))
      throw new OrchestrationError("RUN_NOT_REGISTERED");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await reconcile(current, wanted);
    await drainNotificationsUnlocked(current, context);
    const entries = (
      await Promise.all([...wanted].map((id) => current.store.getRun(id)))
    ).filter((x): x is { agent: AgentRecord; run: RunRecord } => !!x);
    const all = await channel.events(
      [...wanted],
      new Map(entries.map((entry) => [entry.run.runId, entry.run.deliveredSequence])),
    );
    const fresh = all
      .filter((e) => {
        const entry = entries.find((x) => x.run.runId === e.runId);
        return (
          !!entry &&
          e.version === 2 &&
          e.domainId === entry.agent.domainId &&
          e.agentId === entry.agent.agentId &&
          e.agentGeneration === entry.agent.agentGeneration &&
          e.assignmentGeneration === entry.run.assignmentGeneration &&
          e.sequence > entry.run.deliveredSequence
        );
      })
      .sort((a, b) => a.runId.localeCompare(b.runId) || a.sequence - b.sequence)
      .slice(0, 24);
    const results = entries
      .filter((x) => x.run.terminal && !x.run.terminalDelivered)
      .map((x) => ({
        runId: x.run.runId,
        agentId: x.agent.agentId,
        status: x.run.terminal!.status,
        summary: x.run.terminal!.summary,
        completedAt: x.run.terminal!.completedAt,
        resultAvailable: true,
      }));
    if (fresh.length || results.length || Date.now() >= deadline) {
      for (const entry of entries) {
        const delivered = fresh.filter((e) => e.runId === entry.run.runId);
        const through = delivered.length
          ? Math.max(...delivered.map((e) => e.sequence))
          : entry.run.deliveredSequence;
        const terminalDelivered =
          entry.run.terminalDelivered ||
          results.some((r) => r.runId === entry.run.runId);
        if (
          delivered.length ||
          terminalDelivered !== entry.run.terminalDelivered
        ) {
          await current.store.updateRun(entry.agent.agentId, entry.run.runId, {
            deliveredSequence: through,
            terminalDelivered,
          });
          if (delivered.length) {
            await channel.acknowledge(entry.run.runId, through);
            await channel.discardLegacy(
              delivered.flatMap((e) =>
                e.legacyEventId ? [e.legacyEventId] : [],
              ),
            );
          }
        }
      }
      return {
        ok: true,
        action: "wait",
        events: fresh.map((e) => ({
          eventSequence: e.sequence,
          kind: e.kind,
          runId: e.runId,
          agentId: e.agentId,
          target: e.target,
          summary: e.summary.slice(0, 2048),
          createdAt: e.createdAt,
        })),
        results,
        timedOut: !fresh.length && !results.length,
      };
    }
    await channel.waitForChange(
      [...wanted],
      Math.max(0, deadline - Date.now()),
      signal,
    );
  }
}

async function collect(
  context: PiContext,
  params: OrchestrateParams,
): Promise<JsonObject> {
  if (!params.runId) throw new OrchestrationError("RUN_ID_REQUIRED");
  const current = await requireContext(context),
    entry = await current.store.getRun(params.runId);
  if (!entry) throw new OrchestrationError("RUN_NOT_REGISTERED");
  await reconcile(current, new Set([params.runId]));
  const result = await new ChannelStore(current.store.domainId).result(
    params.runId,
  );
  if (!result || !resultValid(result, entry.agent, entry.run))
    throw new OrchestrationError(
      result ? "RESULT_IDENTITY_MISMATCH" : "RESULT_NOT_READY",
    );
  return {
    ok: true,
    action: "collect",
    runId: result.runId,
    agentId: result.agentId,
    assignmentGeneration: result.assignmentGeneration,
    status: result.status,
    summary: result.summary,
    finalResult: result.finalResult,
    completedAt: result.completedAt,
  };
}

async function list(context: PiContext): Promise<JsonObject> {
  const current = await requireContext(context);
  const tracked = await current.store.list();
  const selected = newestAgents(tracked);
  await reconcile(current, new Set(selected.map((agent) => agent.runId)));
  const rows: JsonObject[] = [];
  for (const agent of selected) {
    const refreshed = await refresh(current.store, current.cli, agent);
    rows.push(listRecordView(refreshed.agent, refreshed.identityState));
  }
  return {
    ok: true,
    action: "list",
    domainId: current.store.domainId,
    agents: rows,
    returnedAgentCount: rows.length,
    trackedAgentCount: tracked.length,
    truncated: tracked.length > rows.length,
  };
}

async function inspect(
  context: PiContext,
  params: OrchestrateParams,
): Promise<JsonObject> {
  const current = await requireContext(context);
  if (!params.agentId && !params.runId)
    throw new OrchestrationError("AGENT_OR_RUN_ID_REQUIRED");
  let agent = await current.store.getAgent(params.agentId, params.runId);
  if (!agent) throw new OrchestrationError("AGENT_NOT_REGISTERED");
  if (params.agentId && agent.agentId !== params.agentId)
    throw new OrchestrationError("AGENT_RUN_OWNERSHIP_MISMATCH");
  if (params.runId && !agent.runs.some((run) => run.runId === params.runId))
    throw new OrchestrationError("AGENT_RUN_OWNERSHIP_MISMATCH");
  const selectedRunId = params.runId ?? agent.runId;
  await reconcile(current, new Set([selectedRunId]));
  agent = (await current.store.getAgent(agent.agentId)) ?? agent;
  const selectedRun = agent.runs.find((run) => run.runId === selectedRunId)!;
  const lines = params.lines === undefined ? MAX_LINES : params.lines;
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_LINES)
    throw new OrchestrationError("INVALID_LINE_COUNT");
  let refreshed = agent;
  let identityState: IdentityResult["kind"] = "absent";
  if (agent.processState !== "closed") {
    const result = await identity(current.cli, agent);
    identityState = result.kind;
    if (result.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
    if (result.kind === "absent") {
      refreshed = await current.store.updateAgent(agent.agentId, {
        processState: "missing",
        runPhase:
          agent.terminal ||
          agent.runPhase === "failed" ||
          agent.runPhase === "cancel_requested"
            ? agent.runPhase
            : "unknown",
        herdrAttention: "unknown",
      });
    } else {
      refreshed = await current.store.updateAgent(agent.agentId, {
        processState: "live",
        herdrAttention: result.attention,
      });
      const output = await current.cli.agentRead(agent.herdrAgentName, lines);
      const clean = output
        .replace(
          /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu,
          "",
        )
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
      const recentLines = clean
        .replace(/\r\n?/gu, "\n")
        .split("\n")
        .slice(-lines);
      const recentOutput = recentLines.join("\n").slice(-6000);
      return {
        ok: true,
        action: "inspect",
        domainId: current.store.domainId,
        ...recordView(refreshed, identityState),
        requestedRunId: selectedRunId,
        selectedRun: runFacts(
          refreshed.runs.find((run) => run.runId === selectedRunId) ?? selectedRun,
        ),
        recentRuns: recentRunHistory(refreshed),
        recentRunLimit: MAX_RECENT_RUNS,
        historyTruncated: refreshed.runs.length > MAX_RECENT_RUNS,
        recentOutput,
        recentOutputLineCount:
          recentOutput.length === 0 ? 0 : recentOutput.split("\n").length,
      };
    }
  }
  return {
    ok: true,
    action: "inspect",
    domainId: current.store.domainId,
    ...recordView(refreshed, identityState),
    requestedRunId: selectedRunId,
    selectedRun: runFacts(
      refreshed.runs.find((run) => run.runId === selectedRunId) ?? selectedRun,
    ),
    recentRuns: recentRunHistory(refreshed),
    recentRunLimit: MAX_RECENT_RUNS,
    historyTruncated: refreshed.runs.length > MAX_RECENT_RUNS,
    recentOutput: "",
    recentOutputLineCount: 0,
  };
}

async function send(
  context: PiContext,
  params: OrchestrateParams,
): Promise<JsonObject> {
  const current = await requireContext(context);
  const agentId = requireAgentId(params);
  if (!params.message) throw new OrchestrationError("MESSAGE_REQUIRED");
  const agent = await current.store.getAgent(agentId);
  if (!agent) throw new OrchestrationError("AGENT_NOT_REGISTERED");
  if (agent.processState === "closed") throw new OrchestrationError("AGENT_CLOSED");
  const result = await identity(current.cli, agent);
  if (result.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  if (result.kind === "absent") throw new OrchestrationError("AGENT_MISSING");
  await current.cli.agentPrompt(agent.herdrAgentName, params.message);
  const afterPrompt = await identity(current.cli, agent);
  if (afterPrompt.kind === "mismatch")
    throw new OrchestrationError("IDENTITY_MISMATCH");
  const updated = await current.store.updateAgent(agent.agentId, {
    processState: afterPrompt.kind === "present" ? "live" : "missing",
    herdrAttention:
      afterPrompt.kind === "present" ? afterPrompt.attention : "unknown",
    runPhase:
      afterPrompt.kind === "present"
        ? agent.runPhase === "starting"
          ? "running"
          : agent.runPhase
        : agent.terminal
          ? agent.runPhase
          : "unknown",
  });
  return {
    ok: true,
    action: "send",
    domainId: current.store.domainId,
    ...recordView(updated),
  };
}

async function settleCancelled(
  current: OrchestrationContext,
  agent: AgentRecord,
  run: RunRecord,
  summary: string,
): Promise<RunResult> {
  const settled = await new ChannelStore(current.store.domainId).cancel({
    version: 2,
    domainId: agent.domainId,
    agentId: agent.agentId,
    runId: run.runId,
    agentGeneration: agent.agentGeneration,
    assignmentGeneration: run.assignmentGeneration,
    status: "cancelled",
    summary,
    finalResult: null,
  });
  if (!resultValid(settled.result, agent, run))
    throw new OrchestrationError("RESULT_IDENTITY_MISMATCH");
  await reconcile(current, new Set([run.runId]));
  return settled.result;
}

async function dispatchCancellation(
  current: OrchestrationContext,
  _agent: AgentRecord,
  run: RunRecord,
): Promise<"dispatched" | "absent" | "terminal"> {
  // Reconcile immutable completion and revalidate exact identity immediately
  // before every name-targeted operation. Never act on a stale name binding.
  await reconcile(current, new Set([run.runId]));
  let latest = await current.store.getRun(run.runId);
  if (!latest || latest.run.terminal) return "terminal";
  let exact = await identity(current.cli, latest.agent);
  if (exact.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  if (exact.kind === "absent") return "absent";
  await current.cli.agentInterrupt(latest.agent.herdrAgentName);

  await reconcile(current, new Set([run.runId]));
  latest = await current.store.getRun(run.runId);
  if (!latest || latest.run.terminal) return "terminal";
  exact = await identity(current.cli, latest.agent);
  if (exact.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  if (exact.kind === "absent") return "absent";
  await current.cli.agentPrompt(
    latest.agent.herdrAgentName,
    `[orchestrate cancellation request]\nrunId: ${latest.run.runId}\nassignmentGeneration: ${latest.run.assignmentGeneration}\nState metadata is authoritative. Stop dependent work and call subagent_channel action acknowledge_cancel with these exact identifiers and a concise summary. If you already completed, report completion instead.`,
  );
  return "dispatched";
}

function cancellationResponse(
  current: OrchestrationContext,
  agent: AgentRecord,
  run: RunRecord,
): JsonObject {
  const status = run.terminal?.status ?? "cancel_requested";
  return {
    ok: true,
    action: "cancel",
    domainId: current.store.domainId,
    runId: run.runId,
    agentId: agent.agentId,
    assignmentGeneration: run.assignmentGeneration,
    status,
    cancelled: status === "cancelled",
    raceLost: run.terminal !== null && status !== "cancelled",
    confirmed: run.terminal !== null,
  };
}

async function cancel(
  context: PiContext,
  params: OrchestrateParams,
): Promise<JsonObject> {
  if (!params.runId) throw new OrchestrationError("RUN_ID_REQUIRED");
  const current = await requireContext(context);
  await reconcile(current, new Set([params.runId]));
  const initial = await current.store.getRun(params.runId);
  if (!initial) throw new OrchestrationError("RUN_NOT_REGISTERED");
  if (initial.agent.runId !== initial.run.runId)
    throw new OrchestrationError("RUN_NOT_CURRENT");
  if (initial.run.terminal)
    return cancellationResponse(current, initial.agent, initial.run);

  const exact = await identity(current.cli, initial.agent);
  if (exact.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  const newlyRequested = initial.run.phase !== "cancel_requested";
  if (newlyRequested) {
    await current.store.updateRun(initial.agent.agentId, initial.run.runId, {
      phase: "cancel_requested",
      cancelRequestedAt: now(),
    });
  }
  let entry = (await current.store.getRun(initial.run.runId))!;

  if (exact.kind === "absent") {
    await current.store.updateAgent(entry.agent.agentId, {
      processState: "missing",
      herdrAttention: "unknown",
    });
    await settleCancelled(
      current,
      entry.agent,
      entry.run,
      "Cancellation confirmed after exact child termination.",
    );
    entry = (await current.store.getRun(entry.run.runId))!;
    return cancellationResponse(current, entry.agent, entry.run);
  }

  await reconcile(current, new Set([entry.run.runId]));
  entry = (await current.store.getRun(entry.run.runId))!;
  if (entry.run.terminal)
    return cancellationResponse(current, entry.agent, entry.run);
  const dispatch = await dispatchCancellation(current, entry.agent, entry.run);
  entry = (await current.store.getRun(entry.run.runId))!;
  if (dispatch === "terminal")
    return cancellationResponse(current, entry.agent, entry.run);
  if (dispatch === "absent") {
    await settleCancelled(
      current,
      entry.agent,
      entry.run,
      "Cancellation confirmed after exact child termination.",
    );
    entry = (await current.store.getRun(entry.run.runId))!;
    return cancellationResponse(current, entry.agent, entry.run);
  }

  await new ChannelStore(current.store.domainId).waitForChange(
    [entry.run.runId],
    1_000,
  );
  await reconcile(current, new Set([entry.run.runId]));
  entry = (await current.store.getRun(entry.run.runId))!;
  if (entry.run.terminal)
    return cancellationResponse(current, entry.agent, entry.run);

  const after = await identity(current.cli, entry.agent);
  if (after.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  if (after.kind === "absent") {
    await current.store.updateAgent(entry.agent.agentId, {
      processState: "missing",
      herdrAttention: "unknown",
    });
    await settleCancelled(
      current,
      entry.agent,
      entry.run,
      "Cancellation confirmed after exact child termination.",
    );
    entry = (await current.store.getRun(entry.run.runId))!;
  }
  return cancellationResponse(current, entry.agent, entry.run);
}

async function reuse(
  context: PiContext,
  params: OrchestrateParams,
): Promise<JsonObject> {
  const current = await requireContext(context),
    agentId = requireAgentId(params);
  if (!params.task) throw new OrchestrationError("TASK_REQUIRED");
  const found = await current.store.getAgent(agentId);
  if (!found) throw new OrchestrationError("AGENT_NOT_REGISTERED");
  await reconcile(current, new Set([found.runId]));
  let agent = (await current.store.getAgent(agentId))!;
  const previous = agent.runs.find((run) => run.runId === agent.runId)!;
  if (!previous.terminal) throw new OrchestrationError("RUN_NOT_TERMINAL");
  if (agent.processState === "closed" || agent.processState === "failed")
    throw new OrchestrationError("AGENT_NOT_REUSABLE");
  const exact = await identity(current.cli, agent);
  if (exact.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  if (exact.kind === "absent") throw new OrchestrationError("AGENT_MISSING");
  const createdAt = now(),
    run: RunRecord = {
      runId: `r-${randomUUID()}`,
      assignmentGeneration: agent.assignmentGeneration + 1,
      phase: "running",
      latestProgress: null,
      terminal: null,
      deliveredSequence: 0,
      terminalDelivered: false,
      notifiedSequence: 0,
      terminalNotified: false,
      cancelRequestedAt: null,
      assignmentState: "pending-prompt",
      pendingTask: params.task,
      legacyDeliveredEventIds: [],
      createdAt,
      updatedAt: createdAt,
    };
  agent = await current.store.startAssignment(agent.agentId, run);
  await current.cli.agentPrompt(
    agent.herdrAgentName,
    assignmentPrompt(run.runId, run.assignmentGeneration, params.task),
  );
  agent = await current.store.updateRun(agent.agentId, run.runId, {
    assignmentState: "delivered",
    pendingTask: null,
  });
  const after = await identity(current.cli, agent);
  if (after.kind !== "present")
    throw new OrchestrationError(
      after.kind === "mismatch" ? "IDENTITY_MISMATCH" : "AGENT_MISSING",
    );
  agent = await current.store.updateAgent(agent.agentId, {
    processState: "live",
    runPhase: "running",
    herdrAttention: after.attention,
  });
  return {
    ok: true,
    action: "reuse",
    domainId: current.store.domainId,
    previousRunId: previous.runId,
    ...recordView(agent),
  };
}

async function recover(context: PiContext): Promise<JsonObject> {
  const current = await requireContext(context);
  await current.store.load();
  await reconcile(current);
  const managed = await current.store.managedTab();
  let managedTabState: ManagedTabState = "absent";
  if (managed) {
    managedTabState = await verifyTab(current, managed);
    if (managedTabState === "live")
      await current.store.setManagedTab({ ...managed, verifiedAt: now() });
    else if (managedTabState === "missing")
      await current.store.markManagedTabAgentsMissing(managed.tabId);
  }
  const recovered: JsonObject[] = [];
  for (const agent of await current.store.list()) {
    if (agent.processState === "closed") {
      recovered.push(listRecordView(agent, "absent"));
      continue;
    }
    const exact = await identity(current.cli, agent);
    if (exact.kind === "mismatch") {
      recovered.push({
        ...listRecordView(agent, "mismatch"),
        recoveryStatus: "identity-mismatch",
      });
      continue;
    }
    let updated = await current.store.updateAgent(agent.agentId, {
      processState: exact.kind === "present" ? "live" : "missing",
      herdrAttention: exact.kind === "present" ? exact.attention : "unknown",
      ...(!agent.terminal &&
      exact.kind === "absent" &&
      agent.runPhase !== "cancel_requested"
        ? { runPhase: "unknown" as const }
        : {}),
    });
    let assignment = updated.runs.find((run) => run.runId === updated.runId)!;
    if (!assignment.terminal && assignment.phase === "cancel_requested") {
      if (exact.kind === "absent") {
        await settleCancelled(
          current,
          updated,
          assignment,
          "Cancellation confirmed during recovery after exact child termination.",
        );
        updated = (await current.store.getAgent(updated.agentId))!;
      } else {
        const dispatch = await dispatchCancellation(current, updated, assignment);
        updated = (await current.store.getAgent(updated.agentId))!;
        assignment = updated.runs.find((run) => run.runId === updated.runId)!;
        if (dispatch === "absent" && !assignment.terminal) {
          await settleCancelled(
            current,
            updated,
            assignment,
            "Cancellation confirmed during recovery after exact child termination.",
          );
          updated = (await current.store.getAgent(updated.agentId))!;
        }
      }
      assignment = updated.runs.find((run) => run.runId === updated.runId)!;
    }
    if (
      exact.kind === "present" &&
      !assignment.terminal &&
      assignment.phase !== "cancel_requested" &&
      assignment.assignmentState === "pending-prompt" &&
      assignment.pendingTask
    ) {
      await current.cli.agentPrompt(
        updated.herdrAgentName,
        assignmentPrompt(
          assignment.runId,
          assignment.assignmentGeneration,
          assignment.pendingTask,
        ),
      );
      updated = await current.store.updateRun(
        updated.agentId,
        assignment.runId,
        { assignmentState: "delivered", pendingTask: null },
      );
    }
    recovered.push({
      ...listRecordView(updated, exact.kind),
      recoveryStatus: exact.kind,
    });
  }
  return {
    ok: true,
    action: "recover",
    domainId: current.store.domainId,
    parent: current.parent,
    managedTabId: managed?.tabId ?? null,
    managedTabState,
    agents: recovered
      .sort((left, right) =>
        String(right.updatedAt).localeCompare(String(left.updatedAt)),
      )
      .slice(0, MAX_LIST_AGENTS),
    returnedAgentCount: Math.min(recovered.length, MAX_LIST_AGENTS),
    trackedAgentCount: recovered.length,
    truncated: recovered.length > MAX_LIST_AGENTS,
  };
}

async function detachIfNoManagedPanes(
  current: OrchestrationContext,
  tabId: string,
): Promise<void> {
  let active = false;
  for (const agent of await current.store.list()) {
    if (
      agent.topology !== "managed-subagents-tab-v2" ||
      agent.tabId !== tabId ||
      agent.processState === "closed" ||
      agent.processState === "failed"
    )
      continue;
    const result = await identity(current.cli, agent);
    if (result.kind === "present" || result.kind === "mismatch") {
      active = true;
    } else {
      await current.store.updateAgent(agent.agentId, {
        processState: "missing",
        runPhase:
          agent.terminal || agent.runPhase === "cancel_requested"
            ? agent.runPhase
            : "unknown",
        herdrAttention: "unknown",
      });
    }
  }
  if (!active) await current.store.clearManagedTab(tabId);
}

async function close(
  context: PiContext,
  params: OrchestrateParams,
): Promise<JsonObject> {
  const current = await requireContext(context);
  const agentId = requireAgentId(params);
  const agent = await current.store.getAgent(agentId);
  if (!agent) throw new OrchestrationError("AGENT_NOT_REGISTERED");
  if (agent.paneId === current.parent.paneId)
    throw new OrchestrationError("PARENT_PANE_TARGET_REFUSED");
  if (agent.processState === "closed")
    return {
      ok: true,
      action: "close",
      domainId: current.store.domainId,
      ...recordView(agent, "absent"),
      alreadyAbsent: true,
    };
  await reconcile(current, new Set([agent.runId]));
  const currentAgent = (await current.store.getAgent(agentId))!;
  const currentRun = currentAgent.runs.find(
    (run) => run.runId === currentAgent.runId,
  )!;
  const result = await identity(current.cli, currentAgent);
  if (result.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  if (!currentRun.terminal && currentRun.phase !== "cancel_requested") {
    await current.store.updateRun(currentAgent.agentId, currentRun.runId, {
      phase: "cancel_requested",
      cancelRequestedAt: now(),
    });
  }
  if (result.kind !== "absent") {
    try {
      await current.cli.paneClose(currentAgent.paneId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const confirmed = await identity(current.cli, currentAgent);
  if (confirmed.kind === "mismatch") throw new OrchestrationError("IDENTITY_MISMATCH");
  if (confirmed.kind !== "absent")
    throw new OrchestrationError("PANE_TERMINATION_UNCONFIRMED");

  const latest = (await current.store.getRun(currentRun.runId))!;
  if (!latest.run.terminal)
    await settleCancelled(
      current,
      latest.agent,
      latest.run,
      "Cancellation confirmed after exact child termination.",
    );
  const settled = (await current.store.getAgent(agentId))!;
  const updated = await current.store.updateAgent(agentId, {
    processState: "closed",
    runPhase: settled.runPhase,
    latestProgress: settled.latestProgress,
    terminal: settled.terminal,
    herdrAttention: "unknown",
  });
  if (updated.topology === "managed-subagents-tab-v2")
    await detachIfNoManagedPanes(current, updated.tabId);
  return {
    ok: true,
    action: "close",
    domainId: current.store.domainId,
    ...recordView(updated, "absent"),
    alreadyAbsent: result.kind === "absent",
  };
}

async function execute(
  context: PiContext,
  params: OrchestrateParams,
  extensionPath?: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  if (params.action === "health") return health(context);
  const scope = await requireContext(context);
  return withDomainLock(scope.store.domainId, async () => {
    switch (params.action) {
      case "health":
        return health(context);
      case "run":
      case "spawn":
        return spawn(context, params, extensionPath);
      case "list":
        return list(context);
      case "inspect":
        return inspect(context, params);
      case "send":
        return send(context, params);
      case "close":
        return close(context, params);
      case "wait":
        return waitRuns(context, params, signal);
      case "collect":
        return collect(context, params);
      case "reuse":
        return reuse(context, params);
      case "cancel":
        return cancel(context, params);
      case "recover":
        return recover(context);
    }
    throw new OrchestrationError("INVALID_REQUEST");
  }, signal);
}

export function registerOrchestrate(
  api: ExtensionAPI,
  extensionPath?: string,
): void {
  const tool: ToolRegistration = {
    name: "orchestrate",
    label: "Orchestrate",
    description:
      "Run and manage direct-Herdr agents in one shared subagents tab. Supports run/spawn, list, inspect, wait, collect, send, reuse, recover, cooperative cancellation, and exact close. Full results are available only through collect.",
    promptSnippet:
      "Run and manage direct Herdr subagents with exact identity and explicit results",
    parameters:
      ORCHESTRATE_SCHEMA as unknown as ToolRegistration["parameters"],
    async execute(_toolCallId, rawParams, signal, _onUpdate, context) {
      try {
        const result = await execute(
          context,
          parseParams(rawParams),
          extensionPath,
          signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        throw publicError(error);
      }
    },
  };
  const runtime = api as unknown as OrchestrationApi;
  runtime.registerTool(tool);

  let timer: NodeJS.Timeout | undefined;
  let draining = false;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const drain = async (context: PiContext): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      const scope = await requireContext(context);
      await withDomainLock(scope.store.domainId, async () => {
        const current = await requireContext(context);
        await drainNotificationsUnlocked(current, context);
      });
    } catch {
      // Notification delivery must never change orchestration behavior.
    } finally {
      draining = false;
    }
  };

  runtime.on("session_start", (_event, rawContext) => {
    stop();
    const context = rawContext as PiContext;
    void drain(context);
    timer = setInterval(() => void drain(context), 750);
    timer.unref?.();
  });
  runtime.on("session_shutdown", () => stop());
}
