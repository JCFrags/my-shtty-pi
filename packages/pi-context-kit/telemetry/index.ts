import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { add, Meter, QUALITY_EVENT } from "./model.ts";
import { LocalWriter } from "./storage.ts";

export { QUALITY_EVENT, type QualityObservation } from "./model.ts";

/** The factory only registers. It does not open files, start timers, or request a model turn. */
export default function telemetry(pi: ExtensionAPI): void {
  let active: { meter: Meter; writer: LocalWriter; timer: ReturnType<typeof setInterval> } | undefined;
  let last: ReturnType<typeof snapshot> | undefined;
  let unsubscribe: (() => void) | undefined;
  let startupFailed = false;
  function snapshot() {
    return active ? { active: true, ...active.meter.snapshot(), storage: active.writer.snapshot() } : undefined;
  }
  function status() {
    return snapshot() ?? last ?? { version: 1, active: false, quality: { state: "unknown" },
      storage: { state: startupFailed ? "failed" : "idle", error: startupFailed ? "startup_failed" : "none" } };
  }
  function safely(action: (meter: Meter) => void): void {
    if (!active) return;
    try { action(active.meter); }
    catch { active.meter.runtime.observationErrors = add(active.meter.runtime.observationErrors); }
  }
  function sample(): void {
    safely(meter => { const memory = process.memoryUsage(); meter.sample(memory.rss, memory.heapUsed); });
  }
  async function stop(): Promise<void> {
    if (!active) return;
    const previous = active;
    clearInterval(previous.timer);
    unsubscribe?.();
    unsubscribe = undefined;
    safely(meter => meter.boundary());
    last = { active: false, ...previous.meter.snapshot(), storage: previous.writer.snapshot() };
    active = undefined;
    await previous.writer.stop();
    // Do not replace a newer session's status when a bounded shutdown completes late.
    if (!active && last?.run === previous.meter.run) {
      last = { active: false, ...previous.meter.snapshot(), storage: previous.writer.snapshot() };
    }
  }

  pi.registerTool({
    name: "telemetry_status",
    label: "Telemetry status",
    description: "Read bounded local runtime metrics and separate, caller-reported quality observations. Does not read source history or measure accuracy. No observations means unknown.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const result = status();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
  pi.registerCommand("context-telemetry", {
    description: "Show content-free runtime and quality metrics for this loaded session",
    async handler(_args, ctx) { ctx.ui.notify(JSON.stringify(status(), null, 2), "info"); },
  });
  pi.on("session_start", () => {
    // A repeated start is safe even if a host omitted its preceding shutdown.
    void stop().catch(() => undefined);
    last = undefined;
    try {
      startupFailed = false;
      const writer = new LocalWriter();
      const meter = new Meter(record => writer.enqueue(record));
      const timer = setInterval(sample, 30_000);
      timer.unref();
      active = { meter, writer, timer };
      unsubscribe = pi.events.on(QUALITY_EVENT, value => safely(current => current.observe(value)));
      sample();
    } catch {
      startupFailed = true;
      safely(meter => { meter.runtime.observationErrors = add(meter.runtime.observationErrors); });
    }
  });
  pi.on("session_shutdown", async () => { try { await stop(); } catch { /* Observation must not fail shutdown. */ } });
  pi.on("session_tree", event => safely(meter => {
    meter.boundary();
    if (event.summaryEntry) meter.usage("branch_summary", event.summaryEntry.usage);
  }));
  pi.on("agent_start", () => safely(meter => {
    meter.abandon("turn");
    meter.abandon("tool");
    meter.begin("agent", "active");
  }));
  pi.on("agent_end", () => safely(meter => {
    meter.finish("agent", "active", "ended");
    meter.abandon("turn");
    meter.abandon("tool");
  }));
  pi.on("agent_settled", () => safely(meter => meter.settled()));
  pi.on("turn_start", event => safely(meter => {
    if (Number.isSafeInteger(event.turnIndex) && event.turnIndex >= 0) meter.begin("turn", String(event.turnIndex));
  }));
  pi.on("turn_end", event => safely(meter => {
    if (Number.isSafeInteger(event.turnIndex) && event.turnIndex >= 0) meter.finish("turn", String(event.turnIndex), "ended");
  }));
  pi.on("tool_execution_start", event => safely(meter => {
    if (typeof event.toolCallId === "string") meter.begin("tool", event.toolCallId);
  }));
  pi.on("tool_execution_end", event => safely(meter => {
    if (typeof event.toolCallId === "string") meter.finish("tool", event.toolCallId, event.isError ? "failed" : "succeeded");
  }));
  pi.on("message_end", event => safely(meter => {
    const message = event.message;
    if (message.role === "assistant") meter.usage("assistant", message.usage);
    else if (message.role === "toolResult") meter.usage("tool", message.usage);
  }));
  pi.on("session_before_compact", event => safely(meter => {
    meter.begin("compaction", "active", event.reason, event.willRetry);
  }));
  pi.on("session_compact", event => safely(meter => {
    if (meter.finish("compaction", "active", "succeeded", event.reason, event.willRetry)) {
      meter.usage("compaction", event.compactionEntry.usage);
    }
  }));
  pi.on("session_compact_failed", event => safely(meter => {
    meter.finish("compaction", "active", event.aborted ? "aborted" : "failed", event.reason, event.willRetry);
  }));
}
