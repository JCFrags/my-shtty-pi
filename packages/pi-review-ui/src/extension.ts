import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { connectPreviewAdapters, PreviewAdapterRegistry } from "./adapter.js";
import { ReviewCoordinator } from "./coordinator.js";

const extension: ExtensionFactory = (pi: ExtensionAPI): void => {
  const adapters = new PreviewAdapterRegistry();
  connectPreviewAdapters(pi, adapters);
  const coordinator = new ReviewCoordinator({
    resolveSemantics: (tool) => adapters.resolve(tool, pi.getAllTools()),
  });

  pi.on("turn_start", (event) => {
    coordinator.onTurnStart(event.turnIndex);
  });

  pi.on("turn_end", (event) => {
    coordinator.onTurnEnd(event.turnIndex);
  });

  pi.on("session_shutdown", (event) => {
    coordinator.onSessionBoundary(`session shutdown (${event.reason})`);
  });

  pi.on("session_before_switch", (event) => {
    coordinator.onSessionBoundary(`session switch (${event.reason})`);
  });

  pi.on("session_before_fork", () => {
    coordinator.onSessionBoundary("session fork");
  });

  pi.on("session_start", (event) => {
    coordinator.onSessionBoundary(`session start (${event.reason})`);
  });

  pi.on("resources_discover", (event) => {
    if (event.reason === "reload") {
      coordinator.onSessionBoundary("resource reload");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("edit", event)) {
      return coordinator.handleEdit(event.toolCallId, event.input, ctx);
    }
    if (isToolCallEventType("write", event)) {
      return coordinator.handleWrite(event.toolCallId, event.input, ctx);
    }
    return;
  });
};

export default extension;
