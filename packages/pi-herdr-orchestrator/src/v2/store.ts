import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  REGISTRY_VERSION,
  type AgentRecord,
  type JsonObject,
  type ParentIdentity,
  type ProcessState,
  type Registry,
  type RunPhase,
} from "./types.js";

const MAX_STRING = 4096;
const PROCESS_STATES: readonly ProcessState[] = ["starting", "live", "missing", "closed", "failed"];
const RUN_PHASES: readonly RunPhase[] = ["starting", "running", "closed", "failed", "unknown"];

export class RegistryError extends Error {
  readonly code: "REGISTRY_MALFORMED" | "REGISTRY_AGENT_MISSING";

  constructor(code: "REGISTRY_MALFORMED" | "REGISTRY_AGENT_MISSING") {
    super(code);
    this.name = "RegistryError";
    this.code = code;
  }
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringField(value: JsonObject, key: string, max = MAX_STRING): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.length > 0 && Buffer.byteLength(item, "utf8") <= max
    ? item
    : undefined;
}

function parentValid(value: unknown): value is ParentIdentity {
  const item = record(value);
  return (
    item !== undefined &&
    stringField(item, "workspaceId", 128) !== undefined &&
    stringField(item, "tabId", 128) !== undefined &&
    stringField(item, "paneId", 128) !== undefined
  );
}

function agentValid(value: unknown, domainId: string): value is AgentRecord {
  const item = record(value);
  if (!item || item.domainId !== domainId) return false;
  if (
    !stringField(item, "agentId", 128) ||
    !stringField(item, "runId", 128) ||
    !stringField(item, "herdrAgentName", 32) ||
    !stringField(item, "workspaceId", 128) ||
    !stringField(item, "tabId", 128) ||
    !stringField(item, "paneId", 128) ||
    !stringField(item, "cwd") ||
    !stringField(item, "label", 160) ||
    !stringField(item, "herdrAttention", 64) ||
    !stringField(item, "createdAt", 64) ||
    !stringField(item, "updatedAt", 64)
  )
    return false;
  return (
    item.agentGeneration === 1 &&
    item.assignmentGeneration === 1 &&
    typeof item.processState === "string" &&
    PROCESS_STATES.includes(item.processState as ProcessState) &&
    typeof item.runPhase === "string" &&
    RUN_PHASES.includes(item.runPhase as RunPhase)
  );
}

function validateRegistry(value: unknown, domainId: string): Registry {
  const item = record(value);
  if (
    !item ||
    item.version !== REGISTRY_VERSION ||
    item.domainId !== domainId ||
    !stringField(item, "projectRoot") ||
    !parentValid(item.parent) ||
    !stringField(item, "createdAt", 64) ||
    !stringField(item, "updatedAt", 64) ||
    !Array.isArray(item.agents) ||
    !item.agents.every((agent) => agentValid(agent, domainId))
  )
    throw new RegistryError("REGISTRY_MALFORMED");
  return item as unknown as Registry;
}

function stateBase(): string {
  const configured = process.env.XDG_STATE_HOME;
  return resolve(
    configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "state"),
    "pi-herdr-orchestrator-v2",
  );
}

export function domainIdFor(projectRoot: string, parent: ParentIdentity): string {
  const input = [resolve(projectRoot), parent.workspaceId, parent.tabId, parent.paneId].join("\0");
  return `d-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

export class RegistryStore {
  readonly domainId: string;
  readonly path: string;
  private readonly projectRoot: string;
  private readonly parent: ParentIdentity;
  private loaded: Registry | undefined;

  constructor(projectRoot: string, parent: ParentIdentity) {
    this.projectRoot = resolve(projectRoot);
    this.parent = { ...parent };
    this.domainId = domainIdFor(this.projectRoot, this.parent);
    this.path = join(stateBase(), `${this.domainId}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
  }

  async load(): Promise<Registry> {
    if (this.loaded) return this.loaded;
    await this.ensureDirectory();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch (cause: unknown) {
      if ((cause as { code?: string }).code !== "ENOENT") throw new RegistryError("REGISTRY_MALFORMED");
      const now = new Date().toISOString();
      this.loaded = {
        version: REGISTRY_VERSION,
        domainId: this.domainId,
        projectRoot: this.projectRoot,
        parent: { ...this.parent },
        createdAt: now,
        updatedAt: now,
        agents: [],
      };
      return this.loaded;
    }
    this.loaded = validateRegistry(parsed, this.domainId);
    return this.loaded;
  }

  private async save(next: Registry): Promise<void> {
    validateRegistry(next, this.domainId);
    await this.ensureDirectory();
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    try {
      await rename(temporary, this.path);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
    this.loaded = next;
  }

  async addAgent(agent: AgentRecord): Promise<void> {
    const current = await this.load();
    if (current.agents.some((item) => item.agentId === agent.agentId || item.runId === agent.runId))
      throw new RegistryError("REGISTRY_MALFORMED");
    await this.save({
      ...current,
      updatedAt: new Date().toISOString(),
      agents: [...current.agents, agent],
    });
  }

  async updateAgent(agentId: string, patch: Partial<AgentRecord>): Promise<AgentRecord> {
    const current = await this.load();
    const index = current.agents.findIndex((item) => item.agentId === agentId);
    if (index < 0) throw new RegistryError("REGISTRY_AGENT_MISSING");
    const updated = { ...current.agents[index], ...patch, updatedAt: new Date().toISOString() } as AgentRecord;
    const agents = [...current.agents];
    agents[index] = updated;
    await this.save({ ...current, updatedAt: new Date().toISOString(), agents });
    return updated;
  }

  async getAgent(agentId?: string, runId?: string): Promise<AgentRecord | undefined> {
    if (!agentId && !runId) return undefined;
    const current = await this.load();
    return current.agents.find((item) => item.agentId === agentId || item.runId === runId);
  }

  async list(): Promise<AgentRecord[]> {
    return [...(await this.load()).agents];
  }
}
