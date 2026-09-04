export const REGISTRY_VERSION = 5 as const;
export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL = "pi-herdr-orchestrator" as const;

export type ProcessState =
  "starting" | "live" | "missing" | "closed" | "failed";
export type RunPhase =
  | "starting"
  | "running"
  | "cancel_requested"
  | "completed"
  | "cancelled"
  | "failed"
  | "unknown";
export type AgentTopology = "parent-split-v1" | "managed-subagents-tab-v2";
export type CompletionStatus = "completed" | "cancelled" | "failed";
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
  eventSequence: number;
  summary: string;
  createdAt: string;
}
export interface TerminalRecord {
  status: CompletionStatus;
  summary: string;
  completedAt: string;
  resultFile: string;
}
export interface RunRecord {
  runId: string;
  assignmentGeneration: number;
  phase: RunPhase;
  latestProgress: ProgressRecord | null;
  terminal: TerminalRecord | null;
  deliveredSequence: number;
  terminalDelivered: boolean;
  notifiedSequence: number;
  terminalNotified: boolean;
  cancelRequestedAt: string | null;
  assignmentState: "pending-prompt" | "delivered";
  pendingTask: string | null;
  legacyDeliveredEventIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface AgentRecord {
  domainId: string;
  agentId: string;
  runId: string;
  herdrAgentName: string;
  agentGeneration: number;
  assignmentGeneration: number;
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
  runs: RunRecord[];
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
  version: 2;
  sequence: number;
  kind: "progress" | "message";
  domainId: string;
  agentId: string;
  runId: string;
  agentGeneration: number;
  assignmentGeneration: number;
  target: "parent" | string;
  summary: string;
  createdAt: string;
  legacyEventId?: string;
}
export interface RunResult {
  version: 2;
  domainId: string;
  agentId: string;
  runId: string;
  agentGeneration: number;
  assignmentGeneration: number;
  status: CompletionStatus;
  summary: string;
  finalResult: string | null;
  completedAt: string;
}
export type OrchestrateAction =
  | "health"
  | "run"
  | "spawn"
  | "list"
  | "inspect"
  | "send"
  | "close"
  | "wait"
  | "collect"
  | "reuse"
  | "cancel"
  | "recover";
export interface OrchestrateParams {
  action: OrchestrateAction;
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
