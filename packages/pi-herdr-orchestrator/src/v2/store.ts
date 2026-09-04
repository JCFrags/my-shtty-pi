import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  REGISTRY_VERSION,
  type AgentRecord,
  type AgentTopology,
  type JsonObject,
  type ManagedTabRecord,
  type ParentIdentity,
  type ProcessState,
  type Registry,
  type RunPhase,
} from "./types.js";

const MAX_STRING = 16384;
const PROCESS_STATES: readonly ProcessState[] = ["starting", "live", "missing", "closed", "failed"];
const RUN_PHASES: readonly RunPhase[] = ["starting", "running", "completed", "closed", "failed", "unknown"];
const TOPOLOGIES: readonly AgentTopology[] = ["parent-split-v1", "managed-subagents-tab-v2"];

export class RegistryError extends Error {
  readonly code: "REGISTRY_MALFORMED" | "REGISTRY_AGENT_MISSING";
  constructor(code: "REGISTRY_MALFORMED" | "REGISTRY_AGENT_MISSING") {
    super(code); this.name = "RegistryError"; this.code = code;
  }
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function stringField(value: JsonObject, key: string, max = MAX_STRING): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.length > 0 && Buffer.byteLength(item) <= max ? item : undefined;
}
function parentValid(value: unknown): value is ParentIdentity {
  const item = record(value);
  return !!item && !!stringField(item, "workspaceId", 128) && !!stringField(item, "tabId", 128) && !!stringField(item, "paneId", 128);
}
function managedTabValid(value: unknown): value is ManagedTabRecord {
  const item = record(value);
  return !!item && !!stringField(item, "workspaceId", 128) && !!stringField(item, "tabId", 128) &&
    !!stringField(item, "requestedLabel", 160) && !!stringField(item, "createdAt", 64) && !!stringField(item, "verifiedAt", 64);
}
function progressValid(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  return !!item && !!stringField(item, "eventId", 128) && !!stringField(item, "summary", 2048) && !!stringField(item, "createdAt", 64);
}
function terminalValid(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  return !!item && (item.status === "completed" || item.status === "failed") && !!stringField(item, "summary", 4096) &&
    !!stringField(item, "completedAt", 64) && !!stringField(item, "resultFile", 256);
}
function agentBaseValid(value: unknown, domainId: string, requireTopology: boolean): boolean {
  const item = record(value);
  if (!item || item.domainId !== domainId) return false;
  if (!stringField(item, "agentId", 128) || !stringField(item, "runId", 128) || !stringField(item, "herdrAgentName", 32) ||
      !stringField(item, "workspaceId", 128) || !stringField(item, "tabId", 128) || !stringField(item, "paneId", 128) ||
      !stringField(item, "cwd", 4096) || !stringField(item, "label", 160) || !stringField(item, "herdrAttention", 64) ||
      !stringField(item, "createdAt", 64) || !stringField(item, "updatedAt", 64)) return false;
  if (requireTopology && (typeof item.topology !== "string" || !TOPOLOGIES.includes(item.topology as AgentTopology))) return false;
  return item.agentGeneration === 1 && item.assignmentGeneration === 1 && typeof item.processState === "string" &&
    PROCESS_STATES.includes(item.processState as ProcessState) && typeof item.runPhase === "string" && RUN_PHASES.includes(item.runPhase as RunPhase);
}
function agentV3Valid(value: unknown, domainId: string): boolean {
  const item = record(value);
  return agentBaseValid(value, domainId, true) && !!item && progressValid(item.latestProgress) && terminalValid(item.terminal) &&
    Array.isArray(item.deliveredEventIds) && item.deliveredEventIds.length <= 1024 &&
    item.deliveredEventIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) &&
    typeof item.terminalDelivered === "boolean";
}
function commonValid(item: JsonObject, domainId: string): boolean {
  return item.domainId === domainId && !!stringField(item, "projectRoot", 4096) && parentValid(item.parent) &&
    !!stringField(item, "createdAt", 64) && !!stringField(item, "updatedAt", 64) && Array.isArray(item.agents);
}
function validateRegistry(value: unknown, domainId: string): Registry {
  const item = record(value);
  if (!item || item.version !== REGISTRY_VERSION || !commonValid(item, domainId) ||
      (item.managedTab !== null && !managedTabValid(item.managedTab)) || !(item.agents as unknown[]).every((a) => agentV3Valid(a, domainId)))
    throw new RegistryError("REGISTRY_MALFORMED");
  return item as unknown as Registry;
}
function migrate(value: unknown, domainId: string): Registry | undefined {
  const item = record(value);
  if (!item || (item.version !== 1 && item.version !== 2) || !commonValid(item, domainId)) return undefined;
  const requireTopology = item.version === 2;
  if (!(item.agents as unknown[]).every((a) => agentBaseValid(a, domainId, requireTopology))) return undefined;
  const timestamp = new Date().toISOString();
  return {
    version: REGISTRY_VERSION, domainId, projectRoot: item.projectRoot as string,
    parent: item.parent as unknown as ParentIdentity,
    managedTab: item.version === 2 && (item.managedTab === null || managedTabValid(item.managedTab)) ? item.managedTab as ManagedTabRecord | null : null,
    createdAt: item.createdAt as string, updatedAt: timestamp,
    agents: (item.agents as JsonObject[]).map((agent) => ({ ...agent,
      topology: item.version === 1 ? "parent-split-v1" : agent.topology,
      latestProgress: null, terminal: null, deliveredEventIds: [], terminalDelivered: false,
    })) as unknown as AgentRecord[],
  };
}
function stateBase(): string {
  const configured = process.env.XDG_STATE_HOME;
  return resolve(configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "state"), "pi-herdr-orchestrator-v2");
}
function validDomainId(domainId: string): boolean { return /^d-[a-f0-9]{24}$/u.test(domainId); }
export function registryPathForDomain(domainId: string): string {
  if (!validDomainId(domainId)) throw new RegistryError("REGISTRY_MALFORMED");
  return join(stateBase(), `${domainId}.json`);
}
export function domainDirectoryFor(domainId: string): string {
  if (!validDomainId(domainId)) throw new RegistryError("REGISTRY_MALFORMED");
  return join(stateBase(), domainId);
}
export async function readRegistryByDomain(domainId: string): Promise<Registry> {
  try { return validateRegistry(JSON.parse(await readFile(registryPathForDomain(domainId), "utf8")), domainId); }
  catch (error) { if (error instanceof RegistryError) throw error; throw new RegistryError("REGISTRY_MALFORMED"); }
}
export function domainIdFor(projectRoot: string, parent: ParentIdentity): string {
  const input = [resolve(projectRoot), parent.workspaceId, parent.tabId, parent.paneId].join("\0");
  return `d-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

export class RegistryStore {
  readonly domainId: string; readonly path: string;
  private readonly projectRoot: string; private readonly parent: ParentIdentity; private loaded?: Registry;
  constructor(projectRoot: string, parent: ParentIdentity) {
    this.projectRoot = resolve(projectRoot); this.parent = { ...parent };
    this.domainId = domainIdFor(this.projectRoot, this.parent); this.path = registryPathForDomain(this.domainId);
  }
  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.path); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700).catch(() => undefined);
  }
  private ownershipValid(registry: Registry): boolean {
    return registry.projectRoot === this.projectRoot && registry.parent.workspaceId === this.parent.workspaceId &&
      registry.parent.tabId === this.parent.tabId && registry.parent.paneId === this.parent.paneId;
  }
  async load(): Promise<Registry> {
    if (this.loaded) return this.loaded;
    await this.ensureDirectory(); let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw new RegistryError("REGISTRY_MALFORMED");
      const timestamp = new Date().toISOString();
      this.loaded = { version: REGISTRY_VERSION, domainId: this.domainId, projectRoot: this.projectRoot, parent: { ...this.parent },
        managedTab: null, createdAt: timestamp, updatedAt: timestamp, agents: [] };
      return this.loaded;
    }
    const migrated = migrate(parsed, this.domainId);
    this.loaded = migrated ?? validateRegistry(parsed, this.domainId);
    if (!this.ownershipValid(this.loaded)) throw new RegistryError("REGISTRY_MALFORMED");
    if (migrated) await this.save(migrated);
    return this.loaded;
  }
  private async save(next: Registry): Promise<void> {
    validateRegistry(next, this.domainId); if (!this.ownershipValid(next)) throw new RegistryError("REGISTRY_MALFORMED");
    await this.ensureDirectory(); const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600).catch(() => undefined);
    try { await rename(temporary, this.path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    this.loaded = next;
  }
  async addAgent(agent: AgentRecord): Promise<void> {
    const current = await this.load();
    if (current.agents.some((a) => a.agentId === agent.agentId || a.runId === agent.runId)) throw new RegistryError("REGISTRY_MALFORMED");
    await this.save({ ...current, updatedAt: new Date().toISOString(), agents: [...current.agents, agent] });
  }
  async updateAgent(agentId: string, patch: Partial<AgentRecord>): Promise<AgentRecord> {
    const current = await this.load(); const index = current.agents.findIndex((a) => a.agentId === agentId);
    if (index < 0) throw new RegistryError("REGISTRY_AGENT_MISSING");
    const updated = { ...current.agents[index], ...patch, updatedAt: new Date().toISOString() } as AgentRecord;
    const agents = [...current.agents]; agents[index] = updated;
    await this.save({ ...current, updatedAt: new Date().toISOString(), agents }); return updated;
  }
  async setManagedTab(managedTab: ManagedTabRecord | null): Promise<void> {
    const current = await this.load(); await this.save({ ...current, managedTab, updatedAt: new Date().toISOString() });
  }
  async clearManagedTab(expectedTabId: string): Promise<boolean> {
    const current = await this.load(); if (current.managedTab?.tabId !== expectedTabId) return false;
    await this.save({ ...current, managedTab: null, updatedAt: new Date().toISOString() }); return true;
  }
  async markManagedTabAgentsMissing(tabId: string): Promise<void> {
    const current = await this.load(); const timestamp = new Date().toISOString();
    const agents = current.agents.map((agent) => agent.topology === "managed-subagents-tab-v2" && agent.tabId === tabId &&
      agent.processState !== "closed" && agent.processState !== "failed" ? { ...agent, processState: "missing" as const,
        runPhase: agent.terminal ? agent.runPhase : "unknown" as const, herdrAttention: "unknown", updatedAt: timestamp } : agent);
    await this.save({ ...current, agents, updatedAt: timestamp });
  }
  async getAgent(agentId?: string, runId?: string): Promise<AgentRecord | undefined> {
    if (!agentId && !runId) return undefined; return (await this.load()).agents.find((a) => a.agentId === agentId || a.runId === runId);
  }
  async list(): Promise<AgentRecord[]> { return [...(await this.load()).agents]; }
  async managedTab(): Promise<ManagedTabRecord | null> { const tab = (await this.load()).managedTab; return tab ? { ...tab } : null; }
}
