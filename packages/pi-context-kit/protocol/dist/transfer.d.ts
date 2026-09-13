import { V1_PROVIDER_IDS, type ContextEventBus, type ContextScope, type ProviderId } from "./index.js";
export declare const STATE_TRANSFER_REQUEST = "context-kit:state-transfer-request:v2";
export declare const STATE_TRANSFER_RESPONSE = "context-kit:state-transfer-response:v2";
export declare const NATIVE_CHECKPOINT_ENTRY = "grounded-state-checkpoint-v1";
export declare const OWNER_BINDING_ENTRY = "context-kit:owner-binding:v1";
export declare const STATE_TRANSFER_LIMITS: Readonly<{
    providerBytes: number;
    aggregateBytes: number;
    waitMs: 5000;
    maxWaitMs: 30000;
}>;
export type StateTransferCode = "state-checkpoint-corrupt" | "state-checkpoint-pending" | "state-checkpoint-scope" | "state-checkpoint-budget";
export declare class StateTransferError extends Error {
    readonly code: StateTransferCode;
    constructor(code: StateTransferCode);
}
/** Bound traversal before cloning or native validation. Complete state only. */
export declare function boundedTransferJson(value: unknown, maxBytes: number): string;
export interface StateTransferRequest {
    version: 2;
    requestId: string;
    scope: ContextScope;
    providers: ProviderId[];
    maxBytes: number;
    deadlineMs: number;
}
export type StateTransferEntry = {
    customType: typeof NATIVE_CHECKPOINT_ENTRY;
    data: {
        version: 1;
        provider: typeof V1_PROVIDER_IDS[number];
        sourceSessionId: string;
        sourceLeafId: string | null;
        state: unknown;
    };
} | {
    customType: typeof OWNER_BINDING_ENTRY;
    data: {
        version: 1;
        provider: ProviderId;
        sourceSessionId: string;
        sourceLeafId: string | null;
        binding: unknown;
    };
};
export type StateTransferResponse = {
    version: 2;
    requestId: string;
    provider: ProviderId;
    scope: ContextScope;
} & ({
    ok: true;
    entries: StateTransferEntry[];
} | {
    ok: false;
    code: StateTransferCode;
});
/** Validate only transport, provider completeness, and source scope. Providers
 * validate native contents and binding integrity before export and restoration. */
export declare function validateTransferEntries(values: unknown, scope?: ContextScope, provider?: ProviderId, maxBytes?: number): StateTransferEntry[];
export declare function registerStateTransferProvider(events: ContextEventBus, provider: ProviderId, capture: (request: StateTransferRequest, signal: AbortSignal) => StateTransferEntry[] | Promise<StateTransferEntry[]>, getScope: () => ContextScope | undefined): () => void;
/** Collect every requested owner before replacement. Timeout/cancellation never
 * authorizes partial state. A deadline stops waiting, not an uncooperative peer. */
export declare function captureStateTransfer(events: ContextEventBus, getScope: () => ContextScope, options: {
    providers: ProviderId[];
    waitMs?: number;
    signal?: AbortSignal;
}): Promise<StateTransferEntry[]>;
