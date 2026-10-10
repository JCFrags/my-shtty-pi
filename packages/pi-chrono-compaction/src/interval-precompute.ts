import { createHash } from "node:crypto";
import { HistoryHelperService, type HistoryHelperArtifact, type HistoryHelperInput,
  type HistoryHelperModel, type HistoryHelperTicket, type HistoryHelperResult } from "./history-helper.js";

/** Pin S/H independently of E. The source adapter must re-project originals if
 * H advances. This class never accepts an old synopsis plus a delta. */
export class IntervalPrefixPrecompute {
  private current: { input: HistoryHelperInput; ticket: HistoryHelperTicket; scope: string; state: HistoryHelperResult["status"] | "pending" } | undefined;
  constructor(readonly service: HistoryHelperService) {
    if (service.lane !== "restart") throw new Error("history-prefix-lane-invalid");
  }
  prepare(input: HistoryHelperInput, model: HistoryHelperModel | undefined, signal?: AbortSignal): HistoryHelperTicket {
    if (input.role !== "activePrefix") throw new Error("history-prefix-role-invalid");
    const scope = createHash("sha256").update(JSON.stringify([input.source.logicalSession, input.source.branch,
      input.source.previousCommit, input.source.start, "active-prefix"])).digest("hex");
    if (this.current && (!model || this.current.scope !== scope)) this.current.ticket.cancel();
    const ticket = this.service.enqueue(input, model, { coalesceKey: scope, signal });
    const current = { input, ticket, scope, state: "pending" as HistoryHelperResult["status"] | "pending" };
    this.current = current;
    void ticket.settled.then(result => { current.state = result.status; });
    return ticket;
  }
  /** Final assembly reads a ready exact-range result or uses the compiler's
   * deterministic fallback. This method never waits for optional provider work. */
  ready(input: HistoryHelperInput): HistoryHelperArtifact | undefined {
    return input.role === "activePrefix" ? this.service.ready(input) : undefined;
  }
  invalidate(): void { this.current?.ticket.cancel(); this.current = undefined; }
  status(): { readonly state: "absent" | "pending" | "stale" | HistoryHelperResult["status"]; readonly key?: string } {
    if (!this.current) return { state: "absent" };
    const ready = this.service.ready(this.current.input);
    return { state: ready ? "ready" : this.current.state === "ready" ? "stale" : this.current.state, key: this.current.ticket.key };
  }
}
