export function contextMessage(text: string) {
  return { role: "custom" as const, customType: "grounded-workplan-context", content: text, display: false, timestamp: 0 };
}

export function latestVisibleRecovery(messages: readonly unknown[]): { planId: string; revision: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const candidate = message as Record<string, unknown>;
    if (candidate.role !== "toolResult" || candidate.toolName !== "workplan") continue;
    const details = candidate.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const recovery = (details as Record<string, unknown>).recovery;
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) continue;
    const value = recovery as Record<string, unknown>;
    if (typeof value.planId === "string" && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1) {
      return { planId: value.planId, revision: value.revision as number };
    }
  }
  return undefined;
}
