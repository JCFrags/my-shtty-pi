export interface SchedulerSnapshot {
  readonly queued: readonly { readonly endpointId?: string }[];
  readonly active: readonly { readonly endpointId?: string }[];
  readonly provisioning: number;
}
