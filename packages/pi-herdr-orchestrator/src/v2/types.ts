export const REGISTRY_VERSION = 1 as const;
export const CANARY_VERSION = 1 as const;
export const CANARY_PROTOCOL = "pi-herdr-orchestrate-v2-m01" as const;

export type ProcessState = "starting" | "live" | "missing" | "closed" | "failed";
export type RunPhase = "starting" | "running" | "closed" | "failed" | "unknown";

export interface ParentIdentity {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface AgentRecord {
  domainId: string;
  agentId: string;
  runId: string;
  herdrAgentName: string;
  agentGeneration: 1;
  assignmentGeneration: 1;
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string;
  label: string;
  processState: ProcessState;
  runPhase: RunPhase;
  herdrAttention: string;
  createdAt: string;
  updatedAt: string;
}

export interface Registry {
  version: typeof REGISTRY_VERSION;
  domainId: string;
  projectRoot: string;
  parent: ParentIdentity;
  createdAt: string;
  updatedAt: string;
  agents: AgentRecord[];
}

export type OrchestrateV2Action = "health" | "spawn" | "list" | "inspect" | "send" | "close";

export interface OrchestrateV2Params {
  action: OrchestrateV2Action;
  task?: string;
  label?: string;
  cwd?: string;
  agentId?: string;
  runId?: string;
  message?: string;
  lines?: number;
}

export type JsonObject = Record<string, unknown>;
