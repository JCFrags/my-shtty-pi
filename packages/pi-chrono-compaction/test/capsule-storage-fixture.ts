import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { executeCatalogStoreRequest } from "../src/catalog-store.js";
import { executeCapsuleRequest, type CapsuleExecutionOptions } from "../src/capsule-store.js";
import {
  CAPSULE_REDUCER_PIPELINE_VERSION,
  CAPSULE_SCHEMA_VERSION,
  CHUNK_SCHEMA_VERSION,
  DERIVED_SCHEMA_VERSION,
  type CapsuleCatalogView,
  type CapsuleWorkerResponse,
  type DerivedStoreIdentity,
} from "../src/capsule-contract.js";
import type { CatalogResponse } from "../src/catalog-contract.js";

export const line = (id: string, parentId: string | null, content: unknown = "synthetic", role = "user"): string =>
  JSON.stringify({ type: "message", id, parentId, message: { role, content: [{ type: "text", text: content }] } }) + "\n";

export function setupCapsuleFixture(initial = line("a", null)) {
  const directory = mkdtempSync(join(tmpdir(), "chrono-capsule-"));
  const catalogDirectory = join(directory, "catalog"), derivedDirectory = join(directory, "derived"), sourcePath = join(directory, "source.jsonl");
  writeFileSync(sourcePath, initial, { mode: 0o600 });
  const sessionKey = "synthetic-capsule";
  const catalog = async (extra: Record<string, unknown>): Promise<Record<string, any>> => {
    const response = await executeCatalogStoreRequest({ v: 1, catalogDirectory, sessionKey, ...extra });
    if (!response.ok) assert.fail(JSON.stringify(response));
    return response.result;
  };
  const ingest = () => catalog({ op: "ingestStep", shardKey: "s1", sourcePath, branchKey: "main", shardOrdinal: 0 });
  let identity: DerivedStoreIdentity;
  const initialize = async (leaf = "a"): Promise<CapsuleCatalogView> => {
    await ingest();
    const view = (await catalog({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: leaf } })).view as CapsuleCatalogView;
    identity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: view.storeKey, catalogGeneration: view.generation,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION,
      configHash: createHash("sha256").update("synthetic-config").digest("hex") };
    return view;
  };
  const request = async (view: CapsuleCatalogView, extra: Record<string, unknown>, options?: CapsuleExecutionOptions): Promise<CapsuleWorkerResponse> =>
    executeCapsuleRequest({ v: 1, derivedDirectory, catalogDirectory, identity, view, ...extra }, options);
  const ok = async (view: CapsuleCatalogView, extra: Record<string, unknown>, options?: CapsuleExecutionOptions): Promise<Record<string, any>> => {
    const response = await request(view, extra, options); if (!response.ok) assert.fail(JSON.stringify(response)); return response.result;
  };
  const append = (text: string) => appendFileSync(sourcePath, text);
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  const catalogExecutor = (value: unknown): Promise<CatalogResponse> => executeCatalogStoreRequest(value);
  return { directory, catalogDirectory, derivedDirectory, sourcePath, sessionKey, catalog, ingest, initialize, request, ok, append, cleanup, catalogExecutor,
    get identity() { return identity; } };
}
