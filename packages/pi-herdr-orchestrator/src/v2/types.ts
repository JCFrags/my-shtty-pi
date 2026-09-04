export const REGISTRY_VERSION = 3 as const;
export const CANARY_VERSION = 3 as const;
export const CANARY_PROTOCOL = "pi-herdr-orchestrate-v2-m03" as const;

export type ProcessState = "starting" | "live" | "missing" | "closed" | "failed";
export type RunPhase = "starting" | "running" | "completed" | "closed" | "failed" | "unknown";
export type AgentTopology = "parent-split-v1" | "managed-subagents-tab-v2";
export type CompletionStatus = "completed" | "failed";

export interface ParentIdentity {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface ManagedTabRecord {
  workspaceId: string;
  tabId: string;
  requestedLabel: string;
  createdAt: string;
  verifiedAt: string;
}

export interface ProgressRecord {
  eventId: string;
  summary: string;
  createdAt: string;
}

export interface TerminalRecord {
  status: CompletionStatus;
  summary: string;
  completedAt: string;
  resultFile: string;
}

export interface AgentRecord {
  domainId: string;
  agentId: string;
  runId: string;
  herdrAgentName: string;
  agentGeneration: 1;
  assignmentGeneration: 1;
  topology: AgentTopology;
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string;
  label: string;
  processState: ProcessState;
  runPhase: RunPhase;
  herdrAttention: string;
  latestProgress: ProgressRecord | null;
  terminal: TerminalRecord | null;
  deliveredEventIds: string[];
  terminalDelivered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Registry {
  version: typeof REGISTRY_VERSION;
  domainId: string;
  projectRoot: string;
  parent: ParentIdentity;
  managedTab: ManagedTabRecord | null;
  createdAt: string;
  updatedAt: string;
  agents: AgentRecord[];
}

export interface ChannelEvent {
  version: 1;
  eventId: string;
  kind: "progress" | "message";
  domainId: string;
  agentId: string;
  runId: string;
  agentGeneration: 1;
  assignmentGeneration: 1;
  target: "parent" | string;
  summary: string;
  createdAt: string;
}

export interface RunResult {
  version: 1;
  domainId: string;
  agentId: string;
  runId: string;
  agentGeneration: 1;
  assignmentGeneration: 1;
  status: CompletionStatus;
  summary: string;
  finalResult: string | null;
  completedAt: string;
}

export type OrchestrateV2Action =
  | "health" | "spawn" | "list" | "inspect" | "send" | "close" | "wait" | "collect";

export interface OrchestrateV2Params {
  action: OrchestrateV2Action;
  task?: string;
  label?: string;
  cwd?: string;
  agentId?: string;
  runId?: string;
  runIds?: string[];
  message?: string;
  lines?: number;
  timeoutMs?: number;
}

export type JsonObject = Record<string, unknown>;
