import type {
  AckInput, BindInput, Binding, BindingInput, ClaimedDelivery, ClaimInput, ClaimResponse,
  DeliveryRecord, DestinationInput, DestinationRecord, EventAcceptance, EventInput,
  HealthResponse, JobAcceptance, JobInput, JobRecord, LeaseInput, ListOptions, Page, ResourceNote,
} from "./contracts.ts";

export class NotifyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "NotifyError";
    this.code = code;
    this.status = status;
  }
}
export interface NotifyClientOptions {
  baseUrl: string;
  /** Keep this value outside records and logs. Use a protected token file at the integration boundary. */
  token: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
export class NotifyClient {
  readonly baseUrl: string;
  #token: string;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch;
  constructor(options: NotifyClientOptions) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new NotifyError("invalid_url", "Use an HTTP(S) service URL without credentials, query, or fragment.");
    }
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new NotifyError("insecure_url", "Plain HTTP requires loopback. Use an SSH forward or HTTPS.");
    }
    if (!options.token.trim()) throw new NotifyError("missing_token", "A service token is required.");
    this.baseUrl = url.href.replace(/\/$/, "");
    this.#token = options.token.trim();
    this.#timeoutMs = options.timeoutMs ?? 35_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new NotifyError("service_unavailable", "Pi-Notify request did not return a receipt. Retry the same ID to resolve uncertain acceptance.");
    }
    let value: any;
    try { value = await response.json(); } catch { throw new NotifyError("invalid_response", "Service response is not JSON.", response.status); }
    if (!response.ok) {
      throw new NotifyError(value?.error?.code ?? "http_error", value?.error?.message ?? `Service returned HTTP ${response.status}.`, response.status);
    }
    if (value?.schemaVersion !== 1) throw new NotifyError("unsupported_version", "Service returned an unsupported schema version.", response.status);
    return value as T;
  }
  health() { return this.request<HealthResponse>("GET", "/v1/health"); }
  publishEvent(event: EventInput) { return this.request<EventAcceptance>("POST", "/v1/events", event); }
  createDestination(destination: DestinationInput) { return this.request<DestinationRecord>("POST", "/v1/destinations", destination); }
  getDestination(id: string) { return this.request<DestinationRecord>("GET", `/v1/destinations/${encodeURIComponent(id)}`); }
  listDestinations(options?: ListOptions) { return this.request<Page<DestinationRecord>>("GET", `/v1/destinations${query(options)}`); }
  createJob(job: JobInput) { return this.request<JobAcceptance>("POST", "/v1/jobs", job); }
  getJob(id: string) { return this.request<JobRecord>("GET", `/v1/jobs/${encodeURIComponent(id)}`); }
  listJobs(options?: ListOptions) { return this.request<Page<JobRecord>>("GET", `/v1/jobs${query(options)}`); }
  controlJob(id: string, action: "pause" | "resume" | "cancel") {
    return this.request<JobRecord>("POST", `/v1/jobs/${encodeURIComponent(id)}/control`, { schemaVersion: 1, action });
  }
  bind(id: string, input: BindInput) { return this.request<Binding>("POST", `/v1/destinations/${encodeURIComponent(id)}/bind`, input); }
  renewBinding(id: string, input: BindingInput) { return this.request<Binding>("POST", `/v1/destinations/${encodeURIComponent(id)}/renew-binding`, input); }
  releaseBinding(id: string, input: BindingInput) {
    return this.request<{ schemaVersion: 1; released: true }>("POST", `/v1/destinations/${encodeURIComponent(id)}/release-binding`, input);
  }
  claim(id: string, input: ClaimInput, signal?: AbortSignal) {
    return this.request<ClaimResponse>("POST", `/v1/destinations/${encodeURIComponent(id)}/claim`, input, signal);
  }
  renew(id: string, input: LeaseInput) { return this.request<ClaimedDelivery>("POST", `/v1/deliveries/${encodeURIComponent(id)}/renew`, input); }
  ack(id: string, input: AckInput) { return this.request<DeliveryRecord>("POST", `/v1/deliveries/${encodeURIComponent(id)}/ack`, input); }
  getDelivery(id: string) { return this.request<DeliveryRecord>("GET", `/v1/deliveries/${encodeURIComponent(id)}`); }
  listDeliveries(options?: ListOptions) { return this.request<Page<DeliveryRecord>>("GET", `/v1/deliveries${query(options)}`); }
  putNote(note: ResourceNote) { return this.request<ResourceNote>("PUT", `/v1/notes/${encodeURIComponent(note.resourceId)}`, note); }
  getNote(resourceId: string) { return this.request<ResourceNote>("GET", `/v1/notes/${encodeURIComponent(resourceId)}`); }
  listNotes(options?: ListOptions) { return this.request<Page<ResourceNote>>("GET", `/v1/notes${query(options)}`); }
}
function query(options?: ListOptions): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options ?? {})) if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
