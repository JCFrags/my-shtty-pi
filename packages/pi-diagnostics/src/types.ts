export const TOPICS = ["runtime", "session", "telemetry", "tools", "components", "resources", "state"] as const;
export type Topic = typeof TOPICS[number];
export type View = "summary" | "detailed";
export type Basis = "reported" | "estimated" | "component-attested" | "unknown";
export type Availability = "available" | "partial" | "unavailable";
export type Value = string | number | boolean | null;
export interface Field {
  id: string;
  value: Value;
  unit: string;
  basis: Basis;
  note?: string;
}
export interface Evidence {
  provider: string;
  observedAt: string;
  source: string;
  scope: string;
  availability: Availability;
  errorCode?: string;
  fields: Field[];
  limits: string[];
}
export interface Finding {
  checkId: string;
  outcome: "pass" | "warn" | "fail" | "unknown" | "skipped";
  severity: "info" | "warning" | "error";
  explanation: string;
  evidence: string[];
  nextInspection: string;
}
export interface Check {
  id: string;
  purpose: string;
  topics: Topic[];
  evidenceNeeds: string[];
  limits: string;
}
export interface Report {
  schemaVersion: 1;
  kind: "report" | "checks";
  reportId: string;
  startedAt: string;
  endedAt: string;
  scope: "current Pi process/session";
  requestedTopics: Topic[];
  requestedChecks: string[];
  providers: Evidence[];
  findings: Finding[];
  checks: Check[];
  complete: boolean;
  page: { offset: number; limit: number; total: number; nextOffset: number | null; truncated: boolean };
  limits: string[];
}
export interface Request {
  topics: Topic[];
  checkIds?: string[];
  view?: View;
  offset?: number;
  limit?: number;
}

// Optional owners answer only explicit requests. This is not a registry or a state store.
export const PROVIDER_EVENT = "pi-diagnostics:provider:v1";
export type ProviderId = "telemetry" | "progressive-tools" | "reload";
export interface ProviderRequest {
  protocolVersion: 1;
  provider: ProviderId;
  signal: AbortSignal;
  deadline: number;
  respond: (reply: unknown) => void;
}
export interface ProviderReply {
  protocolVersion: 1;
  provider: ProviderId;
  observedAt: string;
  status: unknown;
}
