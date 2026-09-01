import { compactWhitespace, directInstructionText, getNumber, getRecord, getString, hashText, unique } from "./utils.js";
export function classifyActivityPhase(text) {
    const direct = directInstructionText(text).toLowerCase();
    if (/^\s*(?:are|can|could|will|would)\b[^?]{0,500}\?/.test(direct))
        return undefined;
    if (/\b(?:analy[sz]e|evaluate|inspect|investigate|research|review|tell me what you think|what do you think)\b/.test(direct)) {
        return "research";
    }
    if (/\b(?:document|documentation|readme|write (?:the )?docs?|update (?:the )?docs?)\b/.test(direct))
        return "documentation";
    if (/\b(?:implement|build|create|modify|edit|fix|refactor|start (?:coding|implementation)|continue (?:the|your) work)\b/.test(direct)) {
        return "implementation";
    }
    if (/\b(?:approach|design|plan|planning|vision)\b/.test(direct))
        return "planning";
    if (/\b(?:benchmark|run (?:the )?checks?|test|validate|verification|verify)\b/.test(direct))
        return "verification";
    return undefined;
}
function filePath(block) {
    return (getString(block.toolArguments?.path) ??
        getString(block.toolArguments?.file_path) ??
        getString(block.toolArguments?.file))
        ?.trim()
        .replaceAll("\\", "/")
        .replace(/\/+/g, "/");
}
function commandText(block) {
    const command = getString(block.toolArguments?.command) ?? getString(block.attributes.command);
    if (!command?.trim())
        return undefined;
    return compactWhitespace(command).replace(/\s+/g, " ");
}
function interactionOutcome(blocks) {
    const result = blocks.find((block) => block.kind === "tool_result" || block.kind === "bash_execution");
    if (!result)
        return undefined;
    if (result.isError === true)
        return "failure";
    const details = getRecord(result.attributes.details);
    const exitCode = getNumber(result.attributes.exitCode) ?? getNumber(details?.exitCode) ?? getNumber(details?.code);
    if (exitCode !== undefined)
        return exitCode === 0 ? "success" : "failure";
    const exactExit = result.exactText.match(/\bexit code:\s*(-?\d+)/i)?.[1];
    if (exactExit !== undefined)
        return Number(exactExit) === 0 ? "success" : "failure";
    return result.isError === false ? "success" : undefined;
}
function resourceFor(blocks) {
    const representative = blocks.find((block) => block.kind === "tool_call") ?? blocks[0];
    if (!representative)
        return undefined;
    const path = filePath(representative);
    if (path && /^(?:read|cat|head|tail|view|open|unknown)$/i.test(representative.toolName ?? "")) {
        return { resourceKind: "file", resourceKey: `file:${path}`, displayName: path };
    }
    const command = commandText(representative);
    if (command && /^(?:bash|shell|terminal|exec)$/i.test(representative.toolName ?? "bash")) {
        return {
            resourceKind: "command",
            resourceKey: `command:${hashText(command)}`,
            displayName: command.length <= 120 ? command : `${command.slice(0, 117)}…`,
        };
    }
    return undefined;
}
function artifactAdjustment(path) {
    if (/\.map(?:$|[?#])|(?:^|\/)source[-_.]?maps?(?:\/|$)/i.test(path)) {
        return { adjustment: -45, reason: "generated source-map artifact" };
    }
    if (/\.min\.(?:js|css)(?:$|[?#])/i.test(path))
        return { adjustment: -40, reason: "minified generated artifact" };
    if (/(?:^|\/)dist\/|(?:^|\/)build\/|\.d\.ts$/i.test(path)) {
        return { adjustment: -22, reason: "compiled or generated artifact" };
    }
    return undefined;
}
function add(analysis, adjustment, reason) {
    analysis.importanceAdjustment += adjustment;
    analysis.reasons.push(`${adjustment >= 0 ? "+" : ""}${adjustment}: ${reason}`);
}
function citedBeforeNextOccurrence(interaction, nextStartIndex, blocks) {
    const result = interaction.blocks.find((block) => block.kind === "tool_result" || block.kind === "bash_execution");
    if (!result)
        return false;
    const identifiers = result.exactIdentifiers.filter((identifier) => identifier.length >= 5).slice(0, 30);
    if (identifiers.length === 0)
        return false;
    return blocks.some((block) => block.entryIndex > interaction.endIndex &&
        block.entryIndex < nextStartIndex &&
        (block.kind === "assistant_text" || block.kind === "user" || block.kind === "custom_message") &&
        identifiers.some((identifier) => block.exactText.includes(identifier)));
}
export function analyzeBlockHistory(blocks) {
    const mutable = new Map();
    for (const block of blocks)
        mutable.set(block.id, { importanceAdjustment: 0, reasons: [] });
    const grouped = new Map();
    for (const block of blocks) {
        if (block.kind !== "tool_call" && block.kind !== "tool_result" && block.kind !== "bash_execution")
            continue;
        const interactionId = block.toolCallId ?? block.id;
        const existing = grouped.get(interactionId) ?? [];
        existing.push(block);
        grouped.set(interactionId, existing);
    }
    const interactions = [];
    for (const [id, interactionBlocks] of grouped) {
        const resource = resourceFor(interactionBlocks);
        if (!resource)
            continue;
        interactions.push({
            id,
            blocks: interactionBlocks,
            startIndex: Math.min(...interactionBlocks.map((block) => block.entryIndex)),
            endIndex: Math.max(...interactionBlocks.map((block) => block.entryIndex)),
            ...resource,
            outcome: interactionOutcome(interactionBlocks),
        });
    }
    interactions.sort((a, b) => a.startIndex - b.startIndex || a.id.localeCompare(b.id));
    const byResource = new Map();
    for (const interaction of interactions) {
        const existing = byResource.get(interaction.resourceKey) ?? [];
        existing.push(interaction);
        byResource.set(interaction.resourceKey, existing);
    }
    for (const occurrences of byResource.values()) {
        occurrences.forEach((interaction, index) => {
            for (const block of interaction.blocks) {
                const analysis = mutable.get(block.id);
                analysis.resourceKind = interaction.resourceKind;
                analysis.resourceKey = interaction.resourceKey;
                analysis.occurrence = index + 1;
                analysis.occurrenceCount = occurrences.length;
                if (interaction.resourceKind === "file") {
                    const artifact = artifactAdjustment(interaction.displayName);
                    if (artifact)
                        add(analysis, artifact.adjustment, artifact.reason);
                }
                if (occurrences.length > 1) {
                    if (index === occurrences.length - 1)
                        add(analysis, 14, `latest of ${occurrences.length} repeated ${interaction.resourceKind} interactions`);
                    else
                        add(analysis, -28, `older of ${occurrences.length} repeated ${interaction.resourceKind} interactions`);
                }
            }
            const next = occurrences[index + 1];
            if (next && citedBeforeNextOccurrence(interaction, next.startIndex, blocks)) {
                for (const block of interaction.blocks)
                    add(mutable.get(block.id), 38, "evidence cited before the next resource occurrence");
            }
            const previous = occurrences[index - 1];
            if (previous?.outcome && interaction.outcome && previous.outcome !== interaction.outcome) {
                for (const block of interaction.blocks)
                    add(mutable.get(block.id), 70, `resource outcome changed from ${previous.outcome} to ${interaction.outcome}`);
                for (const block of previous.blocks)
                    add(mutable.get(block.id), 24, `evidence immediately before an outcome transition to ${interaction.outcome}`);
            }
        });
    }
    let currentPhase;
    let discoveryToExecutionAt = -1;
    blocks.forEach((block, index) => {
        if (block.kind === "user" || block.kind === "custom_message") {
            const classified = classifyActivityPhase(block.exactText);
            if (classified) {
                const wasDiscovery = currentPhase === "research" || currentPhase === "planning";
                const isExecution = classified === "implementation" || classified === "verification" || classified === "documentation";
                if (wasDiscovery && isExecution)
                    discoveryToExecutionAt = index;
                currentPhase = classified;
            }
        }
        if (currentPhase)
            mutable.get(block.id).activityPhase = currentPhase;
    });
    if (discoveryToExecutionAt > 0) {
        let boundaryResultIndex = -1;
        for (let index = discoveryToExecutionAt - 1; index >= 0; index -= 1) {
            const block = blocks[index];
            if (block?.kind === "assistant_text" && getString(block.attributes.phase) === "final") {
                boundaryResultIndex = index;
                break;
            }
        }
        blocks.forEach((block, index) => {
            const analysis = mutable.get(block.id);
            if (index < discoveryToExecutionAt && (analysis.activityPhase === "research" || analysis.activityPhase === "planning")) {
                add(analysis, -18, `older ${analysis.activityPhase} phase before execution began`);
            }
            else if (index >= discoveryToExecutionAt) {
                add(analysis, 8, "current execution phase");
            }
            if (index === boundaryResultIndex)
                add(analysis, 26, "last assistant result at the discovery-to-execution boundary");
        });
    }
    return new Map([...mutable].map(([id, analysis]) => [
        id,
        {
            ...analysis,
            reasons: unique(analysis.reasons),
        },
    ]));
}
//# sourceMappingURL=history-analysis.js.map