import { createHash } from "node:crypto";
import { HistoryHelperService, historyHelperInputKey, type HistoryHelperArtifact, type HistoryHelperInput,
  type HistoryHelperModel, type HistoryHelperTicket, type HistoryHelperResult } from "./history-helper.js";
import { INTERVAL_READY_PREFIX_CANDIDATE_LIMIT } from "./interval-partition.js";

/** Pin S/H independently of E. The source adapter must re-project originals if
 * H advances. This class never accepts an old synopsis plus a delta. */
export class IntervalPrefixPrecompute {
  private current: { input: HistoryHelperInput; ticket: HistoryHelperTicket; scope: string; state: HistoryHelperResult["status"] | "pending" } | undefined;
  private readonly admitted = new Map<string, HistoryHelperInput>();
  constructor(readonly service: HistoryHelperService) {
    if (service.lane !== "restart") throw new Error("history-prefix-lane-invalid");
  }
  prepare(input: HistoryHelperInput, model: HistoryHelperModel | undefined, signal?: AbortSignal): HistoryHelperTicket {
    if (input.role !== "activePrefix") throw new Error("history-prefix-role-invalid");
    const scope = createHash("sha256").update(JSON.stringify([input.source.logicalSession, input.source.branch,
      input.source.previousCommit, input.source.start, "active-prefix"])).digest("hex");
    if (this.current && this.current.scope !== scope) this.invalidate();
    const previous = this.current;
    const ticket = this.service.enqueue(input, model, { coalesceKey: scope, signal });
    // enqueue marks queued/running replacements superseded. A cached target can
    // return before coalescing, so cancel the previous job in that case too.
    if (previous && (!model || previous.ticket.key !== ticket.key)) previous.ticket.cancel();
    // Coalescing cancels superseded jobs, not compatible already-ready ranges.
    // Retain only as many identities as the finite product cache can hold.
    if (ticket.key && model && !signal?.aborted && this.service.limits.cacheEntries > 0) {
      this.admitted.delete(ticket.key); this.admitted.set(ticket.key, input);
      while (this.admitted.size > Math.min(this.service.limits.cacheEntries, INTERVAL_READY_PREFIX_CANDIDATE_LIMIT)) this.admitted.delete(this.admitted.keys().next().value!);
    }
    const current = { input, ticket, scope, state: "pending" as HistoryHelperResult["status"] | "pending" };
    this.current = current;
    void ticket.settled.then(result => { current.state = result.status; });
    return ticket;
  }
  /** Final assembly reads a ready exact-range result or uses the compiler's
   * deterministic fallback. This method never waits for optional provider work. */
  ready(input: HistoryHelperInput): HistoryHelperArtifact | undefined {
    return input.role === "activePrefix" && this.admitted.has(historyHelperInputKey(input)) ? this.service.ready(input) : undefined;
  }
  /** The caller must reproject each pinned range against current originals,
   * disclosure and derivation before choosing it. No provider work is awaited. */
  candidates(): readonly { readonly input: HistoryHelperInput; readonly artifact: HistoryHelperArtifact }[] {
    const products: { input: HistoryHelperInput; artifact: HistoryHelperArtifact }[] = [];
    for (const input of this.admitted.values()) {
      const artifact = this.service.ready(input);
      if (artifact) products.push(Object.freeze({ input, artifact }));
    }
    return Object.freeze(products);
  }
  pause(): void { this.current?.ticket.cancel(); this.current = undefined; }
  invalidate(): void { this.pause(); this.admitted.clear(); }
  status(): { readonly state: "absent" | "pending" | "stale" | HistoryHelperResult["status"]; readonly key?: string } {
    if (!this.current) return { state: "absent" };
    const ready = this.service.ready(this.current.input);
    return { state: ready ? "ready" : this.current.state === "ready" ? "stale" : this.current.state, key: this.current.ticket.key };
  }
}
