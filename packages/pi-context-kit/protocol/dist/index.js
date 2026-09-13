/** Versioned, current-state data exchange. Importing this module starts no resources. */
export const V1_PROVIDER_IDS = Object.freeze(["todo", "notes", "workplan"]);
export const PROVIDER_IDS = Object.freeze([...V1_PROVIDER_IDS, "memory"]);
export const V1_CATEGORIES = Object.freeze(["task", "note", "plan", "decision", "constraint", "blocker"]);
export const CATEGORIES = Object.freeze([...V1_CATEGORIES, "knowledge", "proposal"]);
export const DEFAULT_LIMITS = Object.freeze({ records: 6, scan: 128, bytes: 8192, waitMs: 150, outputBytes: 16384 });
export const HARD_LIMITS = Object.freeze({ records: 16, scan: 512, bytes: 16384, waitMs: 1000, outputBytes: 32768, queryBytes: 512 });
export const nativeTool = (provider) => provider === "memory" ? "memory_get" : provider;
export const requestChannel = (provider, version = provider === "memory" ? 2 : 1) => `context-kit:request:v${version}:${provider}`;
export const responseChannel = (provider, version = provider === "memory" ? 2 : 1) => `context-kit:response:v${version}:${provider}`;
export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
function fail() { throw new Error("Invalid Context Kit data"); }
function object(value, required, optional = []) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail();
    const keys = Object.keys(value);
    if (keys.some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !Object.hasOwn(value, key)))
        fail();
    return value;
}
function integer(value, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        fail();
    return value;
}
function text(value, maxBytes, empty = false) {
    if (typeof value !== "string" || (!empty && !value.length) || value.length > maxBytes || Buffer.byteLength(value, "utf8") > maxBytes)
        fail();
    return value;
}
function member(value, values) {
    if (typeof value !== "string" || !values.includes(value))
        fail();
    return value;
}
/** Copies only bounded plain data. No getters, toJSON, or provider methods are invoked.
 * This is not a sandbox: proxies and synchronous event handlers still share Pi's process.
 */
export function copyPlainData(value, maxBytes) {
    let remaining = maxBytes;
    let nodes = 0;
    const charge = (count) => { remaining -= count; if (remaining < 0)
        fail(); };
    const visit = (item, depth) => {
        if (++nodes > 4096 || depth > 10)
            fail();
        if (item === null || typeof item === "boolean") {
            charge(5);
            return item;
        }
        if (typeof item === "number") {
            if (!Number.isFinite(item))
                fail();
            charge(32);
            return item;
        }
        if (typeof item === "string") {
            if (item.length > maxBytes)
                fail();
            charge(Buffer.byteLength(JSON.stringify(item), "utf8"));
            return item;
        }
        if (!item || typeof item !== "object")
            fail();
        const proto = Object.getPrototypeOf(item);
        if (Array.isArray(item)) {
            if (proto !== Array.prototype || item.length > 512)
                fail();
            const out = [];
            charge(2 + item.length);
            for (let index = 0; index < item.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                if (!descriptor || !("value" in descriptor))
                    fail();
                out.push(visit(descriptor.value, depth + 1));
            }
            // Reject extra properties and symbols, including hidden accessors.
            if (Reflect.ownKeys(item).length !== item.length + 1)
                fail();
            return out;
        }
        if (proto !== Object.prototype && proto !== null)
            fail();
        const out = {};
        let count = 0;
        charge(2);
        for (const key in item) {
            if (++count > 32 || key === "__proto__" || key === "constructor" || key === "prototype")
                fail();
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!descriptor || !("value" in descriptor))
                fail();
            charge(Buffer.byteLength(JSON.stringify(text(key, 64)), "utf8") + 2);
            out[key] = visit(descriptor.value, depth + 1);
        }
        if (Reflect.ownKeys(item).length !== count)
            fail();
        return out;
    };
    return visit(value, 0);
}
export function validateScope(value) {
    const scope = object(copyPlainData(value, 1024), ["sessionId", "leafId"]);
    text(scope.sessionId, 128);
    if (scope.leafId !== null)
        text(scope.leafId, 128);
    return scope;
}
export function sameScope(a, b) {
    return a.sessionId === b.sessionId && a.leafId === b.leafId;
}
export function validateRequest(value) {
    const request = object(copyPlainData(value, 4096), ["version", "requestId", "providerId", "scope", "query", "categories", "limits", "deadlineMs"]);
    if (request.version !== 1 && request.version !== 2)
        fail();
    text(request.requestId, 128);
    member(request.providerId, request.version === 1 ? V1_PROVIDER_IDS : PROVIDER_IDS);
    request.scope = validateScope(request.scope);
    text(request.query, HARD_LIMITS.queryBytes, true);
    if (!Array.isArray(request.categories) || request.categories.length > CATEGORIES.length)
        fail();
    request.categories.forEach((category) => member(category, request.version === 1 ? V1_CATEGORIES : CATEGORIES));
    if (new Set(request.categories).size !== request.categories.length)
        fail();
    const limits = object(request.limits, ["records", "scan", "bytes"]);
    integer(limits.records, 1, HARD_LIMITS.records);
    integer(limits.scan, 1, HARD_LIMITS.scan);
    integer(limits.bytes, 2048, HARD_LIMITS.bytes);
    integer(request.deadlineMs, 0, Number.MAX_SAFE_INTEGER);
    return request;
}
function validateCard(value, providerId, version) {
    const card = object(value, ["id", "revision", "status", "category", "title", "text", "omittedFields", "recovery"], version === 1 ? ["relations"] : ["relations", "visibility"]);
    text(card.id, 128);
    text(card.revision, 128);
    text(card.status, 32);
    text(card.title, 256, true);
    text(card.text, 2048, true);
    member(card.category, version === 1 ? V1_CATEGORIES : CATEGORIES);
    if (card.visibility !== undefined) {
        if (version !== 2 || providerId !== "memory")
            fail();
        const visibility = object(card.visibility, ["kind", "namespaceId", "branchBehavior"]);
        if (visibility.kind !== "logical_session" || visibility.branchBehavior !== "shared")
            fail();
        text(visibility.namespaceId, 128);
    }
    if (!Array.isArray(card.omittedFields) || card.omittedFields.length > 16)
        fail();
    card.omittedFields.forEach((field) => text(field, 64));
    const recovery = object(card.recovery, ["tool", "args"]);
    if (recovery.tool !== nativeTool(providerId))
        fail();
    if (providerId === "todo") {
        if (object(recovery.args, ["action"]).action !== "list")
            fail();
    }
    else if (providerId === "notes") {
        const args = object(recovery.args, ["action", "id"]);
        if (args.action !== "read" || args.id !== card.id)
            fail();
    }
    else if (providerId === "workplan") {
        const args = object(recovery.args, ["action", "planId"]);
        if (args.action !== "recover" || args.planId !== card.id)
            fail();
    }
    else {
        if (version !== 2)
            fail();
        const args = object(recovery.args, ["memoryId"], ["revision"]);
        if (args.memoryId !== card.id || (args.revision !== undefined && args.revision !== card.revision))
            fail();
    }
    if (card.relations !== undefined) {
        if (!Array.isArray(card.relations) || card.relations.length > 8)
            fail();
        for (const relation of card.relations) {
            const link = object(relation, ["type", "providerId", "id"]);
            member(link.type, version === 1 ? ["blocked_by", "linked_todo"] : ["blocked_by", "linked_todo", "supports", "contradicts", "supersedes", "derived_from"]);
            member(link.providerId, version === 1 ? V1_PROVIDER_IDS : PROVIDER_IDS);
            text(link.id, 128);
        }
    }
    return card;
}
function validatePage(value, request) {
    const page = object(value, ["readiness", "coverage", "cards"]);
    member(page.readiness, ["ready", "unavailable", "pending", "corrupt", "scope_changed"]);
    const coverage = object(page.coverage, ["scanned", "matched", "excluded", "scanComplete"]);
    integer(coverage.scanned, 0, request.limits.scan);
    integer(coverage.matched, 0, coverage.scanned);
    integer(coverage.excluded, 0, coverage.matched);
    if (typeof coverage.scanComplete !== "boolean" || !Array.isArray(page.cards) || page.cards.length > HARD_LIMITS.records)
        fail();
    page.cards.forEach((card) => {
        const valid = validateCard(card, request.providerId, request.version);
        if (request.categories.length && !request.categories.includes(valid.category))
            fail();
    });
    if (coverage.matched !== page.cards.length + coverage.excluded)
        fail();
    if (page.readiness !== "ready" && (page.cards.length || coverage.scanned || coverage.matched || coverage.scanComplete))
        fail();
    return page;
}
function envelope(request) {
    return { version: request.version, requestId: request.requestId, providerId: request.providerId, scope: { ...request.scope } };
}
/** Remove whole cards until both record and complete wire-byte budgets fit. */
export function fitProviderPage(request, value) {
    const page = validatePage(copyPlainData(value, 65536), request);
    while (page.cards.length > request.limits.records || jsonBytes({ ...envelope(request), ...page }) > request.limits.bytes) {
        if (!page.cards.length)
            fail();
        page.cards.pop();
        page.coverage.excluded++;
    }
    return page;
}
export function validateResponse(value, request) {
    // Conservative structural accounting has a separate ceiling from exact wire bytes.
    const response = object(copyPlainData(value, HARD_LIMITS.bytes * 2), ["version", "requestId", "providerId", "scope"], ["readiness", "coverage", "cards", "error"]);
    if (response.version !== request.version || response.requestId !== request.requestId || response.providerId !== request.providerId || !sameScope(validateScope(response.scope), request.scope))
        fail();
    if (jsonBytes(response) > request.limits.bytes)
        fail();
    if (Object.hasOwn(response, "error")) {
        object(response, ["version", "requestId", "providerId", "scope", "error"]);
        member(response.error, ["provider_error", "malformed", "response_budget"]);
    }
    else {
        const page = validatePage({ readiness: response.readiness, coverage: response.coverage, cards: response.cards }, request);
        if (page.cards.length > request.limits.records)
            fail();
    }
    return response;
}
/** Register explicitly, then remove the listener on provider shutdown. No archive reads here. */
export function registerContextProvider(events, providerId, read) {
    member(providerId, PROVIDER_IDS);
    let active = true;
    const versions = providerId === "memory" ? [2] : [1, 2];
    const removers = versions.map((version) => events.on(requestChannel(providerId, version), (raw) => {
        let request;
        try {
            request = validateRequest(raw);
        }
        catch {
            return;
        }
        const remaining = request.deadlineMs - Date.now();
        if (!active || request.version !== version || request.providerId !== providerId || remaining < 0 || remaining > HARD_LIMITS.waitMs)
            return;
        Object.freeze(request.scope);
        Object.freeze(request.limits);
        Object.freeze(request.categories);
        Object.freeze(request);
        const emit = (body) => {
            if (!active || Date.now() > request.deadlineMs)
                return;
            try {
                events.emit(responseChannel(providerId, version), { ...envelope(request), ...body });
            }
            catch { /* A peer cannot fail the provider. */ }
        };
        // Defer each provider independently. Timers cannot interrupt synchronous work.
        void Promise.resolve().then(() => read(request)).then((page) => {
            if (!active || Date.now() > request.deadlineMs)
                return;
            try {
                emit(fitProviderPage(request, page));
            }
            catch {
                emit({ error: "malformed" });
            }
        }, () => emit({ error: "provider_error" }));
    }));
    return () => { active = false; for (const remove of removers)
        remove(); };
}
