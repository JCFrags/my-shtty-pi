import { type Category, type ContextEventBus, type ContextScope, type NativeRecovery, type ProviderId, type ProviderPage } from "./index.js";
export interface ContextLimits {
    records: number;
    scan: number;
    providerBytes: number;
    maxBytes: number;
    waitMs: number;
}
export interface ContextQuery extends Partial<ContextLimits> {
    query?: string;
    providers?: ProviderId[];
    categories?: Category[];
}
export type ProviderStatus = "ok" | "tool_inactive" | "missing_or_timeout" | "malformed" | "provider_error" | "response_budget" | "cancelled" | "scope_changed";
export interface ProviderResult {
    providerId: ProviderId;
    nativeTool: NativeRecovery["tool"];
    status: ProviderStatus;
    page?: ProviderPage;
}
export interface ContextCollection {
    version: 2;
    requestId: string;
    scope: ContextScope;
    semantics: string;
    query: string;
    categories: Category[];
    limits: ContextLimits;
    complete: boolean;
    providers: ProviderResult[];
}
export interface ContextHost {
    events: ContextEventBus;
    getActiveTools(): string[];
}
export interface ContextView {
    getScope(): ContextScope;
    epoch(): number;
    signal?: AbortSignal;
}
export declare function contextLimits(input?: Partial<ContextLimits>): ContextLimits;
export declare function parseContextQuery(value: unknown): ContextQuery;
export declare function contextToolResult(result: ContextCollection): {
    content: {
        type: "text";
        text: string;
    }[];
    details: {
        protocol: string;
    };
};
/** One bounded, detached selection through caller-owned transport. No Pi runtime,
 * native store, tool execution, activation, or context mutation is used here. */
export declare function collectContext(host: ContextHost, raw: ContextQuery, view: ContextView): Promise<ContextCollection>;
