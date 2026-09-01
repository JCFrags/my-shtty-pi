import { createHash } from "node:crypto";
import { compactWhitespace, estimateTokensFromText, hasRestrictionLanguage, } from "./utils.js";
export const HISTORY_VALUE_SCHEMA_VERSION = 2;
export function fullHistoryHash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function normalized(text) {
    return compactWhitespace(text).replace(/\s+/g, " ").trim().toLowerCase();
}
function bounded(text, maximum = 240) {
    const clean = compactWhitespace(text).replace(/\s+/g, " ").trim();
    return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}
function terms(text) {
    return normalized(text).match(/[a-z][a-z0-9_.:/-]{2,}/g)?.slice(0, 32) ?? [];
}
function authority(block) {
    if (block.kind === "user")
        return "user";
    if (block.kind === "tool_call" || block.kind === "tool_result" || block.kind === "bash_execution") {
        return "tool";
    }
    if (block.kind === "custom_message")
        return "project";
    return "assistant";
}
function category(block) {
    const text = normalized(block.exactText);
    if (block.protectedExact && hasRestrictionLanguage(block.exactText))
        return "restriction";
    if (block.isError ||
        block.unresolved ||
        (!/\b(no|zero)\s+(errors?|failures?)\b/.test(text) && /\b(failed|failure|error)\b/.test(text)))
        return "failure";
    if (/\b(blocked|blocker|cannot continue|waiting for)\b/.test(text))
        return "blocker";
    if (/\b(next|todo|must|should)\b/.test(text) && /\b(action|step|implement|run|fix|continue)\b/.test(text)) {
        return "next-action";
    }
    if (/\b(goal|objective|purpose)\b/.test(text))
        return "goal";
    if (/\b(decided|decision|choose|selected)\b/.test(text))
        return "decision";
    if (/\b(task|implementation|work item|milestone)\b/.test(text))
        return "task-episode";
    if (block.toolName || block.attributes.resourceKey)
        return "resource-state";
    if (/\b(test|metric|tokens|bytes|milliseconds| ms\b|rss)\b/.test(text))
        return "metric";
    return block.kind === "assistant_text" ? "status" : "evidence";
}
function resourceIdentity(block, context) {
    const key = block.attributes.resourceKey;
    if (typeof key === "string")
        return normalized(key);
    const args = context.toolArguments ?? block.toolArguments;
    for (const name of ["path", "file", "url", "resource"]) {
        if (typeof args?.[name] === "string")
            return normalized(args[name]);
    }
    return undefined;
}
function resourceRole(block) {
    const tool = normalized(block.toolName ?? "");
    if (/write|edit|patch/.test(tool))
        return "write";
    if (/test|validat|check/.test(tool))
        return "validation";
    if (/read|grep|find|search/.test(tool))
        return "read";
    return "observed";
}
function commandIdentity(block, context) {
    const tool = context.toolName ?? block.toolName;
    const command = typeof (context.toolArguments ?? block.toolArguments)?.command === "string"
        ? String((context.toolArguments ?? block.toolArguments)?.command)
        : "";
    if (!tool || !command.trim())
        return undefined;
    return fullHistoryHash(`${normalized(tool)}:${normalized(command)}`);
}
function stableTaskIdentity(block) {
    const text = normalized(block.exactText);
    const explicit = text.match(/(?:task|goal|objective|milestone)\s*[:#-]?\s*([a-z0-9_.:/-]{2,120})/i)?.[1];
    if (!explicit)
        return undefined;
    return fullHistoryHash(normalized(explicit));
}
function identity(valueCategory, block, context) {
    const resource = resourceIdentity(block, context);
    const command = commandIdentity(block, context);
    const task = stableTaskIdentity(block);
    const failureTerms = terms(block.exactText)
        .filter(term => !/^(?:failed?|failure|errors?|fixed|resolved|passed|success|successful|corrected|unresolved|remains?)$/.test(term));
    const signature = fullHistoryHash(failureTerms.slice(0, 12).join(" "));
    if (valueCategory === "failure") {
        const failure = fullHistoryHash(`${signature}:${resource ?? ""}:${command ?? ""}:${task ?? ""}`);
        return { stateKey: `failure:${failure}`, resource, command, task, failure, failureSignature: signature };
    }
    if (valueCategory === "restriction") {
        const subject = fullHistoryHash(terms(block.exactText)
            .filter(term => !/(?:must|never|always|should|correction|corrected|replace|replacement|instead|allow|deny|not|you|please)/.test(term))
            .slice(0, 3).join(" "));
        return { stateKey: `restriction:${subject}`, subject };
    }
    if (valueCategory === "resource-state") {
        const successful = /\b(pass(?:ed)?|fixed|resolved|corrected|success(?:ful)?)\b/i.test(block.exactText);
        const failure = successful ? fullHistoryHash(`${signature}:${resource ?? ""}:${command ?? ""}:${task ?? ""}`) : undefined;
        return {
            stateKey: `resource:${resource ?? command ?? signature}:${resourceRole(block)}`,
            resource,
            command,
            task,
            failure,
            ...(successful ? { failureSignature: signature } : {}),
        };
    }
    if (valueCategory === "task-episode" || valueCategory === "goal" || valueCategory === "next-action") {
        const taskIdentity = task ?? fullHistoryHash(terms(block.exactText).slice(0, 12).join(" "));
        return { stateKey: `task:${taskIdentity}`, task: taskIdentity };
    }
    return { stateKey: `${valueCategory}:${resource ?? signature}`, resource, command, task };
}
function lifecycle(valueCategory, block) {
    if (valueCategory === "failure")
        return "unresolved";
    if (valueCategory === "task-episode") {
        const validation = resourceRole(block) === "validation" && /\b(pass(?:ed)?|success(?:ful)?|validated)\b/i.test(block.exactText);
        return validation ? "closed" : "open";
    }
    if (["restriction", "blocker", "next-action", "resource-state"].includes(valueCategory))
        return "current";
    return "unknown";
}
export function createHistoryValueRecord(block, index = 0, context = {}) {
    const valueCategory = category(block);
    const sourceAuthority = authority(block);
    const relationIdentity = identity(valueCategory, block, context);
    const restriction = valueCategory === "restriction";
    const failure = valueCategory === "failure";
    const blocker = valueCategory === "blocker";
    const priority = restriction
        ? "A"
        : failure || blocker
            ? "B"
            : ["resource-state", "goal", "decision", "next-action"].includes(valueCategory)
                ? "B"
                : ["metric", "evidence"].includes(valueCategory)
                    ? "C"
                    : "D";
    const cue = restriction && block.protectedExact
        ? "Protected current restriction; load exact source before use."
        : block.kind === "tool_call"
            ? `Tool ${context.toolName ?? block.toolName ?? "unknown"} call observed; complete arguments omitted.`
            : block.kind === "tool_result" && !failure
                ? `Tool ${context.toolName ?? block.toolName ?? "unknown"} result observed; complete output omitted.`
                : bounded(block.exactText);
    const exactRefs = block.sourceRefs.filter(ref => ref.entryId === block.entryId);
    const normalizedClaimHash = fullHistoryHash(normalized(block.exactText));
    return {
        schemaVersion: 2,
        id: fullHistoryHash(`history-value-v2:${block.id}:${index}:${valueCategory}`),
        category: valueCategory,
        sourceAuthority,
        lifecycle: lifecycle(valueCategory, block),
        priority,
        sourceRefs: exactRefs.length ? exactRefs : [{ entryId: block.entryId }],
        sourceRange: { startEntryId: block.entryId, endEntryId: block.entryId },
        sourceOrder: { start: block.entryIndex, end: block.entryIndex },
        sourceTokens: block.rawTokens,
        renderedTokenEstimate: estimateTokensFromText(cue),
        evidenceType: block.protectedExact
            ? "exact-source"
            : sourceAuthority === "tool"
                ? "structured-source"
                : "deterministic-derived",
        uniqueness: "unknown",
        recoveryCost: block.reproducible ? 20 : 80,
        reproductionCost: block.reproducible ? 20 : 80,
        compressionRisk: restriction ? 100 : failure ? 85 : 40,
        staticImportance: Math.min(100, priority === "A" ? 95 : priority === "B" ? 75 : priority === "C" ? 50 : 25),
        staticSignals: [sourceAuthority, valueCategory, ...(block.protectedExact ? ["protected"] : [])],
        stateKey: relationIdentity.stateKey,
        normalizedClaimHash,
        ...(relationIdentity.subject ? {
            subjectFingerprint: relationIdentity.subject,
            correctionIntent: /\b(correct(?:ion|ed)?|replac(?:e|ed|ement)|supersed(?:e|ed|es|ing)|instead)\b/i.test(block.exactText),
        } : {}),
        ...(relationIdentity.failure ? { failureIdentity: relationIdentity.failure } : {}),
        ...(relationIdentity.failureSignature ? { failureSignature: relationIdentity.failureSignature } : {}),
        ...(relationIdentity.command ? { commandIdentity: relationIdentity.command } : {}),
        ...(relationIdentity.resource ? { resourceIdentity: relationIdentity.resource } : {}),
        ...(block.toolName ? { resourceRole: resourceRole(block) } : {}),
        ...(relationIdentity.task ? { taskIdentity: relationIdentity.task } : {}),
        relations: context.relation ? [context.relation] : [],
        successEvidence: /\b(pass(?:ed)?|fixed|resolved|corrected|success(?:ful)?|validated|accepted)\b/i.test(block.exactText),
        confidence: sourceAuthority === "user" || sourceAuthority === "tool" ? "source-fact" : "heuristic-inference",
        cue,
        exactSourceRequired: restriction,
    };
}
export function historyStaticValue(record) {
    return record.staticImportance + record.compressionRisk * 0.15 + record.recoveryCost * 0.1 +
        (record.lifecycle === "unresolved" ? 20 : 0) +
        (record.uniqueness === "unique" ? 10 : record.uniqueness === "duplicate" ? -10 : 0);
}
export function historyDynamicValue(record, context = {}) {
    let value = historyStaticValue(record);
    const hintTerms = terms(`${context.retentionHints ?? ""} ${(context.recentTailTerms ?? []).join(" ")}`);
    const cue = normalized(record.cue ?? "");
    if (hintTerms.some(term => cue.includes(term)))
        value += 25;
    if (record.resourceIdentity && context.currentResourceIdentities?.includes(record.resourceIdentity))
        value += 30;
    if (record.taskIdentity && context.openTaskIds?.includes(record.taskIdentity))
        value += 30;
    if (context.retrievalEntryIds?.some(id => record.sourceRefs.some(ref => ref.entryId === id)))
        value += 20;
    if (context.unresolvedFailureKeys?.includes(record.failureIdentity ?? record.stateKey))
        value += 30;
    if (context.desiredCategories?.includes(record.category))
        value += 15;
    return value;
}
export function orderHistoryValues(records, context = {}) {
    return [...records].sort((a, b) => historyDynamicValue(b, context) - historyDynamicValue(a, context) ||
        a.sourceOrder.start - b.sourceOrder.start ||
        a.id.localeCompare(b.id));
}
export function extractHistoryValues(blocks, contexts = new Map()) {
    const seen = new Map();
    return blocks.map((block, index) => {
        let value = createHistoryValueRecord(block, index, contexts.get(block.id));
        const signature = `${value.category}:${value.normalizedClaimHash}`;
        const prior = seen.get(signature);
        if (prior) {
            value = {
                ...value,
                uniqueness: "duplicate",
                duplicateGroupIdentity: fullHistoryHash(signature),
                relations: [...value.relations, { kind: "duplicate", targetRecordId: prior, basis: "exact-normalized-claim" }],
            };
        }
        else {
            seen.set(signature, value.id);
            value = { ...value, uniqueness: "unique" };
        }
        return value;
    });
}
//# sourceMappingURL=history-value.js.map