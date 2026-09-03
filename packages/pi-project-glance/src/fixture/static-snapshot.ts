import { deriveSessionKey } from "../runtime/paths.js";
import {
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceSnapshot,
} from "../protocol/model.js";
import { validateSnapshot } from "../protocol/validation.js";

export const STATIC_FIXTURE_NOW = "2026-09-02T00:00:00.000Z";
export const STATIC_FIXTURE_SESSION_KEY = deriveSessionKey(
  "pi-project-glance-static-fixture",
);

export function createStaticSnapshot(
  sessionKey = STATIC_FIXTURE_SESSION_KEY,
  now = STATIC_FIXTURE_NOW,
): ProjectGlanceSnapshot {
  return validateSnapshot({
    protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey,
    revision: 1,
    generatedAt: now,
    current: {
      step: "Validate the Project Glance foundation",
      toward: "V1 static vertical slice",
      focus: "Build, link, open, focus, and reconnect",
    },
    feed: [
      {
        id: "fixture-relay-handshake",
        type: "assistant_update",
        text: "The local versioned relay handshake succeeded.",
        createdAt: now,
      },
      {
        id: "fixture-unconnected-sources",
        type: "assistant_update",
        text: "Todo, Workplan, and session-message sources are not connected in this foundation slice.",
        createdAt: now,
      },
    ],
  });
}
