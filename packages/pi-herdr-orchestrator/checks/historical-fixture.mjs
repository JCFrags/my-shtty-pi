import { canonicalJson, sha256 } from "../dist/src/shared/canonical-json.js";

export function historicalEvent() {
  const base = {
    schemaVersion: 1, seq: 1, id: "evt_00000000000000000000000001",
    timestamp: "2026-01-01T00:00:00.000Z", type: "audit.action",
    actor: { principalId: "prn_00000000000000000000000001", kind: "deck" },
    entityRefs: {}, payload: { action: "historical_fixture" }, prevHash: "0".repeat(64),
  };
  return { ...base, hash: sha256(canonicalJson(base)) };
}
