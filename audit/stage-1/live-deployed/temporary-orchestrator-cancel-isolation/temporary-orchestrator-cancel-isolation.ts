/**
 * Temporary user-requested isolation for agent cancellation controls.
 *
 * This extension does not modify the immutable orchestrator deployment. Remove
 * this file and reload Pi to restore the normal cancellation controls.
 */

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface ToolCallEvent {
  toolName: string;
  input: unknown;
}

interface MinimalExtensionAPI {
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent) => { systemPrompt: string },
  ): void;
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
    ) => { block: true; reason: string } | undefined,
  ): void;
}

export const CANCEL_ISOLATION_MESSAGE =
  "Agent cancellation is temporarily isolated and disabled. Do not try to cancel, interrupt, or stop agents another way. Let managed agents and tasks settle naturally. You may inspect or wait for them, then collect results and close agents only after they settle.";

const ALTERNATIVE_CANCELLATION_TOOLS = new Set([
  "agent_cancel",
  "agent_interrupt",
  "agent_stop",
  "group_stop",
  "task_cancel",
]);

export default function temporaryOrchestratorCancelIsolation(
  pi: MinimalExtensionAPI,
): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nTemporary orchestration policy: ${CANCEL_ISOLATION_MESSAGE}`,
  }));

  pi.on("tool_call", (event) => {
    const isFacadeCancel =
      event.toolName === "orchestrate" &&
      typeof event.input === "object" &&
      event.input !== null &&
      (event.input as { action?: unknown }).action === "cancel";

    if (!isFacadeCancel && !ALTERNATIVE_CANCELLATION_TOOLS.has(event.toolName)) {
      return;
    }

    return {
      block: true,
      reason: CANCEL_ISOLATION_MESSAGE,
    };
  });
}
