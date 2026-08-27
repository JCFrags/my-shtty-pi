import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_FILE_RESOURCE_PROTOCOL_VERSION,
  SESSION_OPERATION_SERVICE_PROTOCOL_VERSION,
  SESSION_OPERATION_SERVICE_READY_EVENT,
  SESSION_OPERATION_SERVICE_REQUEST_EVENT,
  SESSION_OPERATION_SERVICE_V2_READY_EVENT,
  SESSION_OPERATION_SERVICE_V2_REQUEST_EVENT,
  SESSION_PROVIDER_PROTOCOL_VERSION,
  SessionProviderRegistry,
  SessionServiceError,
  type SessionOperationService,
  type SessionOperationServiceRequestEvent,
  type SessionOperationServiceV2,
  type SessionOperationServiceV2RequestEvent,
  type SessionProvider,
} from "@grounded/pi-core/session-contract";

function provider(id: string, backend: "local" | "ssh" = "local"): SessionProvider {
  return {
    id,
    backend,
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    capabilities: () => ({ backend, providerId: id, protocolVersion: 1, pty: false, input: false }),
    async open() {
      throw new Error("not used");
    },
  };
}

test("session operation service contract has stable versioned discovery events", async () => {
  assert.equal(SESSION_PROVIDER_PROTOCOL_VERSION, 1);
  assert.equal(SESSION_FILE_RESOURCE_PROTOCOL_VERSION, 1);
  assert.equal(SESSION_OPERATION_SERVICE_PROTOCOL_VERSION, 2);
  assert.equal(SESSION_OPERATION_SERVICE_READY_EVENT, "grounded:session-operation-service-ready-v1");
  assert.equal(SESSION_OPERATION_SERVICE_REQUEST_EVENT, "grounded:session-operation-service-request-v1");
  assert.equal(SESSION_OPERATION_SERVICE_V2_READY_EVENT, "grounded:session-operation-service-ready-v2");
  assert.equal(SESSION_OPERATION_SERVICE_V2_REQUEST_EVENT, "grounded:session-operation-service-request-v2");
  const service: SessionOperationService = {
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    async withLocalSession(_sessionId, operation) {
      return operation({
        id: "s_test",
        backend: "local",
        providerId: "local-v1",
        pty: false,
        cwd: "/tmp",
        generation: 1,
      });
    },
  };
  let accepted: SessionOperationService | undefined;
  const request: SessionOperationServiceRequestEvent = {
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    accept(value) { accepted = value; },
  };
  request.accept(service);
  assert.equal(accepted, service);
  assert.equal(await accepted!.withLocalSession("s_test", async (context) => context.cwd), "/tmp");

  const fileResource = {
    protocolVersion: SESSION_FILE_RESOURCE_PROTOCOL_VERSION,
    queueIdentity: "fixture",
  } as any;
  const serviceV2: SessionOperationServiceV2 = {
    protocolVersion: SESSION_OPERATION_SERVICE_PROTOCOL_VERSION,
    async withSession(_sessionId, operation) {
      return operation({
        id: "s_remote",
        backend: "ssh",
        providerId: "native-ssh-v1",
        pty: false,
        cwd: "/remote",
        generation: 2,
        fileResource,
      });
    },
  };
  let acceptedV2: SessionOperationServiceV2 | undefined;
  const requestV2: SessionOperationServiceV2RequestEvent = {
    protocolVersion: SESSION_OPERATION_SERVICE_PROTOCOL_VERSION,
    accept(value) { acceptedV2 = value; },
  };
  requestV2.accept(serviceV2);
  assert.equal(acceptedV2, serviceV2);
  assert.equal(await acceptedV2!.withSession("s_remote", async (context) => context.fileResource), fileResource);
});

test("session provider registry rejects duplicate backend and provider ownership", () => {
  const registry = new SessionProviderRegistry();
  registry.register(provider("local-v1"));
  assert.throws(
    () => registry.register(provider("other-local")),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_PROVIDER_DUPLICATE",
  );
  assert.throws(
    () => registry.register(provider("local-v1", "ssh")),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_PROVIDER_DUPLICATE",
  );
});

test("session provider registry rejects incompatible versions", () => {
  const registry = new SessionProviderRegistry();
  const invalid = { ...provider("future"), protocolVersion: 2 } as unknown as SessionProvider;
  assert.throws(
    () => registry.register(invalid),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_PROVIDER_VERSION_UNSUPPORTED",
  );
});

test("unavailable backend never falls back to a registered local provider", () => {
  const registry = new SessionProviderRegistry();
  registry.register(provider("local-v1"));
  assert.equal(registry.get("local").id, "local-v1");
  assert.throws(
    () => registry.get("ssh"),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_BACKEND_UNAVAILABLE",
  );
  assert.deepEqual(registry.list(), [{ backend: "local", providerId: "local-v1", protocolVersion: 1, pty: false, input: false }]);
});
