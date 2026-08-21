import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ADAPTER_PROTOCOL_VERSION,
  connectPreviewAdapters,
  PreviewAdapterRegistry,
  REGISTER_ADAPTER_EVENT,
  REQUEST_ADAPTERS_EVENT,
  type PreviewAdapterRegistration,
} from "../src/adapter.js";
import type { BuiltinSemantics } from "../src/preview.js";

const semantics: BuiltinSemantics = {
  async constructEdit({ current }) { return current.toString("utf8"); },
  async constructWrite({ input }) { return input.content; },
  generateUnifiedDiff() { return "diff"; },
};

function registration(path = "/package/packages/files/index.ts"): PreviewAdapterRegistration {
  return {
    protocolVersion: ADAPTER_PROTOCOL_VERSION,
    id: "pi-grounded-tools/files-v1",
    ownerSourcePath: path,
    tools: ["edit", "write"],
    semantics,
  };
}

function tool(name: "edit" | "write", path: string, source = "package") {
  return { name, sourceInfo: { path, source, scope: "user" as const, origin: "package" as const } };
}

test("registry selects exact builtin and registered Grounded owners", () => {
  const registry = new PreviewAdapterRegistry();
  assert.notEqual(registry.resolve("edit", [tool("edit", "<builtin:edit>", "builtin")]), semantics);

  registry.register(registration());
  assert.equal(registry.resolve("edit", [tool("edit", "/package/packages/files/index.ts")]), semantics);
  assert.equal(registry.resolve("write", [tool("write", "/package/packages/files/index.ts")]), semantics);
});

test("registry fails closed for unsupported, ambiguous, and forged builtin owners", () => {
  const registry = new PreviewAdapterRegistry();
  assert.throws(() => registry.resolve("edit", [tool("edit", "/other/edit.ts")]), /unsupported edit owner/);
  assert.throws(() => registry.resolve("edit", []), /found 0/);
  assert.throws(() => registry.resolve("edit", [tool("edit", "/a"), tool("edit", "/b")]), /found 2/);
  assert.throws(
    () => registry.resolve("edit", [tool("edit", "/forged", "builtin")]),
    /unsupported edit builtin provenance/,
  );
});

test("adapter connection handles both extension load orders", () => {
  const handlers = new Map<string, Array<(value: unknown) => void>>();
  const bus = {
    on(channel: string, handler: (value: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {};
    },
    emit(channel: string, value: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(value);
    },
  };

  const early = registration("/early.ts");
  bus.on(REQUEST_ADAPTERS_EVENT, (reply) => {
    if (typeof reply === "function") (reply as (value: unknown) => void)(early);
  });
  const registry = new PreviewAdapterRegistry();
  connectPreviewAdapters({ events: bus } as ExtensionAPI, registry);
  assert.equal(registry.resolve("edit", [tool("edit", "/early.ts")]), semantics);

  const late = registration("/late.ts");
  bus.emit(REGISTER_ADAPTER_EVENT, late);
  assert.equal(registry.resolve("write", [tool("write", "/late.ts")]), semantics);
});
