/** Versioned, current-state data exchange. Importing this module starts no resources. */
export declare const V1_PROVIDER_IDS: readonly ["todo", "notes", "workplan"];
export declare const PROVIDER_IDS: readonly ["todo", "notes", "workplan", "memory"];
export type ProviderId = typeof PROVIDER_IDS[number];
export type ProtocolVersion = 1 | 2;
export declare const V1_CATEGORIES: readonly ["task", "note", "plan", "decision", "constraint", "blocker"];
export declare const CATEGORIES: readonly ["task", "note", "plan", "decision", "constraint", "blocker", "knowledge", "proposal"];
export type Category = typeof CATEGORIES[number];
export declare const DEFAULT_LIMITS: Readonly<{
    records: 6;
    scan: 128;
    bytes: 8192;
    waitMs: 150;
    outputBytes: 16384;
}>;
export declare const HARD_LIMITS: Readonly<{
    records: 16;
    scan: 512;
    bytes: 16384;
    waitMs: 1000;
    outputBytes: 32768;
    queryBytes: 512;
}>;
export interface ContextEventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
export interface ContextScope {
    sessionId: string;
    leafId: string | null;
}
export interface ContextRequest {
    version: ProtocolVersion;
    requestId: string;
    providerId: ProviderId;
    scope: ContextScope;
    query: string;
    categories: Category[];
    limits: {
        records: number;
        scan: number;
        bytes: number;
    };
    deadlineMs: number;
}
export type NativeRecovery = {
    tool: "todo";
    args: {
        action: "list";
    };
} | {
    tool: "notes";
    args: {
        action: "read";
        id: string;
    };
} | {
    tool: "workplan";
    args: {
        action: "recover";
        planId: string;
    };
} | {
    tool: "memory_get";
    args: {
        memoryId: string;
        revision?: string;
    };
};
export declare const nativeTool: (provider: ProviderId) => NativeRecovery["tool"];
export interface ContextVisibility {
    kind: "logical_session";
    namespaceId: string;
    branchBehavior: "shared";
}
export interface ContextCard {
    id: string;
    revision: string;
    status: string;
    category: Category;
    title: string;
    text: string;
    omittedFields: string[];
    recovery: NativeRecovery;
    relations?: {
        type: "blocked_by" | "linked_todo" | "supports" | "contradicts" | "supersedes" | "derived_from";
        providerId: ProviderId;
        id: string;
    }[];
    visibility?: ContextVisibility;
}
export interface ProviderPage {
    readiness: "ready" | "unavailable" | "pending" | "corrupt" | "scope_changed";
    coverage: {
        scanned: number;
        matched: number;
        excluded: number;
        scanComplete: boolean;
    };
    cards: ContextCard[];
}
export type ResponseEnvelope = Pick<ContextRequest, "version" | "requestId" | "providerId" | "scope">;
export type ContextResponse = ResponseEnvelope & (ProviderPage | {
    error: "provider_error" | "malformed" | "response_budget";
});
export declare const requestChannel: (provider: ProviderId, version?: ProtocolVersion) => string;
export declare const responseChannel: (provider: ProviderId, version?: ProtocolVersion) => string;
export declare const jsonBytes: (value: unknown) => number;
/** Copies only bounded plain data. No getters, toJSON, or provider methods are invoked.
 * This is not a sandbox: proxies and synchronous event handlers still share Pi's process.
 */
export declare function copyPlainData(value: unknown, maxBytes: number): unknown;
export declare function validateScope(value: unknown): ContextScope;
export declare function sameScope(a: ContextScope, b: ContextScope): boolean;
export declare function validateRequest(value: unknown): ContextRequest;
/** Remove whole cards until both record and complete wire-byte budgets fit. */
export declare function fitProviderPage(request: ContextRequest, value: ProviderPage): ProviderPage;
export declare function validateResponse(value: unknown, request: ContextRequest): ContextResponse;
/** Register explicitly, then remove the listener on provider shutdown. No archive reads here. */
export declare function registerContextProvider(events: ContextEventBus, providerId: ProviderId, read: (request: ContextRequest) => ProviderPage | Promise<ProviderPage>): () => void;
