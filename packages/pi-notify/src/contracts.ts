/** Versioned wire contracts. Event data and resource notes never grant authority. */
export const SCHEMA_VERSION = 1 as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Versioned = { schemaVersion: 1 };
export type Trigger =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string; timeZone: string; startAt?: string }
  | { kind: "event"; source: string; types: string[]; subject?: string };

export interface ResourceNote extends Versioned {
  resourceId: string;
  kind: "service" | "job" | "destination" | "resource";
  purpose: string;
  owner: string;
  references: string[];
  repairContext: string;
}
export type NoteFields = Pick<ResourceNote, "purpose" | "owner" | "references" | "repairContext">;
export interface PiTask {
  name: string;
  purpose: string;
  targetId: string;
  trigger: Trigger;
  onWake: string;
  context: string[];
  authority: { allowedActions: string[]; limits: string[] };
  completionCriteria: string[];
  /** v1 stores the outcome on the delivery. It does not forward a second delivery. */
  resultDestination: { kind: "delivery-result" };
  validity: { expiresAt: string; stopConditions: string[] };
}
export interface DestinationInput extends Versioned {
  id: string;
  kind: "pull" | "pi";
  note: NoteFields;
}
export interface DestinationRecord extends DestinationInput {
  createdAt: string;
  binding: { ownerId: string; expiresAt: string } | null;
}
export interface EventInput extends Versioned {
  id: string;
  source: string;
  type: string;
  subject?: string;
  occurredAt: string;
  data: Json;
}
export interface EventRecord extends EventInput { acceptedAt: string }
export interface EventAcceptance extends Versioned {
  accepted: true;
  duplicate: boolean;
  event: EventRecord;
  deliveryIds: string[];
}
export interface RetryPolicy { maxAttempts: number; initialDelayMs: number; maxDelayMs: number }
export interface JobInput extends Versioned {
  id: string;
  destinationId: string;
  trigger: Trigger;
  note: NoteFields;
  piTask?: PiTask;
  expiresAt?: string;
  missedRun?: "skip" | "fire-once";
  graceMs?: number;
  retry?: RetryPolicy;
}
export interface JobRecord extends JobInput {
  state: "active" | "paused" | "cancelled" | "finished" | "expired";
  acceptedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  skippedRuns: number;
}
export interface JobAcceptance extends Versioned {
  accepted: true;
  duplicate: boolean;
  job: JobRecord;
  guidance: string;
}
export type DeliveryInput =
  | { kind: "event"; event: EventRecord }
  | { kind: "timer"; scheduledFor: string; observedAt: string; missed: boolean };
export interface DeliveryRecord extends Versioned {
  id: string;
  jobId: string;
  destinationId: string;
  state: "accepted" | "leased" | "delivered" | "completed" | "dead" | "cancelled" | "expired";
  input: DeliveryInput;
  piTask?: PiTask;
  acceptedAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  availableAt: string;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  result: Json | null;
  lastError: string | null;
}
export interface BindInput extends Versioned { ownerId: string; ttlMs?: number }
export interface BindingInput extends BindInput { bindingToken: string }
export interface Binding extends Versioned {
  destinationId: string;
  ownerId: string;
  bindingToken: string;
  expiresAt: string;
}
export interface ClaimInput extends BindingInput { waitMs?: number; leaseMs?: number }
export interface LeaseInput extends BindingInput { leaseToken: string; leaseMs?: number }
export interface ClaimedDelivery extends DeliveryRecord { leaseToken: string }
export interface ClaimResponse extends Versioned { delivery: ClaimedDelivery | null }
export interface AckInput extends LeaseInput {
  outcome: "delivered" | "completed" | "retry" | "failed";
  result?: Json;
  error?: string;
  retryAfterMs?: number;
}
export interface Page<T> extends Versioned { items: T[]; nextOffset: number | null }
export interface ListOptions { limit?: number; offset?: number; jobId?: string; destinationId?: string }
export interface HealthResponse extends Versioned {
  serviceId: string;
  instanceId: string;
  startedAt: string;
  status: "ready";
}
export interface ErrorResponse extends Versioned { error: { code: string; message: string } }

/** Protected service config. Raw bearer tokens are read from tokenFile, never saved to records. */
export interface PrincipalConfig {
  id: string;
  tokenFile: string;
  roles: ("admin" | "producer" | "consumer" | "scheduler" | "reader")[];
  sourceIds?: string[];
  destinationIds?: string[];
}
export interface ServiceConfig extends Versioned {
  serviceId: string;
  database: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  /** Optional local container ingress. Decimal 384 = 0600, 432 = 0660. */
  unixSocket?: { path: string; mode?: 384 | 432; groupId?: number };
  principals: PrincipalConfig[];
  note: NoteFields;
}
export const ACCEPTANCE_GUIDANCE = "Accepted durably. Do not poll, sleep, or wait. End this turn; the receiver will wake the destination later.";
