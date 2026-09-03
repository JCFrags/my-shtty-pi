import { deriveSessionKey } from "../runtime/paths.js";
import {
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceFeedItem,
  type ProjectGlanceSnapshot,
} from "../protocol/model.js";
import { validateSnapshot } from "../protocol/validation.js";

export const STATIC_FIXTURE_NOW = "2026-09-02T00:00:00.000Z";
export const STATIC_FIXTURE_SESSION_KEY = deriveSessionKey(
  "pi-project-glance-static-fixture",
);
export const STATIC_FIXTURE_LONG_FEED_COUNT = 42;

export function createStaticSnapshot(
  sessionKey = STATIC_FIXTURE_SESSION_KEY,
  now = STATIC_FIXTURE_NOW,
  generationIndex = 0,
  longFeed = false,
): ProjectGlanceSnapshot {
  const changed = generationIndex > 0;
  const defaultFeed: ProjectGlanceFeedItem[] = [
    {
      id: generationIndex === 0 ? "fixture-relay-handshake" : `fixture-relay-handshake-${generationIndex}`,
      type: "assistant_update",
      text: changed
        ? `Generation ${generationIndex + 1} supplied the replacement snapshot.`
        : "The local versioned relay handshake succeeded.",
      createdAt: now,
    },
    {
      id: generationIndex === 0 ? "fixture-unconnected-sources" : `fixture-unconnected-sources-${generationIndex}`,
      type: "assistant_update",
      text: "Todo, Workplan, and session-message sources are not connected in this foundation slice.",
      createdAt: now,
    },
  ];
  const feed = longFeed
    ? Array.from({ length: STATIC_FIXTURE_LONG_FEED_COUNT }, (_, index) => ({
        id: `fixture-long-${generationIndex}-${index + 1}`,
        type: "assistant_update" as const,
        text:
          index === 0
            ? changed
              ? `Generation ${generationIndex + 1} changed this visible long-feed value without appending duplicate items.`
              : "Long-feed fixture item 1 keeps the Progress Feed scrollable."
            : index === 1
              ? "Unicode width check: 日本語 · café · 👩‍💻 · é remains terminal-column safe."
              : index === 2
                ? `Long unbroken text ${"x".repeat(360)} tests hard wrapping without widening the pane.`
                : `Long-feed fixture item ${index + 1} is deterministic and read-only.`,
        createdAt: now,
      }))
    : defaultFeed;
  return validateSnapshot({
    protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey,
    revision: 1,
    generatedAt: now,
    current: {
      step: "Validate the Project Glance foundation",
      toward: "V1 static vertical slice",
      focus: changed
        ? `Generation ${generationIndex + 1}: apply the new revision-one snapshot`
        : "Build, link, open, focus, and reconnect",
    },
    feed,
  });
}
