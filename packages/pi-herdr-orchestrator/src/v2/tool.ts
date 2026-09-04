import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChannelStore, ChannelStoreError } from "./channel-store.js";
import { HerdrCli, HerdrCliError } from "./herdr-cli.js";
import { RegistryError, RegistryStore } from "./store.js";
import {
  CANARY_PROTOCOL,
  CANARY_VERSION,
  type AgentRecord,
  type JsonObject,
  type ManagedTabRecord,
  type OrchestrateV2Params,
  type ParentIdentity,
  type RunResult,
} from "./types.js";

const execFile = promisify(execFileCallback);
const MAX_TASK_BYTES = 8192;
const MAX_MESSAGE_BYTES = 8192;
const MAX_LABEL_BYTES = 160;
const MAX_PATH_BYTES = 4096;
const MAX_LINES = 40;
const MAX_ACTIVE_CHILDREN = 6;
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
} as const;

const stringProperty = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const ORCHESTRATE_V2_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["action"], properties: { action: { const: "health" } } },
    {
      type: "object", additionalProperties: false, required: ["action", "task"],
      properties: { action: { const: "spawn" }, task: stringProperty(MAX_TASK_BYTES), label: stringProperty(MAX_LABEL_BYTES), cwd: stringProperty(MAX_PATH_BYTES) },
    },
    { type: "object", additionalProperties: false, required: ["action"], properties: { action: { const: "list" } } },
    {
      type: "object", additionalProperties: false, required: ["action"],
      properties: { action: { const: "inspect" }, agentId: stringProperty(128), runId: stringProperty(128), lines: { type: "integer", minimum: 1, maximum: MAX_LINES } },
    },
    {
      type: "object", additionalProperties: false, required: ["action", "agentId", "message"],
      properties: { action: { const: "send" }, agentId: stringProperty(128), message: stringProperty(MAX_MESSAGE_BYTES) },
    },
    {
      type: "object", additionalProperties: false, required: ["action", "agentId"],
      properties: { action: { const: "close" }, agentId: stringProperty(128) },
    },
    {
      type: "object", additionalProperties: false, required: ["action", "runIds"],
      properties: { action: { const: "wait" }, runIds: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: stringProperty(128) }, timeoutMs: { type: "integer", minimum: 0, maximum: 120000 } },
    },
    {
      type: "object", additionalProperties: false, required: ["action", "runId"],
      properties: { action: { const: "collect" }, runId: stringProperty(128) },
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  return stringValue(pane.name) ?? stringValue(pane.agent_name) ??
    stringValue(object(pane.agent_session)?.name);
}

function isNotFound(error: unknown): boolean {
  return error instanceof HerdrCliError && error.notFound;
}

function publicError(error: unknown): CanaryError {
  if (error instanceof CanaryError) return error;
  if (error instanceof RegistryError || error instanceof ChannelStoreError) return new CanaryError(error.code);
  if (error instanceof HerdrCliError) return new CanaryError(error.code);
  return new CanaryError("V2_OPERATION_FAILED");
}

async function withDomainLock<T>(domainId: string, action: () => Promise<T>): Promise<T> {
  const previous = domainLocks.get(domainId) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.then(() => gate);
  domainLocks.set(domainId, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (domainLocks.get(domainId) === queued) domainLocks.delete(domainId);
  }
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
  if (
    idFrom(herdrAgent, "pane_id") !== agent.paneId ||
    idFrom(herdrAgent, "workspace_id") !== agent.workspaceId ||
    idFrom(herdrAgent, "tab_id") !== agent.tabId ||
    stringValue(herdrAgent.name) !== agent.herdrAgentName
  ) return { kind: "mismatch" };
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
  ) return { kind: "mismatch" };
  const currentName = paneAgentName(pane);
  if (currentName && currentName !== agent.herdrAgentName) return { kind: "mismatch" };
  return { kind: "present", agent: herdrAgent, pane, attention: attention(herdrAgent) };
}

function recordView(agent: AgentRecord, identityState?: IdentityResult["kind"]): JsonObject {
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
    processState: "missing",
    runPhase: agent.terminal || agent.runPhase === "closed" || agent.runPhase === "failed" ? agent.runPhase : "unknown",
    herdrAttention: "unknown",
  });
  return { agent: updated, identityState: result.kind };
}

async function verifyTab(
  current: V2Context,
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

async function activeManagedAgents(current: V2Context, tabId: string): Promise<AgentRecord[]> {
  const active: AgentRecord[] = [];
  for (const agent of await current.store.list()) {
    if (agent.topology !== "managed-subagents-tab-v2" || agent.tabId !== tabId ||
        agent.processState === "closed" || agent.processState === "failed") continue;
    const result = await identity(current.cli, agent);
    if (result.kind === "mismatch") throw new CanaryError("IDENTITY_MISMATCH");
    if (result.kind === "present") {
      active.push(await current.store.updateAgent(agent.agentId, {
        processState: "live",
        herdrAttention: result.attention,
      }));
    } else {
      await current.store.updateAgent(agent.agentId, {
        processState: "missing",
        runPhase: agent.terminal ? agent.runPhase : "unknown",
        herdrAttention: "unknown",
      });
    }
  }
  return active;
}

async function clearMissingTab(current: V2Context, record: ManagedTabRecord): Promise<void> {
  await current.store.markManagedTabAgentsMissing(record.tabId);
  await current.store.clearManagedTab(record.tabId);
}

async function cleanCreatedTab(
  current: V2Context,
  tabId: string,
  paneId?: string,
): Promise<void> {
  try {
    const tab = await current.cli.tabGet(tabId);
    if (idFrom(tab, "tab_id") !== tabId || idFrom(tab, "workspace_id") !== current.parent.workspaceId)
      return;
    const panes = (await current.cli.paneList(current.parent.workspaceId))
      .filter((pane) => idFrom(pane, "tab_id") === tabId);
    if (panes.length === 1 && (!paneId || idFrom(panes[0], "pane_id") === paneId)) {
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
  current: V2Context,
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
  if (!tabId) throw new CanaryError("MANAGED_TAB_CREATE_FAILED");
  if (!paneId) {
    await cleanCreatedTab(current, tabId).catch(() => undefined);
    throw new CanaryError("MANAGED_TAB_CREATE_FAILED");
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
    ) throw new CanaryError("MANAGED_TAB_IDENTITY_MISMATCH");
    const [tab, pane] = await Promise.all([
      current.cli.tabGet(tabId),
      current.cli.paneGet(paneId),
    ]);
    if (
      idFrom(tab, "tab_id") !== tabId || idFrom(tab, "workspace_id") !== current.parent.workspaceId ||
      idFrom(pane, "pane_id") !== paneId || idFrom(pane, "workspace_id") !== current.parent.workspaceId ||
      idFrom(pane, "tab_id") !== tabId
    ) throw new CanaryError("MANAGED_TAB_IDENTITY_MISMATCH");
    return { record, rootPaneId: paneId, created: true, active: [] };
  } catch (error) {
    await cleanCreatedTab(current, tabId, paneId).catch(() => undefined);
    throw error;
  }
}

async function ensureManagedSubagentTab(
  current: V2Context,
  cwd: string,
  environment: Record<string, string>,
): Promise<ManagedTabResult> {
  const existing = await current.store.managedTab();
  if (!existing) return createManagedTab(current, cwd, environment);
  const state = await verifyTab(current, existing);
  if (state === "mismatch") throw new CanaryError("MANAGED_TAB_IDENTITY_MISMATCH");
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

function layoutChoice(layout: JsonObject, active: AgentRecord[]): {
  paneId: string;
  direction: "right" | "down";
} {
  const owned = new Map(active.map((agent) => [agent.paneId, agent]));
  const panes = Array.isArray(layout.panes) ? layout.panes.map(object).filter(Boolean) : [];
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
    geometry.sort((a, b) => b.area - a.area || a.paneId.localeCompare(b.paneId));
    const target = geometry[0];
    if (target) return {
      paneId: target.paneId,
      direction: target.width >= target.height * 3 ? "right" : "down",
    };
  }
  const paneIds = active.map((agent) => agent.paneId).sort();
  const index = active.length <= 2 ? 0 : (active.length - 2) % paneIds.length;
  const paneId = paneIds[index];
  if (!paneId) throw new CanaryError("MANAGED_TAB_HAS_NO_TARGET");
  return { paneId, direction: active.length === 1 ? "right" : "down" };
}

async function createChildPane(
  current: V2Context,
  managed: ManagedTabResult,
  cwd: string,
  environment: Record<string, string>,
): Promise<string> {
  if (managed.created) {
    if (!managed.rootPaneId) throw new CanaryError("MANAGED_TAB_HAS_NO_ROOT_PANE");
    return managed.rootPaneId;
  }
  if (managed.active.length >= MAX_ACTIVE_CHILDREN)
    throw new CanaryError("SUBAGENT_CAPACITY_REACHED");
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
    { ...environment, PI_HERDR_PARENT_PANE_ID: current.parent.paneId,
      PI_HERDR_SUBAGENT_TAB_ID: managed.record.tabId },
  );
  const paneId = idFrom(pane, "pane_id");
  try {
    if (!paneId) throw new CanaryError("PANE_CREATE_FAILED");
    const exact = await current.cli.paneGet(paneId);
    if (
      idFrom(pane, "workspace_id") !== current.parent.workspaceId ||
      idFrom(pane, "tab_id") !== managed.record.tabId ||
      idFrom(exact, "pane_id") !== paneId ||
      idFrom(exact, "workspace_id") !== current.parent.workspaceId ||
      idFrom(exact, "tab_id") !== managed.record.tabId
    ) throw new CanaryError("PANE_CREATE_FAILED");
    return paneId;
  } catch (error) {
    if (paneId) {
      try {
        const exact = await current.cli.paneGet(paneId);
        if (
          idFrom(exact, "pane_id") === paneId &&
          idFrom(exact, "workspace_id") === current.parent.workspaceId &&
          idFrom(exact, "tab_id") === managed.record.tabId
        ) await current.cli.paneClose(paneId);
      } catch {
        // Do not guess when the returned pane identity is absent or incompatible.
      }
    }
    throw error;
  }
}

function parseParams(value: unknown): OrchestrateV2Params {
  const params = object(value);
  const action = stringValue(params?.action) as OrchestrateV2Params["action"] | undefined;
  if (!action || !["health", "spawn", "list", "inspect", "send", "close", "wait", "collect"].includes(action))
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
    ...(params?.runIds !== undefined ? { runIds: params.runIds as string[] } : {}),
    ...(params?.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs as number } : {}),
  };
}

function requireAgentId(params: OrchestrateV2Params): string {
  if (!params.agentId) throw new CanaryError("AGENT_ID_REQUIRED");
  return params.agentId;
}

async function managedHealth(current: V2Context): Promise<{
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
  if (state === "mismatch") return { tabId: record.tabId, state, activePaneCount: 0 };
  await current.store.setManagedTab({ ...record, verifiedAt: now() });
  try {
    const active = await activeManagedAgents(current, record.tabId);
    if (active.length === 0) {
      await current.store.clearManagedTab(record.tabId);
      return { tabId: null, state: "absent", activePaneCount: 0 };
    }
    return { tabId: record.tabId, state: "live", activePaneCount: active.length };
  } catch (error) {
    if (error instanceof CanaryError && error.code === "IDENTITY_MISMATCH")
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
  if (inside) running = await cli.status().then(() => true).catch(() => false);
  const base: JsonObject = {
    ok: true,
    canaryProtocol: CANARY_PROTOCOL,
    canaryVersion: CANARY_VERSION,
    domainId: null,
    parent: null,
    piVersion: piVersion ?? null,
    herdrVersion: herdrVersion ?? null,
    capabilities: running && inside && process.env.HERDR_SOCKET_PATH && process.env.HERDR_PANE_ID
      ? CAPABILITIES
      : Object.fromEntries(Object.keys(CAPABILITIES).map((key) => [key, false])),
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

async function spawnUnlocked(context: PiContext, params: OrchestrateV2Params, extensionPath: string): Promise<JsonObject> {
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
    PI_HERDR_ROOT_PARENT_PANE_ID: current.parent.paneId,
    PI_HERDR_AGENT_ID: agentId,
    PI_HERDR_RUN_ID: runId,
    PI_HERDR_AGENT_GENERATION: "1",
    PI_HERDR_ASSIGNMENT_GENERATION: "1",
  };
  const managed = await ensureManagedSubagentTab(current, cwd, environment);
  let paneId: string | undefined;
  let recordAdded = false;
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
    deliveredEventIds: [],
    terminalDelivered: false,
    createdAt,
    updatedAt: createdAt,
  };
  try {
    paneId = await createChildPane(current, managed, cwd, environment);
    if (paneId === current.parent.paneId) throw new CanaryError("PARENT_PANE_TARGET_REFUSED");
    agent.paneId = paneId;
    await current.store.addAgent(agent);
    recordAdded = true;
    await current.cli.agentStart(herdrAgentName, paneId, extensionPath);
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
      ...recordView(live),
      managedTabId: live.tabId,
      tabCreatedByRequest: managed.created,
      cwd: live.cwd,
    };
  } catch (error) {
    if (paneId) {
      if (managed.created) {
        await cleanCreatedTab(current, managed.record.tabId, paneId).catch(() => undefined);
      } else {
        try {
          const pane = await current.cli.paneGet(paneId);
          if (
            idFrom(pane, "pane_id") === paneId &&
            idFrom(pane, "workspace_id") === current.parent.workspaceId &&
            idFrom(pane, "tab_id") === managed.record.tabId
          ) await current.cli.paneClose(paneId);
        } catch {
          // Cleanup is intentionally limited to this request's exact pane.
        }
      }
    }
    if (recordAdded) {
      await current.store.updateAgent(agentId, {
        processState: "failed",
        runPhase: "failed",
        herdrAttention: "unknown",
      }).catch(() => undefined);
    }
    throw publicError(error);
  }
}

async function spawn(context: PiContext, params: OrchestrateV2Params, extensionPath: string): Promise<JsonObject> {
  return spawnUnlocked(context, params, extensionPath);
}

function resultValid(result: RunResult, agent: AgentRecord): boolean {
  return result.version === 1 && result.domainId === agent.domainId && result.agentId === agent.agentId &&
    result.runId === agent.runId && result.agentGeneration === agent.agentGeneration &&
    result.assignmentGeneration === agent.assignmentGeneration &&
    (result.status === "completed" || result.status === "failed") && typeof result.summary === "string" &&
    typeof result.completedAt === "string";
}

async function reconcile(current: V2Context, runIds?: Set<string>): Promise<void> {
  const channel = new ChannelStore(current.store.domainId);
  const events = await channel.events();
  for (const original of await current.store.list()) {
    if (runIds && !runIds.has(original.runId)) continue;
    let agent = original;
    const progress = events.filter((event) => event.version === 1 && event.domainId === agent.domainId &&
      event.agentId === agent.agentId && event.runId === agent.runId && event.agentGeneration === 1 &&
      event.assignmentGeneration === 1 && event.kind === "progress").sort((a,b) => a.eventId.localeCompare(b.eventId)).at(-1);
    if (progress && progress.eventId !== agent.latestProgress?.eventId)
      agent = await current.store.updateAgent(agent.agentId, { latestProgress: { eventId:progress.eventId, summary:progress.summary.slice(0,2048), createdAt:progress.createdAt } });
    const result = await channel.result(agent.runId);
    if (result) {
      if (!resultValid(result, agent)) throw new CanaryError("RESULT_IDENTITY_MISMATCH");
      if (!agent.terminal) agent = await current.store.updateAgent(agent.agentId, {
        terminal:{status:result.status,summary:result.summary.slice(0,4096),completedAt:result.completedAt,resultFile:`results/${agent.runId}.json`},
        runPhase:result.status === "completed" ? "completed" : "failed",
      });
      else if (agent.terminal.status !== result.status || agent.terminal.summary !== result.summary || agent.terminal.completedAt !== result.completedAt)
        throw new CanaryError("COMPLETION_CONFLICT");
    }
  }
}

async function waitRuns(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  if (!Array.isArray(params.runIds) || params.runIds.length < 1 || params.runIds.length > 8 ||
      params.runIds.some((id) => typeof id !== "string" || !/^r-[0-9a-f-]{36}$/u.test(id))) throw new CanaryError("INVALID_RUN_IDS");
  const timeoutMs = params.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw new CanaryError("INVALID_TIMEOUT");
  const current = await requireContext(context), wanted = new Set(params.runIds), channel = new ChannelStore(current.store.domainId);
  for (const runId of wanted) if (!await current.store.getAgent(undefined, runId)) throw new CanaryError("RUN_NOT_REGISTERED");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await reconcile(current, wanted);
    const agents = (await current.store.list()).filter((a) => wanted.has(a.runId));
    const all = (await channel.events()).filter((e) => {
      const agent = agents.find((a) => a.runId === e.runId);
      return !!agent && e.version === 1 && e.domainId === agent.domainId && e.agentId === agent.agentId &&
        e.agentGeneration === agent.agentGeneration && e.assignmentGeneration === agent.assignmentGeneration &&
        (e.kind === "progress" || e.kind === "message") && typeof e.summary === "string" &&
        typeof e.createdAt === "string" && typeof e.eventId === "string";
    });
    const fresh = all.filter((e) => { const a=agents.find((x)=>x.runId===e.runId); return !!a && !a.deliveredEventIds.includes(e.eventId); })
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId)).slice(0,24);
    const results = agents.filter((a)=>a.terminal && !a.terminalDelivered).map((a)=>({runId:a.runId,agentId:a.agentId,status:a.terminal!.status,summary:a.terminal!.summary,completedAt:a.terminal!.completedAt,resultAvailable:true}));
    if (fresh.length || results.length || Date.now() >= deadline) {
      for (const agent of agents) {
        const last=fresh.filter((e)=>e.runId===agent.runId).at(-1);
        const delivered = fresh.filter((e)=>e.runId===agent.runId).map((e)=>e.eventId);
        if (last || (agent.terminal && !agent.terminalDelivered)) await current.store.updateAgent(agent.agentId, {
          ...(last ? {deliveredEventIds:[...agent.deliveredEventIds,...delivered]}:{}), ...(agent.terminal && !agent.terminalDelivered ? {terminalDelivered:true}:{}) });
      }
      return {ok:true,action:"wait",events:fresh.map((e)=>({eventId:e.eventId,kind:e.kind,runId:e.runId,agentId:e.agentId,target:e.target,summary:e.summary.slice(0,2048),createdAt:e.createdAt})),results,timedOut:!fresh.length&&!results.length};
    }
    await channel.waitForChange(Math.max(0, deadline-Date.now()));
  }
}

async function collect(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  if (!params.runId) throw new CanaryError("RUN_ID_REQUIRED");
  const current=await requireContext(context), agent=await current.store.getAgent(undefined,params.runId);
  if (!agent) throw new CanaryError("RUN_NOT_REGISTERED");
  await reconcile(current,new Set([params.runId]));
  const result=await new ChannelStore(current.store.domainId).result(params.runId);
  if (!result || !resultValid(result,agent)) throw new CanaryError(result ? "RESULT_IDENTITY_MISMATCH" : "RESULT_NOT_READY");
  return {ok:true,action:"collect",runId:result.runId,agentId:result.agentId,status:result.status,summary:result.summary,finalResult:result.finalResult,completedAt:result.completedAt};
}

async function list(context: PiContext): Promise<JsonObject> {
  const current = await requireContext(context);
  await reconcile(current);
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
  let agent = await current.store.getAgent(params.agentId, params.runId);
  if (!agent) throw new CanaryError("AGENT_NOT_REGISTERED");
  await reconcile(current, new Set([agent.runId]));
  agent = (await current.store.getAgent(agent.agentId)) ?? agent;
  const lines = params.lines === undefined ? MAX_LINES : params.lines;
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_LINES)
    throw new CanaryError("INVALID_LINE_COUNT");
  let refreshed = agent;
  let identityState: IdentityResult["kind"] = "absent";
  if (agent.processState !== "closed") {
    const result = await identity(current.cli, agent);
    identityState = result.kind;
    if (result.kind === "mismatch") throw new CanaryError("IDENTITY_MISMATCH");
    if (result.kind === "absent") {
      refreshed = await current.store.updateAgent(agent.agentId, {
        processState: "missing",
        runPhase: agent.terminal || agent.runPhase === "failed" ? agent.runPhase : "unknown",
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
    runPhase: afterPrompt.kind === "present"
      ? (agent.runPhase === "starting" ? "running" : agent.runPhase)
      : (agent.terminal ? agent.runPhase : "unknown"),
  });
  return { ok: true, action: "send", domainId: current.store.domainId, ...recordView(updated) };
}

async function detachIfNoManagedPanes(current: V2Context, tabId: string): Promise<void> {
  let active = false;
  for (const agent of await current.store.list()) {
    if (agent.topology !== "managed-subagents-tab-v2" || agent.tabId !== tabId ||
        agent.processState === "closed" || agent.processState === "failed") continue;
    const result = await identity(current.cli, agent);
    if (result.kind === "present" || result.kind === "mismatch") {
      active = true;
    } else {
      await current.store.updateAgent(agent.agentId, {
        processState: "missing",
        runPhase: agent.terminal ? agent.runPhase : "unknown",
        herdrAttention: "unknown",
      });
    }
  }
  if (!active) await current.store.clearManagedTab(tabId);
}

async function close(context: PiContext, params: OrchestrateV2Params): Promise<JsonObject> {
  const current = await requireContext(context);
  const agentId = requireAgentId(params);
  const agent = await current.store.getAgent(agentId);
  if (!agent) throw new CanaryError("AGENT_NOT_REGISTERED");
  if (agent.paneId === current.parent.paneId) throw new CanaryError("PARENT_PANE_TARGET_REFUSED");
  if (agent.processState === "closed")
    return { ok: true, action: "close", domainId: current.store.domainId,
      ...recordView(agent, "absent"), alreadyAbsent: true };
  const result = await identity(current.cli, agent);
  if (result.kind === "mismatch") throw new CanaryError("IDENTITY_MISMATCH");
  if (result.kind !== "absent") {
    try {
      await current.cli.paneClose(agent.paneId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const updated = await current.store.updateAgent(agentId, {
    processState: "closed",
    runPhase: "closed",
    herdrAttention: "unknown",
  });
  if (updated.topology === "managed-subagents-tab-v2")
    await detachIfNoManagedPanes(current, updated.tabId);
  return { ok: true, action: "close", domainId: current.store.domainId,
    ...recordView(updated, "absent"), alreadyAbsent: result.kind === "absent" };
}

async function execute(context: PiContext, params: OrchestrateV2Params, extensionPath: string): Promise<JsonObject> {
  if (params.action === "health") return health(context);
  const scope = await requireContext(context);
  return withDomainLock(scope.store.domainId, async () => {
    switch (params.action) {
      case "health": return health(context);
      case "spawn": return spawn(context, params, extensionPath);
      case "list": return list(context);
      case "inspect": return inspect(context, params);
      case "send": return send(context, params);
      case "close": return close(context, params);
      case "wait": return waitRuns(context, params);
      case "collect": return collect(context, params);
    }
  });
}

export function registerOrchestrateV2(api: ExtensionAPI, extensionPath: string): void {
  const tool: ToolRegistration = {
    name: "orchestrate_v2",
    label: "Orchestrate v2 Canary",
    description:
      "M03 canary: direct visible delegation with explicit child progress, messaging, durable completion, wait, and collect. Herdr/Pi state never implies delegated completion.",
    promptSnippet: "Direct Herdr shared-tab visible-agent canary control",
    parameters: ORCHESTRATE_V2_SCHEMA as unknown as ToolRegistration["parameters"],
    async execute(_toolCallId, rawParams, _signal, _onUpdate, context) {
      try {
        const result = await execute(context, parseParams(rawParams), extensionPath);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        throw publicError(error);
      }
    },
  };
  (api as unknown as CanaryApi).registerTool(tool);
}
