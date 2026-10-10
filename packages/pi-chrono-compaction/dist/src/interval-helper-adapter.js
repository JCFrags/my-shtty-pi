import { createHash } from "node:crypto";
import { HISTORY_HELPER_PROMPT_IDENTITY, historyHelperInputKey, makeHistoryOriginalParts, validateHistoryHelperInput } from "./history-helper.js";
import { projectIntervalSource } from "./interval-source.js";
import { historySynopsisCompatibilityItems, validateHistorySynopsis } from "./history-synopsis.js";
export const INTERVAL_HELPER_ADAPTER_IDENTITY = "chrono-original-field-adapter-v2";
export const INTERVAL_HELPER_OUTPUT_POLICY = "chrono-range-synopsis-and-event-alternatives-v2";
export const DEFAULT_INTERVAL_HELPER_DISCLOSURE = Object.freeze({
    identity: "chrono-history-disclosure-consented-originals-v1", allowUserInterpretation: true, allowToolArguments: true,
});
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const hash = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const textHash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fail(code) { throw Object.assign(new Error(`interval-helper-${code}`), { code: `interval-helper-${code}` }); }
function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
function outcome(event) {
    const message = object(event.projectedEntry.message);
    if (event.toolResult)
        return event.toolResult.isError === true ? "reported-error" : event.toolResult.isError === false ? "reported-success" : "result-outcome-unknown";
    if (message?.stopReason === "aborted" || message?.cancelled === true)
        return "cancelled-attempt";
    if (message?.stopReason === "error")
        return "reported-error";
    return event.role === "user" ? "user-statement-not-observed-result" : "reported-assistant-work";
}
function protectedField(event, field) {
    const entry = event.projectedEntry, message = object(entry.message), details = object(message?.details);
    const flags = [entry, message, details];
    const index = /^message\.content\.(\d+)\./u.exec(field)?.[1];
    if (index && Array.isArray(message?.content))
        flags.push(object(message.content[Number(index)]));
    return flags.some(item => item?.protectedExact === true || item?.protected === true || item?.private === true);
}
// Conservative exclusion, not a complete secret detector. Caller disclosure policy remains required.
function credentialField(text) {
    return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}|\b(?:api[_-]?key|access[_-]?token|password|authorization|cookie)["']?\s*[=:]\s*["']?[^\s,;]+/iu.test(text);
}
/** Text and JSON-value encodings are exact source-field serializations, not reduced renderings. */
function fields(event) {
    const entry = event.projectedEntry, message = object(entry.message), content = message?.content ?? entry.content;
    const base = message ? "message.content" : "content";
    const role = event.role === "user" ? "user" : event.role === "toolResult" || event.role === "bashExecution" ? "tool" : "assistant";
    const purpose = role === "user" ? "interpretation" : "output";
    const result = [];
    if (typeof content === "string")
        result.push({ field: base, text: content, role, purpose });
    if (Array.isArray(content))
        content.forEach((item, index) => {
            const block = object(item);
            if (block?.type === "text" && typeof block.text === "string")
                result.push({ field: `${base}.${index}.text`, text: block.text, role, purpose });
            if (block?.type === "toolCall") {
                const relationship = typeof block.id === "string" && typeof block.name === "string" ? { callId: block.id, toolName: block.name } : undefined;
                if (typeof block.name === "string")
                    result.push({ field: `${base}.${index}.name`, text: block.name, role: "assistant", purpose: "interpretation", relationship });
                if (object(block.arguments))
                    result.push({ field: `${base}.${index}.arguments#json`, text: JSON.stringify(block.arguments), role: "assistant", purpose: "interpretation", relationship });
            }
        });
    if (event.role === "bashExecution") {
        for (const name of ["command", "output"])
            if (typeof message?.[name] === "string") {
                result.push({ field: `message.${name}`, text: message[name], role: "tool", purpose: name === "command" ? "interpretation" : "output" });
            }
    }
    return result;
}
function originalFields(original, projected) {
    if (original.role === "custom")
        return [];
    const allowed = fields(projected), nativeContent = object(original.projectedEntry.message)?.content ?? original.projectedEntry.content;
    const projectedContent = object(projected.projectedEntry.message)?.content ?? projected.projectedEntry.content;
    // Purpose views retain allowed native block objects. Never admit a removed block
    // merely because its text equals another block or a synthesized identity notice.
    return fields(original).filter(field => {
        const index = /^(?:message\.)?content\.(\d+)\./u.exec(field.field)?.[1];
        if (index !== undefined && Array.isArray(nativeContent) && Array.isArray(projectedContent))
            return projectedContent.includes(nativeContent[Number(index)]);
        return allowed.some(item => item.field === field.field && item.text === field.text && item.role === field.role && item.purpose === field.purpose);
    });
}
function sourceEntries(events) {
    return events.map(event => [event.source, event.entryId, event.sourceHash]);
}
function entryRef(event) { return JSON.stringify([event.source, event.entryId]); }
function binding(snapshot, view, parts, notices, disclosure) {
    const first = view.events[0], last = view.events.at(-1);
    if (!first || !last)
        fail("source-scope-unavailable");
    const originAnchor = snapshot.events[0];
    const branch = snapshot.source.branchId ?? `ancestry:${hash([snapshot.origin.source, snapshot.origin.entryId, originAnchor.source, originAnchor.entryId])}`;
    return {
        logicalSession: snapshot.source.logicalSessionId ?? snapshot.source.sessionId,
        branch,
        previousCommit: snapshot.origin.entryId,
        start: JSON.stringify(["before", first.source, first.entryId]),
        // Never bind H.right or the snapshot's later E.
        endExclusive: JSON.stringify(["after", last.source, last.entryId]),
        orderedInputHash: hash(sourceEntries(view.events)),
        projectionHash: hash([view.projectionHash, disclosure, parts.map(part => [part.spans, textHash(part.text), part.purpose]), notices]),
        disclosureIdentity: disclosure,
    };
}
/** Project a legal original range. Missing or oversized input refuses without head truncation. */
export function adaptIntervalHelperInput(snapshot, options) {
    const { start, endExclusive, role } = options;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive > snapshot.events.length
        || start > endExclusive || !snapshot.legalCuts.includes(start) || !snapshot.legalCuts.includes(endExclusive)
        || snapshot.units.some(unit => unit.start < endExclusive && unit.end > start && unit.status !== "complete"))
        fail("range-invalid");
    if (start === endExclusive)
        return undefined;
    const purpose = role === "activePrefix" ? "synopsis" : role;
    const view = projectIntervalSource(snapshot, purpose, start, endExclusive);
    const disclosure = options.disclosure ?? DEFAULT_INTERVAL_HELPER_DISCLOSURE;
    if (!disclosure.identity || disclosure.identity.length > 2048)
        fail("disclosure-invalid");
    const sourceBytes = options.sourceBytes ?? 4 * 1024 * 1024, partBytes = options.partBytes ?? 8192, maxParts = options.parts ?? 512;
    const units = snapshot.units.filter(unit => unit.start >= start && unit.end <= endExclusive);
    if (role === "event" && (units.length !== 1 || !options.candidates?.length))
        fail("event-selection-invalid");
    const selectedIds = new Set(view.events.map(event => event.entryId));
    const notices = [];
    const notice = (code, ref) => { if (!notices.some(item => item.code === code && item.entryRefs.includes(ref)))
        notices.push({ code, entryRefs: [ref] }); };
    for (const item of view.exclusions)
        if (selectedIds.has(item.entryId)) {
            const event = view.events.find(entry => entry.entryId === item.entryId && same(entry.source, item.source));
            if (event)
                notice(item.reason, entryRef(event));
        }
    const parts = [];
    const unitByEvent = new Map(units.flatMap(unit => unit.eventIndexes.map(index => [index, unit])));
    for (const event of view.events) {
        const original = snapshot.events[event.index];
        const unit = unitByEvent.get(event.index);
        const sourceFields = originalFields(original, event);
        const result = original.toolResult;
        const call = result && unit.eventIndexes.flatMap(index => snapshot.events[index].toolCalls).find(item => item.id === result.callId);
        const toolName = result?.toolName ?? call?.name;
        const stateSnapshot = ["workplan", "todo", "notes"].includes(toolName ?? "")
            && ["list", "status", "read", "recover", "search"].includes(String(call?.arguments.action));
        const resultRelationship = result ? { callId: result.callId, ...(toolName ? { toolName } : {}),
            ...(stateSnapshot ? { observation: "state-snapshot" } : {}) } : undefined;
        if (!sourceFields.length && original.role === "custom")
            notice("unsupported-custom-origin", entryRef(event));
        for (const originalField of sourceFields) {
            const field = originalField.role === "user" && role !== "event" ? { ...originalField, purpose: "output" } : originalField;
            if (!field.text.length)
                continue;
            const candidates = options.candidates?.filter(item => item.unitId === unit.id && item.entryId === event.entryId && item.field === field.field) ?? [];
            if (role === "event" && field.purpose === "output" && !candidates.length)
                continue;
            if (role === "event" && field.purpose === "output" && original.role !== "toolResult")
                fail("event-selection-invalid");
            const permitted = (field.role !== "user" || disclosure.allowUserInterpretation === true)
                && (!field.field.endsWith("#json") || disclosure.allowToolArguments === true)
                && !protectedField(original, field.field) && !credentialField(field.text)
                && (!disclosure.allowField || disclosure.allowField({ event: original, ...field }));
            if (!permitted) {
                notice("disclosure-or-protected-field-excluded", entryRef(event));
                continue;
            }
            const ranges = role === "event" && field.purpose === "output" ? candidates : [{ start: 0, endExclusive: field.text.length }];
            for (const range of ranges) {
                if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.endExclusive) || range.start < 0
                    || range.endExclusive <= range.start || range.endExclusive > field.text.length)
                    fail("span-invalid");
                const candidate = range;
                if (role === "event" && field.purpose === "output"
                    && (candidate.baseline !== "deterministic-selection" || candidate.reason !== "noisy-tool-output"))
                    fail("event-selection-invalid");
                const made = makeHistoryOriginalParts({ eventId: entryRef(original), unitId: unit.id, entryRef: entryRef(original),
                    field: `${field.field}#sha256:${textHash(field.text)}`, start: range.start,
                    text: field.text.slice(range.start, range.endExclusive), role: field.role, outcome: outcome(original), purpose: field.purpose,
                    relationship: field.relationship ?? resultRelationship }, { sourceBytes, partBytes, parts: maxParts - parts.length });
                parts.push(...made);
                if (parts.length > maxParts || notices.length > maxParts)
                    fail("source-bound-exceeded");
            }
        }
    }
    if (!parts.some(part => part.purpose === "output"))
        return undefined;
    // An event alternative is an all-or-nothing exact selected replacement group.
    if (role === "event" && notices.length)
        return undefined;
    const input = {
        schemaVersion: 1, role, source: binding(snapshot, view, parts, notices, disclosure.identity),
        derivation: { modelIdentity: options.modelIdentity, promptIdentity: HISTORY_HELPER_PROMPT_IDENTITY,
            reducerIdentity: INTERVAL_HELPER_ADAPTER_IDENTITY, outputPolicyIdentity: INTERVAL_HELPER_OUTPUT_POLICY, disclosureIdentity: disclosure.identity },
        parts, notices,
        ...(role === "event" ? { eventUnit: { id: units[0].id, complete: true, outputPartIds: parts.filter(part => part.purpose === "output").map(part => part.id) } } : {}),
    };
    validateHistoryHelperInput(input, { sourceBytes, parts: maxParts });
    return freeze(input);
}
/** Optional generic log candidates only, after deterministic B range selection. */
export function selectIntervalEventCandidates(snapshot, start, endExclusive, maximumUnits = 4) {
    if (!Number.isSafeInteger(maximumUnits) || maximumUnits < 0 || maximumUnits > 32)
        fail("selection-limit-invalid");
    const view = projectIntervalSource(snapshot, "event", start, endExclusive), candidates = [];
    const selected = new Set();
    for (const unit of snapshot.units) {
        if (unit.status !== "complete" || unit.start < start || unit.end > endExclusive || selected.size >= maximumUnits)
            continue;
        for (const event of view.events.slice(unit.start - start, unit.end - start)) {
            if (!event.toolResult || event.toolResult.isError === true || !["bash", "process", "session"].includes(event.toolResult.toolName ?? ""))
                continue;
            for (const field of originalFields(snapshot.events[event.index], event).filter(item => item.purpose === "output")) {
                if (Buffer.byteLength(field.text, "utf8") < 4096 || field.text.split("\n").length < 16 || /^[\s]*[\[{]/u.test(field.text)
                    || protectedField(event, field.field) || credentialField(field.text))
                    continue;
                candidates.push({ unitId: unit.id, entryId: event.entryId, field: field.field, start: 0, endExclusive: field.text.length,
                    baseline: "deterministic-selection", reason: "noisy-tool-output" });
                selected.add(unit.id);
            }
        }
    }
    return freeze(candidates);
}
function validProduct(product) {
    try {
        validateHistoryHelperInput(product.input, { sourceBytes: 16 * 1024 * 1024, parts: 4096 });
        const { input, artifact } = product, outputs = input.parts.filter(part => part.purpose === "output");
        if (artifact.schemaVersion !== 1 || artifact.key !== historyHelperInputKey(input) || artifact.role !== input.role
            || !same(artifact.source, input.source) || !same(artifact.derivation, input.derivation) || !same(artifact.notices, input.notices)
            || artifact.coverage !== (input.notices.length ? "partial" : "full") || artifact.quality !== "structural-only"
            || !Array.isArray(artifact.items))
            return false;
        if (input.role !== "event")
            return !!artifact.synopsis && validateHistorySynopsis(artifact.synopsis, input.parts)
                && same(artifact.items, artifact.synopsis.parts.flatMap(historySynopsisCompatibilityItems));
        return artifact.synopsis === undefined && artifact.items.length === outputs.length && artifact.items.every((item, index) => {
            const part = outputs[index];
            return item.partId === part.id && item.eventId === part.eventId && item.unitId === part.unitId
                && same(item.entryRefs, part.entryRefs) && same(item.spans, part.spans) && item.outcome === part.outcome
                && typeof item.text === "string" && item.text.trim().length > 0
                && (part.protectedSpans ?? []).every(span => item.text.includes(part.text.slice(span.start, span.endExclusive)));
        });
    }
    catch {
        return false;
    }
}
/** The compiler can independently recreate the current original range and derivation. */
export function validateIntervalReadyProduct(snapshot, product, options) {
    try {
        const current = adaptIntervalHelperInput(snapshot, options);
        return !!current && validProduct(product) && historyHelperInputKey(current) === product.artifact.key;
    }
    catch {
        return false;
    }
}
function rangeEvents(view, input) {
    let begin, end;
    try {
        begin = JSON.parse(input.source.start);
        end = JSON.parse(input.source.endExclusive);
    }
    catch {
        return undefined;
    }
    const before = begin, after = end;
    if (!Array.isArray(before) || !Array.isArray(after) || before[0] !== "before" || after[0] !== "after")
        return undefined;
    const a = view.events.findIndex(event => event.entryId === before[2] && same(event.source, before[1]));
    const b = view.events.findIndex(event => event.entryId === after[2] && same(event.source, after[1]));
    if (a < 0 || b < a)
        return undefined;
    const events = view.events.slice(a, b + 1);
    return hash(sourceEntries(events)) === input.source.orderedInputHash ? events : undefined;
}
/** Revalidate the complete original event input, including unchanged interpretation fields. */
export function validateIntervalEventProduct(snapshot, product, Bstart, Bend) {
    try {
        if (!validProduct(product) || product.input.role !== "event")
            return false;
        const view = projectIntervalSource(snapshot, "event", Bstart, Bend);
        const events = rangeEvents(view, product.input);
        if (!events?.length)
            return false;
        const start = events[0].index, endExclusive = events.at(-1).index + 1;
        const unit = snapshot.units.find(item => item.id === product.input.eventUnit?.id && item.start === start && item.end === endExclusive && item.status === "complete");
        if (!unit)
            return false;
        const candidates = product.input.parts.filter(part => part.purpose === "output").flatMap(part => part.spans.map(span => {
            const event = events.find(item => entryRef(item) === span.entryRef);
            const field = /^(.*)#sha256:[a-f0-9]{64}$/u.exec(span.field)?.[1];
            if (!event || !field)
                return fail("span-invalid");
            return { unitId: unit.id, entryId: event.entryId, field, start: span.start, endExclusive: span.endExclusive,
                baseline: "deterministic-selection", reason: "noisy-tool-output" };
        }));
        return validateIntervalReadyProduct(snapshot, product, { role: "event", start, endExclusive,
            modelIdentity: product.input.derivation.modelIdentity, candidates });
    }
    catch {
        return false;
    }
}
function resolveField(event, boundField, exact) {
    const match = /^(.*)#sha256:([a-f0-9]{64})$/u.exec(boundField);
    if (!match || match[1].endsWith("#json"))
        return undefined;
    const available = fields(event).filter(item => item.purpose === "output" && textHash(item.text) === match[2]);
    if (exact)
        return available.find(item => item.field === match[1]);
    // Helper modality filtering can shift array indexes. Only an unambiguous full-field hash can remap it.
    return available.length === 1 ? available[0] : undefined;
}
function replaceText(entry, path, text) {
    const next = JSON.parse(JSON.stringify(entry));
    const steps = path.split(".");
    let target = next;
    for (const step of steps.slice(0, -1))
        target = target[step];
    target[steps.at(-1)] = text;
    return next;
}
/** Apply only exact original tool-result body spans to a B view. Never mutate sources or installed packets. */
export function applyIntervalEventAlternatives(view, alternatives) {
    if (view.purpose !== "event" || alternatives.length > 32)
        return freeze({ events: [...view.events], acceptedArtifactKeys: [] });
    const replacements = new Map();
    const keys = [];
    for (const product of alternatives) {
        if (!validProduct(product) || product.input.role !== "event" || product.input.notices.length)
            continue;
        const selected = rangeEvents(view, product.input);
        if (!selected)
            continue;
        const pending = new Map();
        let valid = true;
        for (const item of product.artifact.items) {
            const part = product.input.parts.find(source => source.id === item.partId);
            if (part.role !== "tool" || part.spans.length !== 1) {
                valid = false;
                break;
            }
            const span = part.spans[0], event = selected.find(source => entryRef(source) === span.entryRef);
            const field = event && resolveField(event, span.field, false);
            if (!event?.toolResult || !field || protectedField(event, field.field) || credentialField(field.text)
                || field.text.slice(span.start, span.endExclusive) !== part.text) {
                valid = false;
                break;
            }
            const key = JSON.stringify([event.source, event.entryId, field.field]);
            if (replacements.has(key)) {
                valid = false;
                break;
            }
            const group = pending.get(key) ?? { event, field: field.field, original: field.text, spans: [] };
            if (group.spans.some(before => span.start < before.end && before.start < span.endExclusive)) {
                valid = false;
                break;
            }
            group.spans.push({ start: span.start, end: span.endExclusive, text: item.text });
            pending.set(key, group);
        }
        if (!valid)
            continue;
        for (const [key, group] of pending)
            replacements.set(key, group);
        keys.push(product.artifact.key);
    }
    const events = view.events.map(event => {
        let entry = event.projectedEntry;
        for (const group of replacements.values())
            if (entryRef(group.event) === entryRef(event)) {
                let text = group.original;
                for (const span of group.spans.sort((a, b) => b.start - a.start))
                    text = text.slice(0, span.start) + span.text + text.slice(span.end);
                entry = replaceText(entry, group.field, text);
            }
        return entry === event.projectedEntry ? event : { ...event, projectedEntry: entry };
    });
    return freeze({ events, acceptedArtifactKeys: keys });
}
//# sourceMappingURL=interval-helper-adapter.js.map