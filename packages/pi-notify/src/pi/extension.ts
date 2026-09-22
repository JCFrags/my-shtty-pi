import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NotifyClient, NotifyError } from "../client.ts";
import { ACCEPTANCE_GUIDANCE, type JobRecord } from "../contracts.ts";
import { validateJob, validateNote } from "../core/validation.ts";
import { NOTIFY_READY, NOTIFY_SUBSCRIBE, type NotificationDelivery, type NotificationSubscriptionRequest } from "./bus.ts";
import { DeliveryJournal } from "./delivery.ts";
import { fail, object, readPrivate, syncSessionAnchor } from "./files.ts";
import { BINDING_ENTRY, IdentityRegistry, newBinding, readChronoIdentity, type SavedBinding, type SessionView } from "./identity.ts";
import { Receiver, safeCode } from "./receiver.ts";
import { completeSchema, notifySchema, type NotifyToolInput } from "./schemas.ts";

type BusReceiverState = { request: NotificationSubscriptionRequest; receiver?: Receiver; closed: boolean; starting: boolean };

export interface PiNotifyConfig {
  schemaVersion: 1;
  baseUrl: string;
  tokenFile: string;
  stateDirectory?: string;
  chronoRoot?: string;
}
function loadConfig(): PiNotifyConfig | undefined {
  const path = process.env.PI_NOTIFY_PI_CONFIG ?? join(getAgentDir(), "pi-notify.json");
  let value: unknown;
  try { value = JSON.parse(readPrivate(path, 16 * 1024)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!object(value) || value.schemaVersion !== 1 || typeof value.baseUrl !== "string" || typeof value.tokenFile !== "string"
    || !isAbsolute(value.tokenFile) || Object.keys(value).some(key => !["schemaVersion", "baseUrl", "tokenFile", "stateDirectory", "chronoRoot"].includes(key))
    || (value.stateDirectory !== undefined && (typeof value.stateDirectory !== "string" || !isAbsolute(value.stateDirectory)))
    || (value.chronoRoot !== undefined && (typeof value.chronoRoot !== "string" || !isAbsolute(value.chronoRoot)))) fail("notify_config_invalid");
  return value as unknown as PiNotifyConfig;
}
function sessionView(ctx: ExtensionContext): SessionView {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) fail("notify_saved_context_required");
  return { sessionId: ctx.sessionManager.getSessionId(), sessionFile, leafId: ctx.sessionManager.getLeafId(),
    entries: ctx.sessionManager.getBranch() as unknown as Record<string, unknown>[] };
}
function result(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > 48 * 1024) fail("notify_output_too_large_use_smaller_page");
  return { content: [{ type: "text" as const, text }], details: value };
}

/** Factory registers handlers only. Config, token, sockets, and stores remain
 * untouched until session_start. All session resources close at shutdown. */
export default function piNotify(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let client: NotifyClient | undefined;
  let registry: IdentityRegistry | undefined;
  let journal: DeliveryJournal | undefined;
  let chronoRoot = "";
  let saved: SavedBinding | undefined;
  let receiver: Receiver | undefined;
  let pending: NotificationDelivery | undefined;
  let wakeIssued = false;
  let draining = false;
  let stopped = false;
  let starting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | undefined;
  const subscriptions = new Map<string, BusReceiverState>();

  const report = (code: string): void => {
    lastError = code;
    if (ctx?.hasUI) ctx.ui.setStatus("pi-notify", `Pi-Notify: ${code}`);
  };
  const liveContext = (): boolean => {
    try {
      if (!ctx || !saved || stopped || !registry) return false;
      const authoritative = registry.get(saved.destinationId);
      if (!authoritative || authoritative.bindingId !== saved.bindingId || authoritative.suspended
        || authoritative.sessionId !== saved.sessionId || authoritative.sessionFile !== saved.sessionFile) return false;
      const view = sessionView(ctx);
      return registry.matches(authoritative, view, readChronoIdentity(view, chronoRoot));
    } catch { return false; }
  };
  const status = () => ({ schemaVersion: 1, configured: !!client, destinationId: saved?.destinationId ?? null,
    state: stopped ? "stopped" : receiver?.binding && !receiver.abort.signal.aborted ? "live" : saved ? "offline" : "unregistered",
    pendingDeliveryId: pending?.delivery.id ?? null, lastError: lastError ?? null,
    coldResume: "unsupported; deliveries remain queued until the exact saved context has a live owner" });
  const requireClient = (): NotifyClient => client ?? fail("notify_not_configured");
  const requireTarget = (): SavedBinding => {
    if (!saved || !liveContext()) fail("notify_explicit_binding_required");
    return saved;
  };
  const requireOwnership = (): Receiver => {
    const owner = receiver;
    requireTarget();
    if (!owner?.binding || owner.abort.signal.aborted || Date.parse(owner.binding.expiresAt) <= Date.now()) fail("notify_binding_not_live");
    return owner;
  };

  const drain = async (): Promise<void> => {
    if (draining || wakeIssued || !pending || !ctx || !journal || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    draining = true;
    const handle = pending;
    const deliveringOwner = receiver;
    try {
      const owner = requireOwnership();
      if (owner.current?.id !== handle.delivery.id) fail("notify_delivery_not_owned");
      if (await journal.replayOutcome(handle, ctx)) { pending = undefined; return; }
      const deadline = handle.delivery.piTask?.validity.expiresAt;
      if (deadline && Date.parse(deadline) <= Date.now()) { await handle.fail("notify_task_expired"); pending = undefined; return; }
      journal.insert(pi, ctx, handle.delivery);
      await handle.acknowledge();
      // A session replacement or lease loss can happen while the ack is in flight.
      requireOwnership();
      if (pending !== handle || owner.current?.id !== handle.delivery.id) fail("notify_delivery_not_owned");
      wakeIssued = true;
      journal.wake(pi, handle.delivery);
    } catch (error) {
      report(safeCode(error));
      // Keep receipt uncertainty for replay. Never translate it into completion.
      if (receiver === deliveringOwner) {
        pending = undefined;
        if (deliveringOwner) await deliveringOwner.close();
        reconnect();
      }
    } finally {
      draining = false;
      if (pending && pending !== handle) void drain();
    }
  };
  const updateResumeAnchor = (): void => {
    if (!saved || !ctx || !registry || !liveContext()) return;
    const view = sessionView(ctx);
    if (view.leafId) { saved = { ...saved, resumeAnchorId: view.leafId }; registry.save(saved); }
  };
  const connect = async (): Promise<void> => {
    if (starting || stopped || !ctx || !client || !saved || !liveContext()) return;
    if (receiver?.binding && !receiver.abort.signal.aborted) return;
    starting = true;
    pending = undefined; wakeIssued = false;
    try {
      const owner = new Receiver(client, saved.destinationId, async handle => {
        if (!liveContext()) fail("notify_context_changed");
        pending = handle; wakeIssued = false;
        await drain();
      }, code => { report(code); reconnect(); }, liveContext);
      receiver = owner;
      await owner.start();
      lastError = undefined;
      if (ctx.hasUI) ctx.ui.setStatus("pi-notify", `Pi-Notify: ${saved.destinationId}`);
    } catch (error) { report(safeCode(error)); reconnect(); }
    finally { starting = false; }
  };
  const reconnect = (): void => {
    if (stopped || reconnectTimer || (!saved && subscriptions.size === 0)) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
      for (const subscription of subscriptions.values()) void activateSubscription(subscription).catch(error => { report(safeCode(error)); reconnect(); });
    }, 5_000);
    reconnectTimer.unref?.();
  };
  const activateSubscription = async (subscription: BusReceiverState): Promise<void> => {
    if (!client || stopped || subscription.closed || subscription.starting
      || (subscription.receiver?.binding && !subscription.receiver.abort.signal.aborted)) return;
    subscription.starting = true;
    try {
      const destination = await client.getDestination(subscription.request.destinationId);
      if (destination.kind !== "pull") fail("notify_bus_requires_pull_destination");
      const owner = new Receiver(client, destination.id, subscription.request.handle,
        code => { report(code); reconnect(); }, () => !stopped && !subscription.closed);
      subscription.receiver = owner;
      await owner.start();
      pi.events.emit(NOTIFY_READY, { schemaVersion: 1, consumerId: subscription.request.consumerId, destinationId: destination.id, state: "live" });
    } finally { subscription.starting = false; }
  };
  const unsubscribe = pi.events.on(NOTIFY_SUBSCRIBE, (value: unknown) => {
    if (!object(value) || value.schemaVersion !== 1 || typeof value.consumerId !== "string" || typeof value.destinationId !== "string"
      || typeof value.handle !== "function" || typeof value.accept !== "function") return;
    const request = value as unknown as NotificationSubscriptionRequest;
    if (stopped || subscriptions.has(request.consumerId) || [...subscriptions.values()].some(item => !item.closed && item.request.destinationId === request.destinationId)) {
      request.accept({ ok: false, error: "notify_subscription_conflict" }); return;
    }
    const subscription: BusReceiverState = { request, closed: false, starting: false };
    subscriptions.set(request.consumerId, subscription);
    // Registration is immediate to avoid deadlock between ordered session_start
    // handlers. Readiness is emitted separately after service admission.
    request.accept({ ok: true, subscription: { consumerId: request.consumerId, destinationId: request.destinationId,
      close: async () => { subscription.closed = true; subscriptions.delete(request.consumerId); await subscription.receiver?.close(); } } });
    if (ctx) void activateSubscription(subscription).catch(error => { report(safeCode(error)); reconnect(); });
  });

  pi.on("session_start", async (event, context) => {
    ctx = context; stopped = false;
    try {
      const config = loadConfig();
      if (!config) { report("notify_not_configured"); return; }
      client = new NotifyClient({ baseUrl: config.baseUrl, token: readPrivate(config.tokenFile, 16 * 1024).trim() });
      const stateDirectory = config.stateDirectory ?? join(getAgentDir(), "pi-notify-state");
      registry = new IdentityRegistry(join(stateDirectory, "bindings"));
      journal = new DeliveryJournal(join(stateDirectory, "receipts"));
      chronoRoot = config.chronoRoot ?? join(dirname(process.env.PI_CHRONO_CONFIG_PATH ?? join(getAgentDir(), "chrono-compact.json")), "chrono-logical-sessions");
      try { if (event.reason !== "fork") {
        const view = sessionView(context);
        const chrono = readChronoIdentity(view, chronoRoot);
        saved = registry.find(view, chrono);
        if (saved && (saved.sessionId !== view.sessionId || saved.sessionFile !== view.sessionFile)) {
          // Only validated forward rollover reaches here. Persist a new exact
          // local marker before this physical session can own the destination.
          pi.appendEntry(BINDING_ENTRY, { schemaVersion: 1, destinationId: saved.destinationId, bindingId: saved.bindingId });
          const anchor = context.sessionManager.getBranch().at(-1) as unknown as Record<string, unknown>;
          syncSessionAnchor(view.sessionFile, view.sessionId, anchor);
          saved = { ...saved, sessionId: view.sessionId, sessionFile: view.sessionFile, anchorId: String(anchor.id), resumeAnchorId: String(anchor.id), chrono };
          registry.save(saved);
        }
        await connect();
      } } catch (error) { saved = undefined; report(safeCode(error)); }
      for (const subscription of subscriptions.values()) {
        try { await activateSubscription(subscription); } catch (error) { report(safeCode(error)); reconnect(); }
      }
      pi.events.emit(NOTIFY_READY, { schemaVersion: 1, configured: true });
    } catch (error) { saved = undefined; report(safeCode(error)); }
  });
  pi.on("agent_settled", async () => { updateResumeAnchor(); await drain(); });
  pi.on("session_tree", async () => {
    try { if (saved && registry) { saved = { ...saved, suspended: true }; registry.save(saved); } }
    finally { pending = undefined; await receiver?.close(); saved = undefined; report("notify_tree_requires_explicit_binding"); }
  });
  pi.on("session_shutdown", async () => {
    if (stopped) return;
    try { updateResumeAnchor(); } catch (error) { report(safeCode(error)); }
    stopped = true; clearTimeout(reconnectTimer); reconnectTimer = undefined;
    unsubscribe(); pending = undefined;
    await Promise.all([receiver?.close(), ...[...subscriptions.values()].map(item => { item.closed = true; return item.receiver?.close(); })]);
    subscriptions.clear(); ctx = undefined; client = undefined;
  });

  pi.registerCommand("notify", {
    description: "Pi-Notify status, explicit bind <stable-id>, or unbind. Never targets the latest session.",
    handler: async (args, context) => {
      const [action = "status", id, ...extra] = args.trim().split(/\s+/);
      if (action === "status" || !action) { if (context.hasUI) context.ui.notify(JSON.stringify(status()), "info"); return; }
      if (action === "unbind" && !id) {
        if (saved && registry) registry.save({ ...saved, suspended: true });
        pending = undefined; await receiver?.close(); saved = undefined;
        if (context.hasUI) context.ui.notify("Pi-Notify target unbound. Queued events are retained.", "info");
        return;
      }
      if (action !== "bind" || !id || extra.length || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) fail("notify_usage_bind_stable_id");
      await context.waitForIdle();
      const api = requireClient(), view = sessionView(context), chrono = readChronoIdentity(view, chronoRoot);
      if (saved && saved.destinationId !== id) fail("notify_unbind_current_target_first");
      const other = registry!.find(view, chrono);
      if (other && other.destinationId !== id) fail("notify_context_already_registered");
      let destination;
      try { destination = await api.getDestination(id); }
      catch (error) {
        if (!(error instanceof NotifyError) || error.status !== 404) throw error;
        destination = await api.createDestination({ schemaVersion: 1, id, kind: "pi", note: {
          purpose: "Deliver explicitly scheduled work to one saved Pi context.", owner: id, references: [],
          repairContext: "Use the Pi-Notify identity status in the original saved context. Never bind a latest session or broadcast target.",
        } });
      }
      if (destination.kind !== "pi") fail("notify_destination_kind_mismatch");
      await receiver?.close(); receiver = undefined; pending = undefined;
      // Reserve ownership before changing the durable local binding. This also
      // rejects an explicit takeover while another owner is still live.
      const bindingId = randomUUID();
      const reservationOwnerId = `pi-${randomUUID()}`;
      // Admission starts only after the marker exists. A temporary service lease
      // performs the collision check without offering work to an unbound model.
      const lease = await api.bind(id, { schemaVersion: 1, ownerId: reservationOwnerId, ttlMs: 60_000 });
      try {
        if (context.sessionManager.getSessionId() !== view.sessionId || context.sessionManager.getSessionFile() !== view.sessionFile) fail("notify_context_changed");
        pi.appendEntry(BINDING_ENTRY, { schemaVersion: 1, destinationId: id, bindingId });
        const anchor = context.sessionManager.getBranch().at(-1) as unknown as Record<string, unknown>;
        syncSessionAnchor(view.sessionFile, view.sessionId, anchor);
        saved = newBinding(id, view, String(anchor.id), bindingId, chrono);
        registry!.save(saved);
      } finally { await api.releaseBinding(id, { schemaVersion: 1, ownerId: reservationOwnerId, bindingToken: lease.bindingToken }); }
      await connect();
      if (context.hasUI) context.ui.notify(`Pi-Notify registered exact logical target ${id}. ${status().state}. No other session inherits this target.`, "info");
    },
  });

  const inspectJob = async (id: string): Promise<JobRecord> => {
    const job = await requireClient().getJob(id);
    if (job.destinationId !== requireTarget().destinationId) fail("notify_target_mismatch");
    return job;
  };
  const execute = async (params: NotifyToolInput): Promise<unknown> => {
    if (params.action === "status") return status();
    const api = requireClient(), target = requireTarget();
    if (params.action === "create") {
      if (!params.job?.piTask) fail("notify_full_task_definition_required");
      const job = validateJob(params.job);
      if (job.destinationId !== target.destinationId || job.piTask!.targetId !== target.destinationId) fail("notify_target_mismatch");
      if (job.piTask!.context.length === 0) fail("notify_self_contained_context_required");
      const receipt = await api.createJob(job);
      return { ...receipt, guidance: ACCEPTANCE_GUIDANCE };
    }
    if (params.action === "list") {
      const options = { destinationId: target.destinationId, limit: params.limit ?? 5, offset: params.offset };
      if (params.kind === "delivery") return api.listDeliveries(options);
      return api.listJobs(options);
    }
    if (params.action === "inspect") {
      if (!params.id) fail("notify_id_required");
      if (params.kind === "delivery") {
        const delivery = await api.getDelivery(params.id);
        if (delivery.destinationId !== target.destinationId) fail("notify_target_mismatch");
        return delivery;
      }
      if (params.kind === "destination") {
        if (params.id !== target.destinationId) fail("notify_target_mismatch");
        return api.getDestination(params.id);
      }
      if (params.kind === "note") return api.getNote(params.id);
      return inspectJob(params.id);
    }
    if (["pause", "resume", "cancel"].includes(params.action)) {
      if (!params.id) fail("notify_id_required");
      await inspectJob(params.id);
      return api.controlJob(params.id, params.action as "pause" | "resume" | "cancel");
    }
    if (params.action === "note") {
      if (!params.note) fail("notify_note_required");
      return api.putNote(validateNote(params.note));
    }
    if (params.action === "notes") return params.id ? api.getNote(params.id) : api.listNotes({ limit: params.limit ?? 5, offset: params.offset });
    fail("notify_action_invalid");
  };
  pi.registerTool({ name: "notify", label: "Pi-Notify", description: "Schedule a complete self-contained task for this explicitly registered logical agent. Inspect, list, pause, resume, cancel, or maintain resource notes. Events do not grant authorization. Output is limited to 48 KiB; use small pages.",
    promptSnippet: "Schedule durable wakeups and inspect their state for this registered agent",
    promptGuidelines: ["Use notify create only with a complete task definition and the user's approved scope. After durable acceptance, do not poll, sleep, or wait for the trigger. End the turn. Use notify_complete only after the actual task outcome is known."],
    parameters: notifySchema, async execute(_id, params) { return result(await execute(params)); },
  });
  pi.registerTool({ name: "notify_complete", label: "Complete Pi-Notify delivery", description: "Explicitly report the outcome of the currently owned external delivery. Durable receipt is not completion. Include summary, evidence, and remaining work. This does not grant new authorization.", parameters: completeSchema,
    async execute(_id, params, _signal, _update, context) {
      const owner = requireOwnership();
      if (!pending || pending.delivery.id !== params.deliveryId || owner.current?.id !== params.deliveryId) fail("notify_delivery_not_owned");
      const delivery = pending.delivery;
      journal!.complete(pi, context, delivery, params.status, params.result);
      try {
        const completed = await owner.ack(params.status, params.result, params.status === "failed" ? "notify_reported_failed" : undefined);
        pending = undefined;
        return result({ schemaVersion: 1, outcomeRecorded: true, completionReported: true, delivery: completed });
      } catch (error) {
        report(safeCode(error));
        return result({ schemaVersion: 1, outcomeRecorded: true, completionReported: false, deliveryId: params.deliveryId,
          error: safeCode(error), guidance: "The outcome is saved locally. The receiver will reconcile it when ownership returns. Do not repeat completed side effects." });
      }
    },
  });
}
