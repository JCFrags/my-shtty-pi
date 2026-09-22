import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, chownSync, lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import type { AckInput, BindingInput, BindInput, ClaimInput, HealthResponse, LeaseInput, ListOptions, PrincipalConfig, ServiceConfig } from "../contracts.ts";
import { NotifyStore } from "../core/store.ts";
import { ServiceError, fail, integer, object, validateDestination, validateEvent, validateJob, validateLease, validateNote, version } from "../core/validation.ts";
import { allowedDestinations, Authenticator, requireDestination, requireRole, requireSource, validateConfig } from "./config.ts";

export interface RunningService {
  store: NotifyStore;
  server: Server;
  unixServer?: Server;
  baseUrl: string;
  health: HealthResponse;
  close(): Promise<void>;
}
/** All transport paths use the same authentication and authorization handler. */
export async function startServer(input: ServiceConfig, options: { onError?: (code: string) => void } = {}): Promise<RunningService> {
  const config = validateConfig(input);
  const auth = new Authenticator(config);
  if (config.unixSocket) checkSocketPath(config.unixSocket.path);
  const store = new NotifyStore({ database: config.database, serviceId: config.serviceId, note: config.note });
  const health: HealthResponse = { schemaVersion: 1, serviceId: config.serviceId, instanceId: randomUUID(), startedAt: new Date().toISOString(), status: "ready" };
  const controllers = new Set<AbortController>();
  let closed = false;
  let schedulerFailed = false;
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController(); controllers.add(controller);
    res.once("close", () => { controller.abort(); controllers.delete(controller); });
    try {
      if (closed) fail("service_stopping", "Service is stopping. Retry the same request ID after reconnecting.", 503);
      if (req.headers.origin) fail("browser_origin_forbidden", "Browser-origin requests are not supported.", 403);
      const principal = auth.authenticate(req.headers.authorization);
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
      if (parts[0] !== "v1") fail("not_found", "Use the /v1 API.", 404);
      if (req.method === "GET" && parts.length === 2 && parts[1] === "health") {
        if (schedulerFailed) fail("scheduler_unavailable", "The last scheduler pass failed. Inspect protected service logs and storage before retrying.", 503);
        return send(res, 200, health);
      }
      const value = req.method === "POST" || req.method === "PUT" ? await body(req) : undefined;
      const result = await route(req.method ?? "", parts.slice(1), url, value, principal, controller.signal);
      send(res, result.status, result.body);
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof ServiceError;
      if (!known) options.onError?.("request_failed");
      send(res, known ? error.status : 500, { schemaVersion: 1, error: { code: known ? error.code : "internal_error", message: known ? error.message : "Service operation failed. Inspect protected service logs and storage. Retry the same ID if acceptance is uncertain." } });
    }
  };
  async function route(method: string, parts: string[], url: URL, value: unknown, principal: PrincipalConfig, signal: AbortSignal): Promise<{status: number; body: unknown}> {
    const [kind, id, action] = parts;
    const ok = (body: unknown, status = 200) => ({ status, body });
    if (parts.length > 3) fail("not_found", "API route was not found.", 404);
    if (kind === "events" && !id && method === "POST") {
      requireRole(principal, "producer"); const event = validateEvent(value); requireSource(principal, event.source);
      const receipt = store.publishEvent(event);
      // A producer can observe its acceptance, but not routing to destinations outside its scope.
      if (!principal.roles.includes("admin")) receipt.deliveryIds = [];
      return ok(receipt, 202);
    }
    if (kind === "destinations") {
      if (!id && method === "POST") {
        requireRole(principal, "scheduler"); const destination = validateDestination(value); requireDestination(principal, destination.id);
        return ok(store.createDestination(destination), 201);
      }
      if (method === "GET") {
        requireRole(principal, "reader", "scheduler", "consumer");
        if (!id) return ok(store.list("destinations", listOptions(url), allowedDestinations(principal)));
        if (!action) { requireDestination(principal, id); return ok(store.getDestination(id)); }
      }
      if (id && action && method === "POST") {
        requireRole(principal, "consumer"); requireDestination(principal, id);
        if (action === "bind") return ok(store.bind(id, validateLease(value, "bind") as BindInput));
        if (action === "renew-binding") return ok(store.renewBinding(id, validateLease(value, "binding") as BindingInput));
        if (action === "release-binding") return ok(store.releaseBinding(id, validateLease(value, "binding") as BindingInput));
        if (action === "claim") {
          const input = validateLease(value, "claim") as ClaimInput;
          const deadline = Date.now() + (input.waitMs ?? 0);
          while (true) {
            if (signal.aborted || closed) fail("request_cancelled", "Claim request ended before a delivery receipt.", 499);
            const delivery = store.claim(id, input);
            if (delivery || Date.now() >= deadline) return ok({ schemaVersion: 1, delivery });
            await delay(Math.min(250, deadline - Date.now()), undefined, { signal });
          }
        }
      }
    }
    if (kind === "jobs") {
      if (!id && method === "POST") {
        requireRole(principal, "scheduler"); const job = validateJob(value); requireDestination(principal, job.destinationId);
        if (job.trigger.kind === "event") requireSource(principal, job.trigger.source);
        return ok(store.createJob(job), 202);
      }
      if (method === "GET") {
        requireRole(principal, "reader", "scheduler", "consumer");
        if (!id) return ok(store.list("jobs", listOptions(url), allowedDestinations(principal)));
        if (!action) { const job = store.getJob(id); requireDestination(principal, job.destinationId); return ok(job); }
      }
      if (id && action === "control" && method === "POST") {
        requireRole(principal, "scheduler"); const job = store.getJob(id); requireDestination(principal, job.destinationId);
        const input = object(value, "control", ["schemaVersion", "action"]); version(input);
        return ok(store.controlJob(id, input.action));
      }
    }
    if (kind === "deliveries") {
      if (method === "GET") {
        requireRole(principal, "reader", "scheduler", "consumer");
        if (!id) return ok(store.list("deliveries", listOptions(url), allowedDestinations(principal)));
        if (!action) { const delivery = store.getDelivery(id); requireDestination(principal, delivery.destinationId); return ok(delivery); }
      }
      if (id && method === "POST") {
        requireRole(principal, "consumer"); const delivery = store.getDelivery(id); requireDestination(principal, delivery.destinationId);
        if (action === "renew") return ok(store.renew(id, validateLease(value, "lease") as LeaseInput));
        if (action === "ack") return ok(store.ack(id, validateLease(value, "ack") as AckInput));
      }
    }
    if (kind === "notes") {
      if (!id && method === "GET") { requireRole(principal, "reader", "scheduler", "consumer"); return ok(store.list("notes", listOptions(url), allowedDestinations(principal))); }
      if (id && !action && (method === "GET" || method === "PUT")) {
        requireRole(principal, ...(method === "PUT" ? ["scheduler"] as const : ["reader", "scheduler", "consumer"] as const));
        if (id.startsWith("job:")) requireDestination(principal, store.getJob(id.slice(4)).destinationId);
        else if (id.startsWith("destination:")) requireDestination(principal, id.slice(12));
        else requireRole(principal, "admin");
        if (method === "GET") return ok(store.getNote(id));
        const note = validateNote(value);
        if (note.resourceId !== id) fail("resource_mismatch", "The note resourceId must equal its URL identity.");
        return ok(store.putNote(note));
      }
    }
    return fail("not_found", "API route or method was not found.", 404);
  }
  function makeServer() {
    const server = createServer((req, res) => { void handler(req, res); });
    server.requestTimeout = 35_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 100;
    return server;
  }
  const server = makeServer();
  let unixServer: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await listen(server, { port: config.port ?? 7734, host: config.host ?? "127.0.0.1" });
    if (config.unixSocket) {
      unixServer = makeServer();
      await listen(unixServer, { path: config.unixSocket.path });
      // Node creates the new socket. No pre-existing path is ever removed by this service.
      if (config.unixSocket.groupId !== undefined) chownSync(config.unixSocket.path, process.getuid!(), config.unixSocket.groupId);
      chmodSync(config.unixSocket.path, config.unixSocket.mode ?? 0o600);
    }
    store.tick();
    timer = setInterval(() => {
      try { store.tick(); schedulerFailed = false; }
      catch { schedulerFailed = true; options.onError?.("scheduler_failed"); }
    }, 500);
    timer.unref();
  } catch (error) {
    await Promise.all([closeServer(server), ...(unixServer ? [closeServer(unixServer)] : [])]); store.close(); throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    store, server, unixServer, baseUrl: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`, health,
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer);
      for (const controller of controllers) controller.abort();
      await Promise.all([closeServer(server), ...(unixServer ? [closeServer(unixServer)] : [])]);
      store.close();
    },
  };
}
function checkSocketPath(path: string) {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100) fail("invalid_socket_path", "Use an absolute Unix socket path of at most 100 bytes.");
  let directory;
  try { directory = lstatSync(dirname(path)); } catch { return fail("socket_directory_missing", "Create the socket directory with the service user as owner before starting."); }
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) || (process.getuid && directory.uid !== process.getuid())) fail("unsafe_socket_directory", "Socket directory must be owned by the service user and must not be group- or world-writable.");
  try { lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  fail("socket_path_exists", "Unix socket path already exists. Verify its owner and service instance manually. Pi-Notify will not remove or replace it.", 409);
}
function listen(server: Server, address: {port: number; host: string} | {path: string}): Promise<void> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, () => { server.off("error", reject); resolve(); }); });
}
function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
function send(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.split(";")[0].trim().match(/^application\/json$/i)) fail("unsupported_media_type", "Requests with bodies require Content-Type: application/json.", 415);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 131_072) fail("body_too_large", "JSON request exceeds 128 KiB.", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return fail("invalid_json", "Request body is not valid JSON."); }
}
function listOptions(url: URL): ListOptions {
  const options: ListOptions = {};
  for (const key of url.searchParams.keys()) if (!["limit", "offset", "destinationId", "jobId"].includes(key)) fail("unknown_filter", "Supported list filters are limit, offset, destinationId, and jobId.");
  for (const key of ["limit", "offset"] as const) {
    if (url.searchParams.has(key)) {
      const value = Number(url.searchParams.get(key)); integer(value, key, key === "limit" ? 1 : 0, key === "limit" ? 100 : 1_000_000); options[key] = value;
    }
  }
  for (const key of ["destinationId", "jobId"] as const) if (url.searchParams.has(key)) options[key] = url.searchParams.get(key)!;
  return options;
}
