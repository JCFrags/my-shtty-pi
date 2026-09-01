/**
 * Report Pi tools that are waiting for user input as Herdr's semantic
 * `blocked` state. Herdr's managed integration consumes the shared
 * `herdr:blocked` event; this companion stays separate so integration
 * upgrades cannot overwrite it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKING_TOOLS = new Map<string, string>([
  ["ask_user_question", "Waiting for your answer"],
]);

export default function herdrBlockedBridge(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== "1") return;

  const activeCalls = new Set<string>();

  const release = (toolCallId: string) => {
    if (!activeCalls.delete(toolCallId)) return;
    pi.events.emit("herdr:blocked", { active: false });
  };

  pi.on("tool_execution_start", (event) => {
    const label = BLOCKING_TOOLS.get(event.toolName);
    if (!label || activeCalls.has(event.toolCallId)) return;
    activeCalls.add(event.toolCallId);
    pi.events.emit("herdr:blocked", { active: true, label });
  });

  pi.on("tool_execution_end", (event) => {
    release(event.toolCallId);
  });

  pi.on("session_shutdown", () => {
    for (const toolCallId of [...activeCalls]) release(toolCallId);
  });
}
