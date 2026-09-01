import { byteCount, estimateTokensFromText, getNumber, getRecord, getString, lineCount, truncateToTokens, unique } from "../utils.js";
import { collapseAdjacentRepeatedLines, normalizeTerminalText } from "./normalize.js";
const IMPORTANT_LINE = /(?:^|\b)(?:FAIL(?:ED)?|ERROR|Error:|AssertionError|Traceback|panic:|fatal:|expected|received|actual|snapshot|timeout|timed out|Caused by:|at\s+[^\s]+\s+\([^)]*:\d+(?::\d+)?\)|\bWARN(?:ING)?\b)/i;
const PASSING_NOISE = /(?:^\s*[✓✔·.]|\bPASS\b|\bpassed\b|\bok\b|\bskipped\b)/i;
export function looksLikeTestOutput(text) {
    return /(?:\bTests?:|\bTest Files?:|\btest result:|\bpytest\b|\bvitest\b|\bjest\b|\bmocha\b|\bcargo test\b|\bgo test\b|\d+\s+(?:passed|failed|skipped))/i.test(text);
}
function frameworkFor(text) {
    if (/vitest/i.test(text))
        return "Vitest";
    if (/jest/i.test(text))
        return "Jest";
    if (/pytest|short test summary info/i.test(text))
        return "pytest";
    if (/test result:\s*(?:ok|FAILED)/i.test(text))
        return "Rust test harness";
    if (/---\s+(?:PASS|FAIL):|go test/i.test(text))
        return "Go test";
    if (/mocha|\d+ passing/i.test(text))
        return "Mocha";
    if (/TAP version|not ok \d+/i.test(text))
        return "TAP";
    return undefined;
}
function parseTotals(text) {
    const totals = {};
    const patterns = [
        ["passed", [/\b(\d+)\s+passed\b/i, /\bpassed\s*[:=]\s*(\d+)/i, /Tests?:[^\n]*?(\d+)\s+passed/i]],
        ["failed", [/\b(\d+)\s+failed\b/i, /\bfailed\s*[:=]\s*(\d+)/i, /Tests?:[^\n]*?(\d+)\s+failed/i]],
        ["skipped", [/\b(\d+)\s+skipped\b/i, /\bskipped\s*[:=]\s*(\d+)/i]],
        ["total", [/\b(\d+)\s+total\b/i, /Tests?:[^\n]*?\b(\d+)\s+total/i]],
    ];
    for (const [key, regexes] of patterns) {
        for (const regex of regexes) {
            const match = text.match(regex);
            if (match?.[1]) {
                totals[key] = Number.parseInt(match[1], 10);
                break;
            }
        }
    }
    if (totals.total === undefined && (totals.passed !== undefined || totals.failed !== undefined || totals.skipped !== undefined)) {
        totals.total = (totals.passed ?? 0) + (totals.failed ?? 0) + (totals.skipped ?? 0);
    }
    return totals;
}
function pairedCommand(context) {
    const args = context.block.toolArguments;
    return getString(args?.command) ?? getString(context.block.attributes.command);
}
function exitCode(context) {
    const details = getRecord(context.block.attributes.details);
    return (getNumber(context.block.attributes.exitCode) ??
        getNumber(details?.exitCode) ??
        getNumber(details?.code) ??
        (context.block.isError === true ? 1 : context.block.isError === false ? 0 : undefined));
}
function collectFailureSections(lines) {
    const selected = new Set();
    lines.forEach((line, index) => {
        // A passing test name can legitimately contain words such as "timeout". Do not
        // let that pull every passing-test line into the failure neighborhood.
        if (PASSING_NOISE.test(line) && !/(?:FAIL(?:ED)?|ERROR|AssertionError|expected|received|actual|snapshot|timed out)/i.test(line))
            return;
        if (!IMPORTANT_LINE.test(line))
            return;
        const before = /(?:Traceback|FAIL|FAILED|Error:|AssertionError|panic:|fatal:)/i.test(line) ? 2 : 1;
        const after = /(?:Traceback|FAIL|FAILED|Error:|AssertionError|panic:|fatal:)/i.test(line) ? 10 : 4;
        for (let cursor = Math.max(0, index - before); cursor <= Math.min(lines.length - 1, index + after); cursor += 1) {
            selected.add(cursor);
        }
    });
    return [...selected]
        .sort((a, b) => a - b)
        .map((index) => lines[index] ?? "")
        .filter((line, index, all) => !(line.trim() === "" && all[index - 1]?.trim() === ""));
}
export function reduceTestOutput(context) {
    const normalized = normalizeTerminalText(context.block.exactText);
    const originalLines = normalized.text.split("\n");
    const collapsed = collapseAdjacentRepeatedLines(originalLines);
    const lines = collapsed.lines;
    const framework = frameworkFor(normalized.text);
    const totals = parseTotals(normalized.text);
    const command = pairedCommand(context);
    const code = exitCode(context);
    const failureLines = collectFailureSections(lines);
    const warnings = unique(lines.filter((line) => /\bWARN(?:ING)?\b/i.test(line))).slice(0, 12);
    const namedFailures = unique(lines
        .filter((line) => /(?:^\s*(?:FAIL|FAILED)|::\s*[^\s]+\s*FAILED|not ok \d+)/i.test(line))
        .map((line) => line.trim())).slice(0, 20);
    const sections = [];
    if (command)
        sections.push(`Command: ${command}`);
    if (code !== undefined)
        sections.push(`Exit code: ${code}`);
    if (framework)
        sections.push(`Framework: ${framework}`);
    const totalParts = [];
    if (totals.passed !== undefined)
        totalParts.push(`${totals.passed} passed`);
    if (totals.failed !== undefined)
        totalParts.push(`${totals.failed} failed`);
    if (totals.skipped !== undefined)
        totalParts.push(`${totals.skipped} skipped`);
    if (totals.total !== undefined)
        totalParts.push(`${totals.total} total`);
    if (totalParts.length > 0)
        sections.push(`Tests: ${totalParts.join(", ")}`);
    if (namedFailures.length > 0)
        sections.push(`\nFailing tests:\n${namedFailures.map((line) => `- ${line}`).join("\n")}`);
    if (failureLines.length > 0)
        sections.push(`\nFailure evidence (exact excerpts):\n${failureLines.join("\n")}`);
    if (warnings.length > 0)
        sections.push(`\nWarnings (exact excerpts):\n${warnings.join("\n")}`);
    if (failureLines.length === 0) {
        const tail = lines.slice(-Math.min(24, lines.length));
        sections.push(`\nResult tail (exact):\n${tail.join("\n")}`);
    }
    let text = sections.join("\n").trim();
    text = truncateToTokens(text, context.maxTokens, "\n…[additional test evidence omitted]…\n");
    const keptLineEstimate = lineCount(text);
    const omittedLines = Math.max(0, originalLines.length - keptLineEstimate);
    const omittedBytes = Math.max(0, byteCount(context.block.exactText) - byteCount(text));
    const omissions = [...normalized.omissions];
    if (collapsed.repeatedLines > 0) {
        omissions.push({
            description: `${collapsed.repeatedLines} adjacent repeated test-output line(s) collapsed`,
            repeatedLines: collapsed.repeatedLines,
        });
    }
    if (omittedLines > 0 || omittedBytes > 0) {
        omissions.push({
            description: "Passing-test logs, routine framework output, and duplicate stack frames omitted",
            omittedLines,
            omittedBytes,
        });
    }
    return {
        text,
        reducer: "test-output",
        version: "1.0.0",
        lossy: estimateTokensFromText(text) < context.block.rawTokens || omissions.length > 0,
        omissions,
        metadata: { framework, totals, exitCode: code, command, originalLines: originalLines.length },
    };
}
//# sourceMappingURL=test-output.js.map