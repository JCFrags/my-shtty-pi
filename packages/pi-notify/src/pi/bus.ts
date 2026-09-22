import type { DeliveryRecord, Json } from "../contracts.ts";

export const NOTIFY_SUBSCRIBE = "pi-notify:subscribe:v1";
export const NOTIFY_READY = "pi-notify:ready:v1";
export interface NotifyEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
}
export interface NotificationDelivery {
  /** Data only. Never includes binding or delivery lease tokens. */
  readonly delivery: DeliveryRecord;
  /** Call only after the consumer saves its own receipt durably. */
  acknowledge(): Promise<DeliveryRecord>;
  /** Explicit outcome, separate from receipt. The result must contain no secrets. */
  complete(result: Json): Promise<DeliveryRecord>;
  retry(error: string): Promise<DeliveryRecord>;
  fail(error: string, result?: Json): Promise<DeliveryRecord>;
}
export interface NotificationSubscription {
  readonly consumerId: string;
  readonly destinationId: string;
  close(): Promise<void>;
}
export interface NotificationSubscriptionRequest {
  readonly schemaVersion: 1;
  readonly consumerId: string;
  readonly destinationId: string;
  readonly handle: (delivery: NotificationDelivery) => void | Promise<void>;
  readonly accept: (reply: { ok: true; subscription: NotificationSubscription } | { ok: false; error: string }) => void;
}

/** Register during session_start. Resolution confirms only local registration,
 * not a service binding or durable event receipt. Each runtime must register
 * again after reload. A NOTIFY_READY event reports service admission. This API
 * never invokes the model. */
export function subscribeNotifications(bus: NotifyEventBus, input: Pick<NotificationSubscriptionRequest, "consumerId" | "destinationId" | "handle">): Promise<NotificationSubscription> {
  return new Promise((resolve, reject) => {
    let answered = false;
    bus.emit(NOTIFY_SUBSCRIBE, { schemaVersion: 1, ...input,
      accept: (reply: Parameters<NotificationSubscriptionRequest["accept"]>[0]) => {
        answered = true;
        if (reply.ok) resolve(reply.subscription);
        else reject(new Error(reply.error));
      },
    } satisfies NotificationSubscriptionRequest);
    // Pi invokes bus listeners synchronously. Do not hang session_start when
    // the adapter is absent or has already closed its listener.
    if (!answered) reject(new Error("notify_adapter_unavailable"));
  });
}
