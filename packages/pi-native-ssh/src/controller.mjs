import { randomUUID } from "node:crypto";
import { fail } from "./protocol.mjs";

const CUSTOM_TYPE = "pi-native-ssh-state";
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const freshLocal = () => Object.freeze({ version: 2, mode: "local", target: null, generation: randomUUID(), updatedAt: Date.now() });
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function decodeState(raw, configuredTargets) {
  if (!exact(raw, ["version", "mode", "target", "generation", "updatedAt"]) || raw.version !== 2 || !GENERATION.test(raw.generation) || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0 || raw.updatedAt > Date.now() + 300_000) return freshLocal();
  if (raw.mode === "local" && raw.target === null) return Object.freeze({ ...raw });
  if (raw.mode !== "remote" || !exact(raw.target, ["name", "destination", "displayName", "cwd", "authorization"])) return freshLocal();
  const configured = configuredTargets[raw.target.name];
  if (!configured || raw.target.destination !== configured.destination || raw.target.displayName !== configured.displayName || raw.target.authorization !== "openssh-and-remote-account" || typeof raw.target.cwd !== "string" || !raw.target.cwd.startsWith("/") || raw.target.cwd.length > 4096 || raw.target.cwd.includes("\0")) return freshLocal();
  return Object.freeze({ ...raw, target: Object.freeze({ ...raw.target }) });
}

export class Controller {
  constructor(pi, config) { this.pi = pi; this.config = config; this.state = freshLocal(); this.health = "ready"; this.errorCode = null; this.leases = new Map(); this.context = null; this.manager = null; this.epoch = 0; }
  sessionStart(ctx) { this.#abortAll(); this.epoch++; this.context = ctx; this.manager = ctx.sessionManager; this.state = freshLocal(); this.health = "ready"; this.errorCode = null; this.#render(); }
  sessionShutdown() { this.#abortAll(); this.context = null; this.manager = null; this.epoch++; this.state = freshLocal(); }
  restore(ctx) { this.#abortAll(); this.epoch++; this.context = ctx; this.manager = ctx.sessionManager; const entry = [...ctx.sessionManager.getBranch()].reverse().find(item => item.type === "custom" && item.customType === CUSTOM_TYPE); this.state = ctx.hasUI ? decodeState(entry?.data, this.config.targets) : freshLocal(); this.health = this.state.mode === "remote" ? "error" : "ready"; this.errorCode = this.state.mode === "remote" ? "RECOVERY_REQUIRED" : null; this.#render(); }
  use(name, cwd, ctx) {
    if (!ctx.hasUI) throw fail("REMOTE_STATE_MISMATCH", "Remote activation requires a visible status channel", { routeAffecting: true });
    const configured = this.config.targets[name]; if (!configured) throw fail("TARGET_INVALID", "Target is not configured");
    const remoteCwd = cwd || configured.defaultCwd; if (typeof remoteCwd !== "string" || !remoteCwd.startsWith("/") || remoteCwd.length > 4096 || remoteCwd.includes("\0")) throw fail("TARGET_INVALID", "Remote cwd is invalid");
    this.#abortAll(); this.epoch++; this.context = ctx; this.manager = ctx.sessionManager;
    this.state = Object.freeze({ version: 2, mode: "remote", target: Object.freeze({ name, destination: configured.destination, displayName: configured.displayName, cwd: remoteCwd, authorization: "openssh-and-remote-account" }), generation: randomUUID(), updatedAt: Date.now() });
    this.health = "ready"; this.errorCode = null; this.#render(); this.pi.appendEntry(CUSTOM_TYPE, this.state); return this.status();
  }
  clear(ctx) { this.#abortAll(); this.epoch++; this.context = ctx; this.manager = ctx.sessionManager; this.state = freshLocal(); this.health = "ready"; this.errorCode = null; this.#render(); this.pi.appendEntry(CUSTOM_TYPE, this.state); return this.status(); }
  markRecovered(ctx) { this.context = ctx; this.health = "ready"; this.errorCode = null; this.#render(); }
  markError(code, ctx) { if (ctx && ctx === this.context && this.state.mode === "remote") { this.health = "error"; this.errorCode = code; this.#render(); } }
  status() { return { mode: this.state.mode, target: this.state.target ? { ...this.state.target } : null, generation: this.state.generation, backend: this.state.mode === "remote" ? "native-ssh" : "local", health: this.health, activeOperations: this.leases.size, userBang: "local" }; }
  begin(operation, signal, ctx) {
    if (ctx.sessionManager !== this.manager || this.state.mode !== "remote" || !this.state.target || !ctx.hasUI) throw fail("REMOTE_STATE_MISMATCH", "Remote context does not match current visible routing", { routeAffecting: true });
    if (this.health === "error") throw fail("REMOTE_STATE_MISMATCH", `Remote route is in error state (${this.errorCode ?? "UNKNOWN"}); use /remote recover or clear`, { routeAffecting: true });
    const id = randomUUID(); const controller = new AbortController(); const onAbort = () => controller.abort(); if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", onAbort, { once: true });
    const lease = { id, operation, generation: this.state.generation, target: this.state.target, epoch: this.epoch, ctx, controller, signal, onAbort }; this.leases.set(id, lease); this.#render(); return lease;
  }
  end(lease, error = null) { lease.signal?.removeEventListener("abort", lease.onAbort); this.leases.delete(lease.id); const stale = lease.epoch !== this.epoch || lease.ctx.sessionManager !== this.manager || this.state.mode !== "remote" || this.state.generation !== lease.generation; if (error?.routeAffecting && !stale) this.markError(error.code, this.context); else if (!stale) this.#render(); if (stale) throw fail("TARGET_STALE", "Remote target changed while the operation was active", { routeAffecting: true }); }
  #abortAll() { for (const lease of this.leases.values()) lease.controller.abort(); this.leases.clear(); }
  #render() { if (!this.context) return; let text = "LOCAL"; if (this.state.mode === "remote") text = this.health === "error" ? `REMOTE: ${this.state.target.displayName} [stale/error: ${this.errorCode}]` : this.leases.size ? `REMOTE: ${this.state.target.displayName} [busy:${this.leases.size}]` : `REMOTE: ${this.state.target.displayName} [native SSH]`; this.context.ui.setStatus("native-ssh", text); this.context.ui.setWidget("native-ssh", this.state.mode === "remote" ? ["REMOTE NATIVE SSH: ls and ssh_transfer use the selected configured host. Local search remains under Grounded local_search.", "Other core file and process routes remain unchanged until Grounded Session Service provider integration. User ! commands stay LOCAL."] : undefined, { placement: "belowEditor" }); }
}
