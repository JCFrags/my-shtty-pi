import { isCapsuleReadiness } from "./capsule-contract.js";
import { CapsuleShadowScheduler } from "./capsule-shadow.js";
import { runCapsuleWorker } from "./capsule-worker-client.js";
/** Construction and status reads do no I/O. Explicit scheduling remains off by
 * default. Callers must obtain an actual pinned M04 view before scheduling.
 */
export function createContainedCapsuleShadow(options = {}) {
    const workerOptions = { ...options };
    return new CapsuleShadowScheduler(async (target, signal) => {
        const response = await runCapsuleWorker(target, { ...workerOptions, signal });
        if (!response.ok)
            throw Object.assign(new Error("capsule-shadow-failed"), { code: response.code });
        if (typeof response.result.complete !== "boolean" || !isCapsuleReadiness(response.result.readiness)) {
            throw Object.assign(new Error("capsule-shadow-response-invalid"), { code: "capsule-shadow-response-invalid" });
        }
        return { complete: response.result.complete, sourceBytes: response.sourceBytes, readiness: response.result.readiness };
    });
}
//# sourceMappingURL=capsule-shadow-worker.js.map