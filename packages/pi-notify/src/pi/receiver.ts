import { randomUUID } from "node:crypto";
import { NotifyClient, NotifyError } from "../client.ts";
import type { AckInput, Binding, ClaimedDelivery, DeliveryRecord, Json } from "../contracts.ts";
import type { NotificationDelivery } from "./bus.ts";

export const safeCode = (error: unknown): string => error instanceof NotifyError ? error.code
  : error instanceof Error && /^notify_[a-z0-9_]+$/.test(error.message) ? error.message : "notify_receiver_unavailable";
export function publicDelivery(delivery: ClaimedDelivery): DeliveryRecord {
  const { leaseToken: _token, ...record } = delivery;
  return structuredClone(record);
}

/** One exclusive service binding and at most one outstanding delivery. All
 * waits and lease renewal run without a model. A receiver never opens Pi. */
export class Receiver {
  readonly ownerId = `pi-${randomUUID()}`;
  readonly abort = new AbortController();
  binding: Binding | undefined;
  current: ClaimedDelivery | undefined;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private done: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private releaseWait: (() => void) | undefined;
  readonly client: NotifyClient;
  readonly destinationId: string;
  readonly handle: (delivery: NotificationDelivery) => Promise<void> | void;
  readonly onError: (code: string) => void;
  readonly valid: () => boolean;
  constructor(client: NotifyClient, destinationId: string,
    handle: (delivery: NotificationDelivery) => Promise<void> | void,
    onError: (code: string) => void, valid: () => boolean = () => true) {
    this.client = client; this.destinationId = destinationId; this.handle = handle; this.onError = onError; this.valid = valid;
  }

  async start(): Promise<void> {
    if (this.binding || this.abort.signal.aborted) throw new Error("notify_receiver_already_started");
    const binding = await this.client.bind(this.destinationId, { schemaVersion: 1, ownerId: this.ownerId, ttlMs: 60_000 });
    if (this.abort.signal.aborted || !this.valid()) {
      await this.client.releaseBinding(this.destinationId, { schemaVersion: 1, ownerId: this.ownerId, bindingToken: binding.bindingToken });
      throw new Error("notify_context_changed");
    }
    this.binding = binding;
    this.scheduleHeartbeat();
    this.loop = this.run();
  }
  private credentials() {
    const binding = this.binding;
    if (!binding || this.abort.signal.aborted || !this.valid() || Date.parse(binding.expiresAt) <= Date.now()) throw new Error("notify_binding_not_live");
    return { schemaVersion: 1 as const, ownerId: this.ownerId, bindingToken: binding.bindingToken };
  }
  private scheduleHeartbeat(): void {
    if (this.abort.signal.aborted) return;
    this.heartbeat = setTimeout(() => { void this.renew(); }, 20_000);
    this.heartbeat.unref?.();
  }
  private async renew(): Promise<void> {
    try {
      const credentials = this.credentials();
      this.binding = await this.client.renewBinding(this.destinationId, { ...credentials, ttlMs: 60_000 });
      const current = this.current;
      if (current) {
        const renewed = await this.client.renew(current.id, { ...credentials, leaseToken: current.leaseToken, leaseMs: 60_000 });
        if (this.current?.id === current.id) this.current = renewed;
      }
    } catch (error) {
      this.onError(safeCode(error));
      // Ownership uncertainty stops delivery. The durable queue remains intact.
      void this.close();
      return;
    }
    this.scheduleHeartbeat();
  }
  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const reply = await this.client.claim(this.destinationId, { ...this.credentials(), waitMs: 25_000, leaseMs: 60_000 }, this.abort.signal);
        if (this.abort.signal.aborted) break;
        if (!reply.delivery) continue;
        this.current = reply.delivery;
        const settled = new Promise<void>(resolve => { this.done = resolve; });
        const id = reply.delivery.id;
        const acknowledge = async (outcome: AckInput["outcome"], result?: Json, error?: string): Promise<DeliveryRecord> => {
          if (this.current?.id !== id) throw new Error("notify_delivery_not_owned");
          return this.ack(outcome, result, error);
        };
        try {
          await this.handle({ delivery: publicDelivery(reply.delivery),
            acknowledge: () => acknowledge("delivered"), complete: result => acknowledge("completed", result),
            retry: error => acknowledge("retry", undefined, error), fail: (error, result) => acknowledge("failed", result, error) });
        } catch (error) {
          this.onError(safeCode(error));
          if (this.current?.id === id && !this.abort.signal.aborted) {
            try { await this.ack("retry", undefined, safeCode(error)); }
            catch (ackError) { this.onError(safeCode(ackError)); void this.close(); }
          }
        }
        await settled;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.onError(safeCode(error));
        if (error instanceof NotifyError && ["binding_lost", "lease_lost"].includes(error.code)) { void this.close(); break; }
        await new Promise<void>(resolve => {
          this.releaseWait = resolve;
          this.retryTimer = setTimeout(resolve, 5_000);
          this.retryTimer.unref?.();
        });
        this.releaseWait = undefined;
      }
    }
  }
  async ack(outcome: AckInput["outcome"], result?: Json, error?: string): Promise<DeliveryRecord> {
    const current = this.current;
    if (!current) throw new Error("notify_delivery_not_owned");
    const record = await this.client.ack(current.id, { ...this.credentials(), leaseToken: current.leaseToken,
      outcome, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) });
    if (this.current?.id === current.id && outcome !== "delivered") {
      this.current = undefined;
      this.done?.(); this.done = undefined;
    }
    return record;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.abort.abort();
    clearTimeout(this.heartbeat); clearTimeout(this.retryTimer);
    this.releaseWait?.(); this.done?.(); this.done = undefined;
    const binding = this.binding;
    this.binding = undefined;
    this.current = undefined;
    this.closing = (async () => {
      if (binding) {
        try { await this.client.releaseBinding(this.destinationId, { schemaVersion: 1, ownerId: this.ownerId, bindingToken: binding.bindingToken }); }
        catch (error) { this.onError(safeCode(error)); }
      }
      // Abort fences every pending callback. Do not wait for a consumer's
      // application callback, which may outlive this session's shutdown.
    })();
    return this.closing;
  }
}
