import {
  BranchStateOwner, type CommitOptions, type ObjectRef, type OwnedSnapshot, type OwnerResolution, type StateAnchorHost,
} from "@context-kit/state-store";
import {
  createWorkplanContextRecord, projectWorkplanPage, type WorkplanContextRecord,
} from "@grounded/pi-core/context-adapters";
import type { ContextRequest, ProviderPage } from "@context-kit/protocol";
import {
  renderWorkplanMutation, renderWorkplanStatus, validateWorkplan, validateWorkplanState,
  type Workplan, type WorkplanEvent, type WorkplanInput, type WorkplanOperation, type WorkplanState,
} from "@grounded/pi-core/workplan";
import { buildWorkplanActivity, buildWorkplanSummary, type WorkplanActivityV1 } from "@grounded/pi-core/workplan-summary";
import { cancelled, requireExactObject, StateToolError } from "@grounded/pi-core/state";
import { STATE_CHECKPOINT_ENTRY, STATE_CHECKPOINT_MAX_BYTES } from "@grounded/pi-core/state-transfer";
import { admitWorkplanJson, boundedText, PLAN_BYTES, PLAN_OBJECT_BYTES, planBoundary, PROJECTION_BYTES, ROOT_BYTES } from "./admission.ts";
import { isLegacyWorkplanEntry } from "./legacy.ts";
import {
  emptyWorkplanRoot, metadataFor, reduceTarget, renderMetadataList, validateWorkplanRoot,
  type PlanMetadata, type WorkplanRoot,
} from "./model.ts";

export interface WorkplanProjection {
  version: 1;
  planId: string;
  revision: number;
  context: WorkplanContextRecord;
  statusText: string;
  statusOmitted: boolean;
}
export interface WorkplanOwnerMetadata {
  version: 1;
  providerId: "workplan";
  commitId: string;
  parentCommitId: string | null;
  rootRef: ObjectRef;
  anchorId: string;
  origin: { sessionId: string; leafId: string | null };
  durability: "disk" | "ephemeral" | "deferred";
  importReceipt?: ObjectRef;
}
export interface WorkplanCapture { state: WorkplanState; owner?: WorkplanOwnerMetadata }
export interface WorkplanExecution {
  text: string;
  result: unknown;
  event?: WorkplanEvent;
  eventRef?: ObjectRef;
  activity?: WorkplanActivityV1;
  recovery?: { planId: string; revision: number };
  owner?: WorkplanOwnerMetadata;
  metadataOmissions?: string[];
}

const sameView = (left: { sessionId: string; leafId: string | null }, host: StateAnchorHost) =>
  left.sessionId === host.sessionManager.getSessionId() && left.leafId === host.sessionManager.getLeafId();
const scopeOf = (host: StateAnchorHost) => ({ sessionId: host.sessionManager.getSessionId(), leafId: host.sessionManager.getLeafId() });

export function validateNativePlan(plan: Workplan): void {
  admitWorkplanJson(plan, PLAN_BYTES);
  validateWorkplan(plan);
}
export function validateProjection(value: WorkplanProjection): void {
  admitWorkplanJson(value, PROJECTION_BYTES, 10_000);
  requireExactObject(value, ["version", "planId", "revision", "context", "statusText", "statusOmitted"], [], "workplan projection", "STATE_CORRUPT");
  if (value.version !== 1 || typeof value.planId !== "string" || !/^WP[1-9][0-9]*$/u.test(value.planId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.statusText !== "string" || typeof value.statusOmitted !== "boolean" || !value.context || typeof value.context !== "object") throw new StateToolError("STATE_CORRUPT", "Workplan projection is invalid");
}
export function ownerMetadata(snapshot: OwnedSnapshot<WorkplanRoot>): WorkplanOwnerMetadata {
  return {
    version: 1, providerId: "workplan", commitId: snapshot.commitId, parentCommitId: snapshot.parentCommitId,
    rootRef: snapshot.rootRef, anchorId: snapshot.anchorId, origin: snapshot.origin, durability: snapshot.durability,
    ...(snapshot.importReceipt ? { importReceipt: snapshot.importReceipt } : {}),
  };
}

/** One independent owner. Only complete transfer reads all native plan objects. */
export class WorkplanStore {
  readonly owner: BranchStateOwner<WorkplanRoot>;
  private resolution?: OwnerResolution<WorkplanRoot>;
  private projectionCache = new Map<string, WorkplanProjection>();
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private pendingCount = 0;
  private failure = false;

  constructor(options: { storeRoot?: string; ancestryPageEntries?: number } = {}) {
    this.owner = new BranchStateOwner<WorkplanRoot>({
      providerId: "workplan", ...options, rootMaxBytes: ROOT_BYTES, objectMaxBytes: PLAN_BYTES + 1024 * 1024,
      validateRoot: validateWorkplanRoot, isLegacyEntry: isLegacyWorkplanEntry,
    });
  }

  get root(): WorkplanRoot | undefined {
    return this.resolution?.status === "ready" ? this.resolution.snapshot.root as WorkplanRoot
      : this.resolution?.status === "empty" ? emptyWorkplanRoot() : undefined;
  }
  get snapshot(): OwnedSnapshot<WorkplanRoot> | undefined { return this.resolution?.status === "ready" ? this.resolution.snapshot : undefined; }
  get pending(): boolean { return this.pendingCount > 0 || !this.resolution || this.resolution.status === "pending" || this.resolution.status === "legacy" || this.owner.status().state === "uncertain"; }
  get corrupt(): boolean { return this.failure; }
  get resolutionStatus(): string { return this.failure ? "corrupt" : this.resolution?.status ?? "unresolved"; }

  invalidate(): void {
    this.epoch++; this.owner.invalidate(); this.resolution = undefined; this.failure = false; this.projectionCache.clear();
  }
  close(): void { this.invalidate(); this.owner.close(); }

  async resolve(host: StateAnchorHost, signal?: AbortSignal): Promise<OwnerResolution<WorkplanRoot>> {
    const epoch = this.epoch;
    try {
      const resolution = await this.owner.resolve(host, { signal });
      if (epoch !== this.epoch) throw new StateToolError("STATE_CONFLICT", "Workplan branch changed during resolution");
      this.resolution = resolution; this.failure = false;
      return resolution;
    } catch (error) {
      if (epoch === this.epoch && !signal?.aborted) this.failure = true;
      throw error;
    }
  }

  /** Serialize all native mutations and import-finalization routes for this owner. */
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    this.pendingCount++;
    await prior;
    try { return await operation(); }
    finally { this.pendingCount--; release(); }
  }

  async requireRoot(host: StateAnchorHost, signal?: AbortSignal): Promise<WorkplanRoot> {
    const result = await this.resolve(host, signal);
    if (result.status === "pending") throw new StateToolError("STATE_CONFLICT", "Workplan ancestry resolution is pending. Retry to advance one bounded page");
    if (result.status === "legacy") throw new StateToolError("STATE_CONFLICT", "Workplan legacy state needs bounded import. Run /workplan-import before native operations");
    return result.status === "ready" ? result.snapshot.root as WorkplanRoot : emptyWorkplanRoot();
  }

  async readSelected(root: WorkplanRoot, planId: string, signal?: AbortSignal): Promise<Workplan> {
    const metadata = root.plans.find((item) => item.id === planId);
    if (!metadata) throw new StateToolError("STATE_NOT_FOUND", `Workplan ${planId} does not exist on the current branch`);
    const plan = await this.owner.objects.read<Workplan>(metadata.plan, { maxBytes: PLAN_OBJECT_BYTES, validate: validateNativePlan, signal });
    if (plan.id !== metadata.id || plan.revision !== metadata.revision || plan.status !== metadata.status) throw new StateToolError("STATE_CORRUPT", "Workplan object disagrees with its manifest");
    return plan;
  }

  /** Stage one plan and its bounded derived fields. This does not select a root. */
  async stagePlan(root: WorkplanRoot, plan: Workplan, counters: Pick<WorkplanRoot, "nextPlanNumber" | "stateRevision">, signal?: AbortSignal): Promise<WorkplanRoot> {
    await planBoundary(signal);
    const planRef = await this.owner.objects.publish(plan, { maxBytes: PLAN_OBJECT_BYTES, validate: validateNativePlan, signal });
    await planBoundary(signal);
    const status = boundedText(renderWorkplanStatus(plan), 32 * 1024);
    const projection: WorkplanProjection = {
      version: 1, planId: plan.id, revision: plan.revision, context: createWorkplanContextRecord(plan),
      statusText: status.text, statusOmitted: status.omitted,
    };
    const projectionRef = await this.owner.objects.publish(projection, { maxBytes: PROJECTION_BYTES, validate: validateProjection, signal });
    const plans = root.plans.slice();
    const index = plans.findIndex((item) => item.id === plan.id);
    const metadata = metadataFor(plan, planRef, projectionRef);
    if (index < 0) plans.push(metadata); else plans[index] = metadata;
    const nativeCounters = { nextPlanNumber: counters.nextPlanNumber, stateRevision: counters.stateRevision };
    const summary = plan.status === "active" ? buildWorkplanSummary({ plans: [plan], ...nativeCounters })
      : root.summary.activePlan?.id === plan.id ? { version: 1 as const } : root.summary;
    const next: WorkplanRoot = { version: 1, kind: "workplan-root", ...nativeCounters, plans, summary };
    validateWorkplanRoot(next);
    return next;
  }

  async stageNativeState(state: WorkplanState, signal?: AbortSignal): Promise<WorkplanRoot> {
    // Complete imports/transfer are explicitly capped before whole-state validation.
    admitWorkplanJson(state, STATE_CHECKPOINT_MAX_BYTES, 200_000);
    validateWorkplanState(state);
    let root = emptyWorkplanRoot();
    for (const plan of state.plans) root = await this.stagePlan(root, plan, state, signal);
    root = { ...root, nextPlanNumber: state.nextPlanNumber, stateRevision: state.stateRevision };
    validateWorkplanRoot(root);
    return root;
  }

  async commitRoot(host: StateAnchorHost, root: WorkplanRoot, options: CommitOptions): Promise<OwnedSnapshot<WorkplanRoot>> {
    const epoch = this.epoch;
    const snapshot = await this.owner.commit(host, root, options);
    if (epoch !== this.epoch) throw new StateToolError("STATE_CONFLICT", "Workplan branch changed during commit");
    this.resolution = { status: "ready", snapshot, coverage: { scanned: 0, complete: true, legacySeen: false } };
    this.failure = false;
    return snapshot;
  }

  async projection(metadata: PlanMetadata, signal?: AbortSignal): Promise<WorkplanProjection> {
    const key = `${metadata.projection.storeId}:${metadata.projection.hash}`;
    const cached = this.projectionCache.get(key);
    if (cached) { this.projectionCache.delete(key); this.projectionCache.set(key, cached); return cached; }
    const projection = await this.owner.objects.read<WorkplanProjection>(metadata.projection, { maxBytes: PROJECTION_BYTES, validate: validateProjection, signal });
    if (projection.planId !== metadata.id || projection.revision !== metadata.revision) throw new StateToolError("STATE_CORRUPT", "Workplan projection disagrees with its manifest");
    this.projectionCache.set(key, projection);
    if (this.projectionCache.size > 128) this.projectionCache.delete(this.projectionCache.keys().next().value!);
    return projection;
  }

  async contextPage(host: StateAnchorHost, request: ContextRequest, signal?: AbortSignal): Promise<ProviderPage> {
    const refusal = (readiness: ProviderPage["readiness"]): ProviderPage => ({ readiness, cards: [], coverage: { scanned: 0, matched: 0, excluded: 0, scanComplete: false } });
    if (!sameView(request.scope, host)) return refusal("scope_changed");
    if (this.pendingCount) return refusal("pending");
    return this.exclusive(async () => {
      const epoch = this.epoch;
      try {
        const resolved = await this.resolve(host, signal);
        if (resolved.status === "pending" || resolved.status === "legacy") return refusal("pending");
        const root = resolved.status === "ready" ? resolved.snapshot.root as WorkplanRoot : emptyWorkplanRoot();
        const count = Math.min(root.plans.length, request.limits.scan, 128);
        const records: WorkplanContextRecord[] = [];
        for (let index = 0; index < count; index++) records.push((await this.projection(root.plans[index]!, signal)).context);
        if (epoch !== this.epoch || !sameView(request.scope, host)) return refusal("scope_changed");
        if (this.pendingCount > 1) return refusal("pending");
        const page = projectWorkplanPage(request, records);
        if (count < root.plans.length) page.coverage.scanComplete = false;
        return page;
      } catch {
        return refusal(signal?.aborted ? "pending" : "corrupt");
      }
    });
  }

  async execute(host: StateAnchorHost, input: WorkplanInput, signal?: AbortSignal): Promise<WorkplanExecution> {
    // Admission precedes native reducer validation and selected object loading.
    admitWorkplanJson(input);
    return this.exclusive(async () => {
      const epoch = this.epoch;
      const root = await this.requireRoot(host, signal), source = scopeOf(host);
      const expectedCommitId = this.snapshot?.commitId ?? null;
      let operation: WorkplanOperation;
      if (input.action === "list") {
        requireExactObject(input, ["action"], [], "list input");
        return { text: renderMetadataList(root), result: root.plans.map(({ id, title, status, revision, updatedAt }) => ({ id, title, status, revision, updatedAt })), metadataOmissions: root.plans.filter((item) => item.omittedFields.length).map((item) => item.id) };
      }
      if (input.action !== "create" && (typeof input.planId !== "string" || !/^WP[1-9][0-9]*$/u.test(input.planId))) throw new StateToolError("STATE_INVALID_INPUT", "planId must be a workplan ID");
      if (input.action === "status") {
        requireExactObject(input, ["action", "planId"], [], "status input");
        const metadata = root.plans.find((item) => item.id === input.planId);
        if (!metadata) throw new StateToolError("STATE_NOT_FOUND", `Workplan ${input.planId} does not exist on the current branch`);
        const projected = await this.projection(metadata, signal);
        if (epoch !== this.epoch || !sameView(source, host)) throw new StateToolError("STATE_CONFLICT", "Workplan branch changed during status");
        return { text: projected.statusText + (projected.statusOmitted ? `\n[Status cache omits complete fields; use workplan read for ${metadata.id}]\n` : ""), result: metadata.statusMetadata };
      }
      const plan = input.action === "create" ? undefined : await this.readSelected(root, input.planId ?? "", signal);
      await planBoundary(signal);
      operation = reduceTarget(root, plan, input);
      await planBoundary(signal);
      if (epoch !== this.epoch || !sameView(source, host)) throw new StateToolError("STATE_CONFLICT", "Workplan branch changed during the operation");
      if (!operation.event) {
        return { text: String(operation.result), result: undefined,
          ...(input.action === "recover" && plan ? { recovery: { planId: plan.id, revision: plan.revision } } : {}),
          ...(this.snapshot ? { owner: ownerMetadata(this.snapshot) } : {}),
        };
      }
      const event = operation.event;
      const nextPlan = operation.state.plans.find((item) => item.id === (event.action === "create" ? (event.data.plan as Workplan).id : event.data.planId))!;
      const next = await this.stagePlan(root, nextPlan, operation.state, signal);
      // Keep exact native events off the Pi transcript when they exceed the result budget.
      const eventBytes = admitWorkplanJson(event, PLAN_BYTES + 1024 * 1024);
      const eventRef = await this.owner.objects.publish(event, { maxBytes: PLAN_BYTES + 1024 * 1024, signal });
      next.event = eventRef;
      const text = renderWorkplanMutation(operation.state, event);
      const activity = buildWorkplanActivity(event, operation.state);
      cancelled(signal);
      const snapshot = await this.commitRoot(host, next, { expectedCommitId, signal });
      return { text, result: operation.result, eventRef, ...(eventBytes <= 32 * 1024 ? { event } : {}),
        ...(activity ? { activity } : {}), owner: ownerMetadata(snapshot) };
    });
  }

  /** Complete native V1-compatible capture, never cards or a shortened root.
   * Owner metadata is separate from native revision history. The caller includes
   * it in its versioned transfer envelope, not inside the V1 native state.
   */
  async capture(host: StateAnchorHost, maxBytes = STATE_CHECKPOINT_MAX_BYTES, signal?: AbortSignal): Promise<WorkplanCapture> {
    if (this.pendingCount || this.owner.status().state === "uncertain") throw new StateToolError("STATE_CONFLICT", "Workplan capture is pending");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STATE_CHECKPOINT_MAX_BYTES) throw new StateToolError("STATE_LIMIT_EXCEEDED", "Workplan complete capture exceeds the transfer limit");
    return this.exclusive(async () => {
      const epoch = this.epoch, root = await this.requireRoot(host, signal), source = scopeOf(host), snapshot = this.snapshot;
      if (snapshot && snapshot.durability !== "disk") throw new StateToolError("STATE_CONFLICT", "Workplan has no durable Pi binding");
      // Refuse before loading even one body if the complete admitted size cannot fit.
      const overhead = Buffer.byteLength(JSON.stringify({ customType: STATE_CHECKPOINT_ENTRY, data: {
        version: 1, provider: "workplan", sourceSessionId: source.sessionId, sourceLeafId: source.leafId,
        state: { plans: [], nextPlanNumber: root.nextPlanNumber, stateRevision: root.stateRevision },
      } }), "utf8");
      if (root.plans.reduce((sum, plan) => sum + plan.canonicalBytes + 1, overhead) > maxBytes) throw new StateToolError("STATE_LIMIT_EXCEEDED", "Complete Workplan state does not fit the checkpoint budget");
      const plans: Workplan[] = [];
      for (const item of root.plans) { await planBoundary(signal); plans.push(await this.readSelected(root, item.id, signal)); }
      const state = { plans, nextPlanNumber: root.nextPlanNumber, stateRevision: root.stateRevision };
      admitWorkplanJson({ customType: STATE_CHECKPOINT_ENTRY, data: { version: 1, provider: "workplan", sourceSessionId: source.sessionId, sourceLeafId: source.leafId, state } }, maxBytes, 200_000);
      validateWorkplanState(state);
      if (epoch !== this.epoch || this.pendingCount > 1 || !sameView(source, host) || this.snapshot?.commitId !== snapshot?.commitId) throw new StateToolError("STATE_CONFLICT", "Workplan source changed during capture");
      return { state, ...(snapshot ? { owner: ownerMetadata(snapshot) } : {}) };
    });
  }
}
