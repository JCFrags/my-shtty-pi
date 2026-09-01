import { boundedSecretFree, DEFAULT_PARENT_TOOL_LIMITS, ParentToolService, } from "./parent-tools.js";
import { isParentToolRequest, PARENT_TOOL_NAMES, } from "./parent-tool-schema.js";
import { SHIPPED_TASK_PROFILES, THINKING_LEVELS, } from "../broker/model-policy.js";
import { AGENT_STATES } from "../state/types.js";
import { Container, Text, truncateToWidth, visibleWidth, } from "@pi-herdr-deck/tui";
const MAX_BODY_BYTES = 262_144;
const MAX_TEXT_BYTES = 16_384;
const LAUNCH_LIFECYCLE_REMINDER = 'After each managed task becomes terminal, use orchestrate with action "collect" and its taskId. If the assigned agent remains open and is no longer needed, use action "close" with the same taskId.';
const boundedString = (max) => ({
    type: "string",
    minLength: 1,
    maxLength: max,
});
const resultItemSchemas = {
    findings: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "description", "evidence", "resolved"],
        properties: {
            severity: {
                type: "string",
                enum: ["info", "low", "medium", "high", "critical"],
            },
            title: boundedString(512),
            description: boundedString(8192),
            evidence: { type: "array", maxItems: 32, items: boundedString(4096) },
            resolved: { type: "boolean" },
        },
    },
    changedFiles: {
        type: "object",
        additionalProperties: false,
        required: ["path", "change"],
        properties: {
            path: boundedString(4096),
            change: {
                type: "string",
                enum: ["added", "modified", "deleted", "renamed", "unknown"],
            },
            previousPath: { type: ["string", "null"], maxLength: 4096 },
        },
    },
    commandsRun: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode", "outcome"],
        properties: {
            command: boundedString(8192),
            exitCode: { type: ["integer", "null"], minimum: 0, maximum: 255 },
            outcome: {
                type: "string",
                enum: ["passed", "failed", "cancelled", "unknown"],
            },
        },
    },
    tests: {
        type: "object",
        additionalProperties: false,
        required: [
            "name",
            "command",
            "status",
            "passed",
            "failed",
            "skipped",
            "evidence",
        ],
        properties: {
            name: boundedString(512),
            command: { type: ["string", "null"], maxLength: 8192 },
            status: {
                type: "string",
                enum: ["passed", "failed", "cancelled", "unknown"],
            },
            passed: { type: ["integer", "null"], minimum: 0 },
            failed: { type: ["integer", "null"], minimum: 0 },
            skipped: { type: ["integer", "null"], minimum: 0 },
            evidence: { type: ["string", "null"], maxLength: 4096 },
        },
    },
    commits: {
        type: "object",
        additionalProperties: false,
        required: ["sha", "subject"],
        properties: {
            sha: { type: "string", pattern: "^[0-9a-fA-F]{7,64}$" },
            subject: boundedString(1024),
        },
    },
    artifacts: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "description", "mediaType"],
        properties: {
            kind: {
                type: "string",
                enum: ["text", "json", "patch", "log", "report", "other"],
            },
            path: boundedString(4096),
            description: boundedString(1024),
            mediaType: boundedString(128),
        },
    },
    unresolved: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "blocking"],
        properties: {
            title: boundedString(512),
            description: boundedString(8192),
            blocking: { type: "boolean" },
        },
    },
    questions: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "summary", "answered"],
        properties: {
            questionId: { type: "string", pattern: "^qst_[0-9A-HJKMNP-TV-Z]{26}$" },
            summary: boundedString(1024),
            answered: { type: "boolean" },
        },
    },
};
const resultSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "schemaVersion",
        "status",
        "summary",
        "findings",
        "changedFiles",
        "commandsRun",
        "tests",
        "commits",
        "artifacts",
        "unresolved",
        "questions",
        "recommendedNextAction",
    ],
    properties: {
        schemaVersion: { type: "integer", const: 1 },
        status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
        summary: { type: "string", minLength: 1, maxLength: 65_536 },
        findings: {
            type: "array",
            maxItems: 256,
            items: resultItemSchemas.findings,
        },
        changedFiles: {
            type: "array",
            maxItems: 4096,
            items: resultItemSchemas.changedFiles,
        },
        commandsRun: {
            type: "array",
            maxItems: 256,
            items: resultItemSchemas.commandsRun,
        },
        tests: { type: "array", maxItems: 256, items: resultItemSchemas.tests },
        commits: { type: "array", maxItems: 64, items: resultItemSchemas.commits },
        artifacts: {
            type: "array",
            maxItems: 128,
            items: resultItemSchemas.artifacts,
        },
        unresolved: {
            type: "array",
            maxItems: 128,
            items: resultItemSchemas.unresolved,
        },
        questions: {
            type: "array",
            maxItems: 64,
            items: resultItemSchemas.questions,
        },
        recommendedNextAction: { type: ["string", "null"], maxLength: 8_192 },
    },
};
const questionSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "schemaVersion",
        "prompt",
        "context",
        "options",
        "allowFreeform",
        "defaultOptionId",
        "timeoutMs",
    ],
    properties: {
        schemaVersion: { type: "integer", const: 1 },
        prompt: { type: "string", minLength: 1, maxLength: 16_384 },
        context: { type: ["string", "null"], maxLength: 16_384 },
        options: {
            type: "array",
            minItems: 0,
            maxItems: 8,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "description"],
                properties: {
                    id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" },
                    label: { type: "string", minLength: 1, maxLength: 1_024 },
                    description: { type: ["string", "null"], maxLength: 4_096 },
                },
            },
        },
        allowFreeform: { type: "boolean" },
        defaultOptionId: {
            type: ["string", "null"],
            pattern: "^[A-Za-z0-9_-]{1,32}$",
        },
        timeoutMs: { type: "integer", minimum: 10_000, maximum: 86_400_000 },
    },
    allOf: [
        {
            if: {
                properties: {
                    allowFreeform: { const: false },
                    options: { maxItems: 0 },
                },
            },
            then: false,
        },
    ],
};
const parentInputKeys = Object.freeze({
    delegate_compact: ["text", "accept", "workflowDigest"],
    delegate: [
        "mode",
        "title",
        "steps",
        "wait",
        "waitUntil",
        "timeoutMs",
        "failureMode",
        "dryRun",
    ],
    agent_spawn: [
        "task",
        "profileId",
        "modelProfileId",
        "model",
        "placement",
        "lifecycleClass",
        "keepForReuse",
        "project",
        "isolation",
        "budget",
        "review",
        "wait",
    ],
    agent_model_options: [
        "profileId",
        "placement",
        "modelProfileId",
        "projectKey",
        "limit",
    ],
    agent_list: [
        "ids",
        "managed",
        "state",
        "profileId",
        "taskId",
        "workspaceId",
        "connected",
        "maxBytes",
        "cursor",
        "limit",
    ],
    agent_get: ["agentId", "include", "maxBytes"],
    agent_prompt: ["agentId", "message", "delivery", "timeoutMs"],
    agent_steer: [
        "agentId",
        "message",
        "delivery",
        "runId",
        "assignmentGeneration",
    ],
    agent_ask: ["agentId", "message", "followUps", "timeoutMs"],
    agent_wait: ["agentId", "taskId", "runId", "until", "timeoutMs"],
    coordination_wait: [
        "kind",
        "targetId",
        "until",
        "durationMs",
        "startedAt",
        "timeoutMs",
        "pollMs",
    ],
    coordination_signal: ["targetId"],
    group_create: ["name", "agentIds"],
    group_list: [],
    group_get: ["groupId"],
    group_wait: ["groupId", "until", "mode", "timeoutMs"],
    group_stop: ["groupId", "reason", "force"],
    group_close: ["groupId", "reason", "confirm"],
    agent_result: ["taskId", "resultId", "include", "maxBytes"],
    agent_answer: ["questionId", "answer"],
    agent_interrupt: ["agentId", "runId", "assignmentGeneration", "reason"],
    agent_stop: ["agentId", "runId", "assignmentGeneration", "reason", "force"],
    agent_close: [
        "agentId",
        "runId",
        "assignmentGeneration",
        "reason",
        "confirm",
    ],
    task_list: [
        "state",
        "profileId",
        "workspaceId",
        "include",
        "maxBytes",
        "cursor",
        "limit",
    ],
    task_get: ["taskId", "include", "maxBytes"],
    task_collect: ["taskIds", "select", "maxBytes"],
    task_cancel: ["taskId", "reason", "cascade"],
    task_metadata: ["taskId", "runId"],
    task_transcript_close: ["taskId", "runId", "confirm"],
});
export function withLaunchLifecycleReminder(tool, input, result) {
    const launched = (tool === "agent_spawn" && input.dryRun !== true) ||
        (tool === "delegate" && input.dryRun !== true) ||
        (tool === "delegate_compact" && input.accept === true);
    if (!launched ||
        !result ||
        typeof result !== "object" ||
        Array.isArray(result))
        return result;
    return {
        ...result,
        lifecycleReminder: LAUNCH_LIFECYCLE_REMINDER,
    };
}
function validateNested(value, depth = 0) {
    if (depth > 6)
        throw new Error("LIMIT_EXCEEDED");
    if (typeof value === "string") {
        if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES ||
            /[\u0000-\u001f\u007f]/u.test(value))
            throw new Error("INVALID_REQUEST");
        return;
    }
    if (Array.isArray(value)) {
        if (value.length > 64)
            throw new Error("LIMIT_EXCEEDED");
        for (const item of value)
            validateNested(item, depth + 1);
        return;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length > 32)
            throw new Error("LIMIT_EXCEEDED");
        for (const [key, item] of entries) {
            if (Buffer.byteLength(key, "utf8") > 256 ||
                /(?:token|secret|password|cookie|credential|private.?key|api.?key)/iu.test(key))
                throw new Error("INVALID_REQUEST");
            validateNested(item, depth + 1);
        }
    }
}
const parentRequired = Object.freeze({
    delegate_compact: ["text"],
    delegate: [
        "mode",
        "title",
        "steps",
        "wait",
        "waitUntil",
        "timeoutMs",
        "failureMode",
        "dryRun",
    ],
    agent_spawn: ["task", "profileId", "project", "isolation", "budget", "wait"],
    agent_model_options: ["profileId"],
    agent_get: ["agentId"],
    agent_prompt: ["agentId", "message", "delivery", "timeoutMs"],
    agent_steer: ["agentId", "message", "delivery"],
    agent_ask: ["agentId", "message", "timeoutMs"],
    agent_wait: ["agentId", "taskId", "runId", "until", "timeoutMs"],
    coordination_wait: ["kind", "timeoutMs"],
    coordination_signal: ["targetId"],
    group_create: ["name", "agentIds"],
    group_get: ["groupId"],
    group_wait: ["groupId", "until", "mode", "timeoutMs"],
    group_stop: ["groupId", "reason"],
    group_close: ["groupId", "confirm"],
    agent_result: ["taskId"],
    agent_answer: ["questionId", "answer"],
    agent_interrupt: ["agentId"],
    agent_stop: ["agentId", "reason"],
    agent_close: ["agentId", "confirm"],
    task_get: ["taskId"],
    task_collect: ["taskIds"],
    task_cancel: ["taskId", "reason", "cascade"],
    task_metadata: ["taskId"],
    task_transcript_close: ["taskId", "confirm"],
});
function assertInputString(value, max = MAX_TEXT_BYTES, nonempty = true) {
    if (typeof value !== "string" ||
        (nonempty && value.length === 0) ||
        Buffer.byteLength(value, "utf8") > max ||
        /[\u0000-\u001f\u007f]/u.test(value))
        throw new Error("INVALID_REQUEST");
}
function assertExactObject(value, keys, required = []) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_REQUEST");
    const object = value;
    if (Object.keys(object).some((key) => !keys.includes(key)) ||
        required.some((key) => !Object.hasOwn(object, key)))
        throw new Error("INVALID_REQUEST");
}
function validateExactNested(tool, input) {
    const arrayFields = new Set([
        "ids",
        "taskIds",
        "include",
        "select",
        "agentIds",
        "followUps",
    ]);
    const stringFields = new Set([
        "title",
        "parentAgentId",
        "agentId",
        "taskId",
        "runId",
        "questionId",
        "resultId",
        "profileId",
        "modelProfileId",
        "placement",
        "lifecycleClass",
        "workspaceId",
        "message",
        "reason",
        "cursor",
        "name",
        "groupId",
        "targetId",
        "kind",
        "startedAt",
    ]);
    for (const [key, value] of Object.entries(input)) {
        if (arrayFields.has(key)) {
            if (!Array.isArray(value) ||
                value.length > 64 ||
                value.some((item) => {
                    try {
                        assertInputString(item, key === "followUps" ? MAX_TEXT_BYTES : 256);
                        return false;
                    }
                    catch {
                        return true;
                    }
                }))
                throw new Error("INVALID_REQUEST");
            const allowed = key === "include"
                ? [
                    "capabilities",
                    "runHistory",
                    "auditSummary",
                    "dependencies",
                    "runs",
                    "blockers",
                    "resultValidation",
                    "worktree",
                    "budgets",
                ]
                : key === "select"
                    ? ["taskId", "state", "summary", "status", "result"]
                    : undefined;
            if (allowed && value.some((item) => !allowed.includes(item)))
                throw new Error("INVALID_REQUEST");
            continue;
        }
        if (["task", "project", "isolation", "budget", "answer", "model"].includes(key)) {
            if (key === "task") {
                assertExactObject(value, ["title", "objective", "constraints"], ["title", "objective"]);
                assertInputString(value.title);
                assertInputString(value.objective);
                if (value.constraints !== undefined &&
                    (!Array.isArray(value.constraints) ||
                        value.constraints.length > 64 ||
                        value.constraints.some((item) => {
                            try {
                                assertInputString(item);
                                return false;
                            }
                            catch {
                                return true;
                            }
                        })))
                    throw new Error("INVALID_REQUEST");
            }
            else if (key === "project") {
                assertExactObject(value, ["cwd"], ["cwd"]);
                assertInputString(value.cwd, 4096);
            }
            else if (key === "isolation") {
                assertExactObject(value, ["mode"], ["mode"]);
                assertInputString(value.mode, 64);
                if (!["shared-readonly", "worktree"].includes(value.mode))
                    throw new Error("INVALID_REQUEST");
            }
            else if (key === "model") {
                assertExactObject(value, ["provider", "modelId", "thinkingLevel"], ["provider", "modelId", "thinkingLevel"]);
                assertInputString(value.provider, 128);
                assertInputString(value.modelId, 256);
                assertInputString(value.thinkingLevel, 32);
                if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel))
                    throw new Error("INVALID_REQUEST");
            }
            else if (key === "budget") {
                assertExactObject(value, ["wallTimeMs"], ["wallTimeMs"]);
                if (!Number.isSafeInteger(value.wallTimeMs) ||
                    value.wallTimeMs < 1 ||
                    value.wallTimeMs > 86_400_000)
                    throw new Error("INVALID_REQUEST");
            }
            else {
                assertExactObject(value, ["optionId", "text"], ["optionId", "text"]);
                assertInputString(value.optionId, 256);
                if (value.text !== null)
                    assertInputString(value.text, MAX_TEXT_BYTES);
            }
            continue;
        }
        if (key === "steps") {
            if (!Array.isArray(value) || value.length < 1 || value.length > 32)
                throw new Error("INVALID_REQUEST");
            for (const step of value) {
                assertExactObject(step, [
                    "key",
                    "profileId",
                    "title",
                    "objective",
                    "dependsOn",
                    "constraints",
                ], ["key", "profileId", "title", "objective"]);
                assertInputString(step.key, 256);
                assertInputString(step.profileId, 256);
                if (!SHIPPED_TASK_PROFILES.includes(step.profileId))
                    throw new Error("INVALID_REQUEST");
                assertInputString(step.title);
                assertInputString(step.objective);
                if (step.constraints !== undefined &&
                    (!Array.isArray(step.constraints) ||
                        step.constraints.length > 64 ||
                        step.constraints.some((item) => {
                            try {
                                assertInputString(item, 8192);
                                return false;
                            }
                            catch {
                                return true;
                            }
                        })))
                    throw new Error("INVALID_REQUEST");
                if (step.dependsOn !== undefined &&
                    (!Array.isArray(step.dependsOn) ||
                        step.dependsOn.length > 32 ||
                        step.dependsOn.some((item) => {
                            try {
                                assertInputString(item, 256);
                                return false;
                            }
                            catch {
                                return true;
                            }
                        })))
                    throw new Error("INVALID_REQUEST");
            }
            continue;
        }
        if (key === "modelProfileId") {
            if (value !== "manager" && value !== "subagent")
                throw new Error("INVALID_REQUEST");
            continue;
        }
        if (key === "lifecycleClass") {
            if (!["temporary", "reusable", "retained", "pinned"].includes(value))
                throw new Error("INVALID_REQUEST");
            continue;
        }
        if (key === "placement") {
            if (value !== "current-workspace" && value !== "new-workspace")
                throw new Error("INVALID_REQUEST");
            continue;
        }
        if (stringFields.has(key)) {
            assertInputString(value, key === "cursor" ? 256 : MAX_TEXT_BYTES);
            continue;
        }
        if ([
            "wait",
            "dryRun",
            "managed",
            "connected",
            "force",
            "confirm",
            "createTask",
            "cascade",
            "keepForReuse",
        ].includes(key)) {
            if (typeof value !== "boolean")
                throw new Error("INVALID_REQUEST");
            continue;
        }
        if ([
            "timeoutMs",
            "maxBytes",
            "limit",
            "assignmentGeneration",
            "durationMs",
            "pollMs",
        ].includes(key)) {
            if (!Number.isSafeInteger(value) ||
                value < 1 ||
                (key === "timeoutMs" && value > 1_800_000) ||
                (key === "maxBytes" && value > 262_144) ||
                (key === "limit" &&
                    value > (tool === "agent_model_options" ? 16 : 500)))
                throw new Error("INVALID_REQUEST");
            continue;
        }
        if (key === "state") {
            const values = Array.isArray(value) ? value : [value];
            const allowedStates = tool === "agent_list"
                ? AGENT_STATES
                : [
                    "queued",
                    "provisioning",
                    "running",
                    "blocked",
                    "succeeded",
                    "failed",
                    "cancelled",
                    "timed_out",
                    "lost",
                    "idle",
                    "working",
                    "connected",
                    "disconnected",
                ];
            if (values.some((item) => !allowedStates.some((state) => state === item)))
                throw new Error("INVALID_REQUEST");
            continue;
        }
    }
}
function validateParentInput(tool, input) {
    const keys = new Set(parentInputKeys[tool]);
    if (Object.keys(input).some((key) => !keys.has(key)) ||
        (parentRequired[tool] ?? []).some((key) => !Object.hasOwn(input, key)))
        throw new Error("INVALID_REQUEST");
    validateExactNested(tool, input);
    for (const [key, value] of Object.entries(input)) {
        if ([
            "wait",
            "dryRun",
            "managed",
            "connected",
            "force",
            "confirm",
            "createTask",
            "cascade",
            "accept",
        ].includes(key) &&
            typeof value !== "boolean")
            throw new Error("INVALID_REQUEST");
        if ([
            "timeoutMs",
            "maxBytes",
            "limit",
            "assignmentGeneration",
            "durationMs",
            "pollMs",
        ].includes(key) &&
            (!Number.isSafeInteger(value) ||
                value < 1 ||
                (key === "timeoutMs" &&
                    value >
                        (tool === "agent_wait" || tool === "agent_prompt"
                            ? 30_000
                            : tool === "agent_ask"
                                ? 120_000
                                : 1_800_000)) ||
                (key === "maxBytes" && value > 262_144) ||
                (key === "limit" &&
                    value > (tool === "agent_model_options" ? 16 : 500)) ||
                (key === "durationMs" && value > 86_400_000) ||
                (key === "pollMs" && value > 60_000)))
            throw new Error("INVALID_REQUEST");
        if ([
            "ids",
            "taskIds",
            "include",
            "select",
            "steps",
            "waitUntil",
            "until",
            "agentIds",
            "followUps",
        ].includes(key) &&
            !Array.isArray(value))
            throw new Error("INVALID_REQUEST");
        if (key === "followUps" && value.length > 3)
            throw new Error("LIMIT_EXCEEDED");
        if (key === "agentIds" &&
            (value.length < 1 || value.length > 64))
            throw new Error("LIMIT_EXCEEDED");
        if (key === "steps" && value.length > 32)
            throw new Error("LIMIT_EXCEEDED");
        if (key === "task") {
            if (!value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                !Object.hasOwn(value, "title") ||
                !Object.hasOwn(value, "objective"))
                throw new Error("INVALID_REQUEST");
        }
        if (key === "answer") {
            if (!value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                Object.keys(value).length !== 2 ||
                !Object.hasOwn(value, "optionId") ||
                !Object.hasOwn(value, "text") ||
                typeof value.optionId !== "string" ||
                (value.text !== null &&
                    typeof value.text !== "string"))
                throw new Error("INVALID_REQUEST");
        }
        if (key === "mode" &&
            tool !== "group_wait" &&
            !["single", "parallel", "chain", "dag", "implement_review_fix"].includes(value))
            throw new Error("INVALID_REQUEST");
        if (key === "profileId" && !SHIPPED_TASK_PROFILES.includes(value))
            throw new Error("INVALID_REQUEST");
        if (key === "delivery" &&
            !["normal", "steer", "follow_up"].includes(value))
            throw new Error("INVALID_REQUEST");
        if (key === "kind" &&
            ![
                "timer",
                "signal",
                "agent",
                "task",
                "result",
                "question",
                "group",
            ].includes(value))
            throw new Error("INVALID_REQUEST");
        if (key === "mode" &&
            tool === "group_wait" &&
            !["all", "any"].includes(value))
            throw new Error("INVALID_REQUEST");
        if (key === "failureMode" &&
            !["fail_fast", "collect_all"].includes(value))
            throw new Error("INVALID_REQUEST");
        if (key === "isolation" &&
            (!value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                Object.keys(value).some((item) => !["mode"].includes(item)) ||
                !["shared-readonly", "worktree"].includes(value.mode)))
            throw new Error("INVALID_REQUEST");
        if (key === "project" &&
            (!value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                typeof value.cwd !== "string"))
            throw new Error("INVALID_REQUEST");
        if (key === "budget" &&
            (!value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                !Number.isSafeInteger(value.wallTimeMs)))
            throw new Error("INVALID_REQUEST");
        if (["waitUntil"].includes(key) &&
            value.some((item) => !["terminal", "blocked"].includes(item)))
            throw new Error("INVALID_REQUEST");
        if (key === "until" &&
            tool === "agent_wait" &&
            value.some((item) => ![
                "succeeded",
                "failed",
                "cancelled",
                "timed_out",
                "blocked",
            ].includes(item)))
            throw new Error("INVALID_REQUEST");
    }
    validateNested(input);
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > 65_536)
        throw new Error("LIMIT_EXCEEDED");
}
function schemaForKey(key) {
    if ([
        "wait",
        "dryRun",
        "managed",
        "connected",
        "force",
        "confirm",
        "createTask",
        "cascade",
        "accept",
    ].includes(key))
        return { type: "boolean" };
    if ([
        "timeoutMs",
        "maxBytes",
        "limit",
        "assignmentGeneration",
        "durationMs",
        "pollMs",
    ].includes(key))
        return { type: "integer", minimum: 1, maximum: 1_800_000 };
    if (["mode"].includes(key))
        return {
            type: "string",
            enum: ["single", "parallel", "chain", "dag", "implement_review_fix"],
        };
    if (["delivery"].includes(key))
        return { type: "string", enum: ["normal", "steer", "follow_up"] };
    if (key === "profileId")
        return { type: "string", enum: [...SHIPPED_TASK_PROFILES] };
    if (key === "projectKey")
        return { type: "string", minLength: 1, maxLength: 4096 };
    if (key === "modelProfileId")
        return { type: "string", enum: ["manager", "subagent"] };
    if (key === "model")
        return {
            type: "object",
            additionalProperties: false,
            required: ["provider", "modelId", "thinkingLevel"],
            properties: {
                provider: { type: "string", minLength: 1, maxLength: 128 },
                modelId: { type: "string", minLength: 1, maxLength: 256 },
                thinkingLevel: {
                    type: "string",
                    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
                },
            },
        };
    if (key === "lifecycleClass")
        return {
            type: "string",
            enum: ["temporary", "reusable", "retained", "pinned"],
        };
    if (key === "placement")
        return {
            type: "string",
            enum: ["current-workspace", "new-workspace"],
        };
    if (["failureMode"].includes(key))
        return { type: "string", enum: ["fail_fast", "collect_all"] };
    if (["waitUntil"].includes(key))
        return {
            type: "array",
            maxItems: 8,
            items: { type: "string", enum: ["terminal", "blocked"] },
        };
    if (["until"].includes(key))
        return {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
                type: "string",
                enum: ["succeeded", "failed", "cancelled", "timed_out", "blocked"],
            },
        };
    if (key === "include")
        return {
            type: "array",
            maxItems: 64,
            items: {
                type: "string",
                enum: [
                    "capabilities",
                    "runHistory",
                    "auditSummary",
                    "dependencies",
                    "runs",
                    "blockers",
                    "resultValidation",
                    "worktree",
                    "budgets",
                ],
            },
        };
    if (key === "select")
        return {
            type: "array",
            maxItems: 64,
            items: {
                type: "string",
                enum: ["taskId", "state", "summary", "status", "result"],
            },
        };
    if (["ids", "taskIds", "agentIds", "followUps"].includes(key))
        return {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 256 },
        };
    if (["steps"].includes(key))
        return {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "profileId", "title", "objective"],
                properties: {
                    key: { type: "string", maxLength: 256 },
                    profileId: { type: "string", enum: [...SHIPPED_TASK_PROFILES] },
                    title: { type: "string", maxLength: MAX_TEXT_BYTES },
                    objective: { type: "string", maxLength: MAX_TEXT_BYTES },
                    constraints: {
                        type: "array",
                        maxItems: 64,
                        items: { type: "string", minLength: 1, maxLength: 8192 },
                    },
                    dependsOn: {
                        type: "array",
                        maxItems: 64,
                        items: { type: "string", maxLength: 256 },
                    },
                },
            },
        };
    if (["task"].includes(key))
        return {
            type: "object",
            additionalProperties: false,
            required: ["title", "objective"],
            properties: {
                title: { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES },
                objective: { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES },
                constraints: {
                    type: "array",
                    maxItems: 64,
                    items: { type: "string", maxLength: MAX_TEXT_BYTES },
                },
            },
        };
    if (key === "review")
        return {
            type: "object",
            additionalProperties: false,
            required: ["taskId", "runId", "resultId", "rubricVersion"],
            properties: {
                taskId: { type: "string", pattern: "^tsk_[0-9A-HJKMNP-TV-Z]{26}$" },
                runId: { type: "string", pattern: "^run_[0-9A-HJKMNP-TV-Z]{26}$" },
                resultId: { type: "string", pattern: "^res_[0-9A-HJKMNP-TV-Z]{26}$" },
                rubricVersion: { type: "string", minLength: 1, maxLength: 64 },
            },
        };
    if (["project"].includes(key))
        return {
            type: "object",
            additionalProperties: false,
            required: ["cwd"],
            properties: { cwd: { type: "string", maxLength: 4096 } },
        };
    if (["isolation"].includes(key))
        return {
            type: "object",
            additionalProperties: false,
            required: ["mode"],
            properties: {
                mode: {
                    type: "string",
                    enum: ["shared-readonly", "worktree"],
                    description: "shared-readonly is a broker tool-policy label for a shared checkout, not an OS-enforced read-only filesystem. Use worktree for file-writing roles or to protect the parent checkout.",
                },
            },
        };
    if (["budget"].includes(key))
        return {
            type: "object",
            additionalProperties: false,
            required: ["wallTimeMs"],
            properties: {
                wallTimeMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
            },
        };
    if (["answer"].includes(key))
        return {
            type: "object",
            additionalProperties: false,
            required: ["optionId", "text"],
            properties: {
                optionId: { type: "string", minLength: 1, maxLength: 256 },
                text: { type: ["string", "null"], maxLength: MAX_TEXT_BYTES },
            },
        };
    return { type: "string", maxLength: MAX_TEXT_BYTES };
}
function parentInputSchema(tool) {
    return {
        type: "object",
        additionalProperties: false,
        maxProperties: 32,
        properties: {
            ...Object.fromEntries(parentInputKeys[tool].map((key) => [
                key,
                key === "limit" && tool === "agent_model_options"
                    ? { type: "integer", minimum: 1, maximum: 16 }
                    : key === "timeoutMs" &&
                        (tool === "agent_wait" || tool === "agent_prompt")
                        ? { type: "integer", minimum: 1, maximum: 30_000 }
                        : key === "timeoutMs" && tool === "agent_ask"
                            ? { type: "integer", minimum: 1, maximum: 120_000 }
                            : key === "mode" && tool === "group_wait"
                                ? { type: "string", enum: ["all", "any"] }
                                : key === "kind" && tool === "coordination_wait"
                                    ? {
                                        type: "string",
                                        enum: [
                                            "timer",
                                            "signal",
                                            "agent",
                                            "task",
                                            "result",
                                            "question",
                                            "group",
                                        ],
                                    }
                                    : key === "until" && tool !== "agent_wait"
                                        ? {
                                            type: "array",
                                            minItems: 1,
                                            maxItems: 16,
                                            items: {
                                                type: "string",
                                                minLength: 1,
                                                maxLength: 64,
                                            },
                                        }
                                        : key === "followUps"
                                            ? {
                                                type: "array",
                                                maxItems: 3,
                                                items: boundedString(MAX_TEXT_BYTES),
                                            }
                                            : schemaForKey(key),
            ])),
            idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
        required: parentRequired[tool] ?? [],
    };
}
function prettyJson(value) {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    }
    catch {
        return String(value);
    }
}
function prettyModelText(text) {
    try {
        return prettyJson(JSON.parse(text));
    }
    catch {
        return text;
    }
}
function completeCallComponent(definition, args, theme) {
    const heading = theme.fg("toolTitle", theme.bold(definition.label));
    const label = theme.fg("muted", "LLM-submitted input (complete)");
    return new Text(`${heading}\n${label}\n${prettyJson(args)}`, 0, 0);
}
function completeResultComponent(result, theme) {
    const label = theme.fg("muted", "Model-visible result (complete)");
    if (result.content.length === 0)
        return new Text(`${label}\n[]`, 0, 0);
    const content = result.content
        .map((item, index) => {
        const text = typeof item.text === "string" ? prettyModelText(item.text) : "";
        if (result.content.length === 1 && item.type === "text")
            return text;
        return `[${index + 1}] ${item.type}${text.length > 0 ? `\n${text}` : ""}`;
    })
        .join("\n\n");
    return new Text(`${label}\n${content}`, 0, 0);
}
function combineComponents(summary, complete) {
    if (!summary)
        return complete;
    const container = new Container();
    container.addChild(summary);
    container.addChild(complete);
    return container;
}
function register(api, definition) {
    const summaryCall = definition.renderCall;
    const summaryResult = definition.renderResult;
    const transparentDefinition = {
        ...definition,
        renderCall(args, theme, context) {
            return combineComponents(summaryCall?.(args, theme, context), completeCallComponent(definition, args, theme));
        },
        renderResult(result, options, theme, context) {
            return combineComponents(summaryResult?.(result, options, theme, context), completeResultComponent(result, theme));
        },
    };
    api.registerTool?.(transparentDefinition);
}
function textResult(value) {
    const safe = boundedSecretFree(value);
    const encoded = JSON.stringify(safe);
    if (Buffer.byteLength(encoded, "utf8") <=
        DEFAULT_PARENT_TOOL_LIMITS.maxResponseBytes)
        return { content: [{ type: "text", text: encoded }], details: safe };
    const preview = boundedSecretFree(value, {
        ...DEFAULT_PARENT_TOOL_LIMITS,
        maxItems: 8,
        maxTextBytes: 1024,
    });
    const previewText = JSON.stringify(preview);
    const details = Buffer.byteLength(previewText, "utf8") <=
        DEFAULT_PARENT_TOOL_LIMITS.maxResponseBytes
        ? { truncated: true, preview }
        : { truncated: true };
    return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
    };
}
function nonnegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value);
    return (actual.length === keys.length &&
        keys.every((key) => Object.hasOwn(value, key)));
}
function validStarRating(value) {
    if (typeof value !== "string")
        return false;
    const match = /^(★{0,5})(☆{0,5}) ([0-5])\/5$/u.exec(value);
    if (!match)
        return false;
    const filled = match[1]?.length ?? 0;
    const empty = match[2]?.length ?? 0;
    return filled + empty === 5 && filled === Number(match[3]);
}
function ratingCategories(ratings) {
    return [
        `Task fit ${ratings.taskFit}`,
        `Reliability ${ratings.reliability}`,
        `Speed ${ratings.speed}`,
        `Value ${ratings.value}`,
    ].join(" · ");
}
function safeModelOptionText(value, max = 256) {
    try {
        assertInputString(value, max);
        return true;
    }
    catch {
        return false;
    }
}
function parseModelRatings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    const ratings = value;
    if (!hasExactKeys(ratings, [
        "overall",
        "taskFit",
        "reliability",
        "speed",
        "value",
    ]) ||
        !["overall", "taskFit", "reliability", "speed", "value"].every((key) => validStarRating(ratings[key])))
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    return {
        overall: ratings.overall,
        taskFit: ratings.taskFit,
        reliability: ratings.reliability,
        speed: ratings.speed,
        value: ratings.value,
    };
}
function parseModelCapacity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    const capacity = value;
    if (!hasExactKeys(capacity, ["status", "available", "limit"]) ||
        (capacity.status !== "ready" && capacity.status !== "will_queue") ||
        !nonnegativeSafeInteger(capacity.available) ||
        !Number.isSafeInteger(capacity.limit) ||
        Number(capacity.limit) < 1 ||
        Number(capacity.limit) > 32 ||
        Number(capacity.available) > Number(capacity.limit) ||
        (capacity.status === "ready"
            ? Number(capacity.available) < 1
            : Number(capacity.available) !== 0))
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    return {
        status: capacity.status,
        available: Number(capacity.available),
        limit: Number(capacity.limit),
    };
}
function availableAgentModelsResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    const source = value;
    if (!hasExactKeys(source, [
        "profileId",
        "thinkingGuide",
        "availableModels",
        "moreAvailable",
    ]) ||
        !safeModelOptionText(source.profileId) ||
        !Array.isArray(source.thinkingGuide) ||
        source.thinkingGuide.length > THINKING_LEVELS.length ||
        !Array.isArray(source.availableModels) ||
        source.availableModels.length > 16 ||
        !nonnegativeSafeInteger(source.moreAvailable) ||
        source.availableModels.length + source.moreAvailable > 256)
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    const thinkingGuide = source.thinkingGuide.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
        const guide = entry;
        if (!hasExactKeys(guide, ["thinkingLevel", "useFor"]) ||
            !safeModelOptionText(guide.thinkingLevel, 32) ||
            !THINKING_LEVELS.includes(guide.thinkingLevel) ||
            !safeModelOptionText(guide.useFor, 96))
            throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
        return {
            thinkingLevel: guide.thinkingLevel,
            useFor: guide.useFor,
        };
    });
    const usedRanks = new Set();
    const usedModels = new Set();
    let pairCount = 0;
    let previousGroupBestRank = 0;
    const availableModels = source.availableModels.map((candidate, index) => {
        if (!candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate))
            throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
        const option = candidate;
        const expectedKeys = [
            "rank",
            "provider",
            "modelId",
            "recommended",
            "thinkingLevels",
            ...(Object.hasOwn(option, "capacity") ? ["capacity"] : []),
        ];
        if (!hasExactKeys(option, expectedKeys) ||
            !Number.isSafeInteger(option.rank) ||
            Number(option.rank) !== index + 1 ||
            !safeModelOptionText(option.provider) ||
            !safeModelOptionText(option.modelId) ||
            typeof option.recommended !== "boolean" ||
            !Array.isArray(option.thinkingLevels) ||
            option.thinkingLevels.length < 1 ||
            option.thinkingLevels.length > THINKING_LEVELS.length)
            throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
        const modelKey = `${option.provider}\u0000${option.modelId}`;
        if (usedModels.has(modelKey))
            throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
        usedModels.add(modelKey);
        const usedLevels = new Set();
        const thinkingLevels = option.thinkingLevels.map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
                throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
            const thinking = entry;
            if (!hasExactKeys(thinking, [
                "rank",
                "thinkingLevel",
                "recommended",
                "ratings",
            ]) ||
                !Number.isSafeInteger(thinking.rank) ||
                Number(thinking.rank) < 1 ||
                Number(thinking.rank) > 256 ||
                usedRanks.has(Number(thinking.rank)) ||
                !safeModelOptionText(thinking.thinkingLevel, 32) ||
                !THINKING_LEVELS.includes(thinking.thinkingLevel) ||
                usedLevels.has(thinking.thinkingLevel) ||
                typeof thinking.recommended !== "boolean" ||
                thinking.recommended !== (thinking.rank === 1))
                throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
            usedRanks.add(Number(thinking.rank));
            usedLevels.add(thinking.thinkingLevel);
            pairCount++;
            return {
                rank: Number(thinking.rank),
                thinkingLevel: thinking.thinkingLevel,
                recommended: thinking.recommended,
                ratings: parseModelRatings(thinking.ratings),
            };
        });
        if (thinkingLevels.some((level, levelIndex) => levelIndex > 0 &&
            level.rank <= (thinkingLevels[levelIndex - 1]?.rank ?? 0)) ||
            (thinkingLevels[0]?.rank ?? 0) <= previousGroupBestRank ||
            option.recommended !== thinkingLevels.some((level) => level.recommended))
            throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
        previousGroupBestRank = thinkingLevels[0].rank;
        return {
            rank: Number(option.rank),
            provider: option.provider,
            modelId: option.modelId,
            recommended: option.recommended,
            thinkingLevels,
            ...(Object.hasOwn(option, "capacity")
                ? { capacity: parseModelCapacity(option.capacity) }
                : {}),
        };
    });
    if (pairCount > 256)
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    const presentLevels = new Set(availableModels.flatMap((model) => model.thinkingLevels.map((thinking) => thinking.thinkingLevel)));
    const expectedGuide = THINKING_LEVELS.filter((level) => presentLevels.has(level));
    if (thinkingGuide.length !== expectedGuide.length ||
        thinkingGuide.some((guide, index) => guide.thinkingLevel !== expectedGuide[index]) ||
        (availableModels.length > 0 && !availableModels[0]?.recommended))
        throw new Error("MODEL_OPTIONS_RESPONSE_INVALID");
    const details = {
        profileId: source.profileId,
        thinkingGuide,
        availableModels,
        moreAvailable: source.moreAvailable,
    };
    return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
    };
}
function recommendedAgentModel(value, expectedProfileId) {
    const { details } = availableAgentModelsResult(value);
    if (details.profileId !== expectedProfileId)
        throw new Error(`MODEL_OPTIONS_PROFILE_MISMATCH: expected ${expectedProfileId}, received ${details.profileId}`);
    const model = details.availableModels.find((candidate) => candidate.recommended);
    const thinking = model?.thinkingLevels.find((candidate) => candidate.recommended);
    if (!model || !thinking)
        throw new Error(`NO_ELIGIBLE_AGENT_MODEL: no installed, broker-allowed model is available for profile ${expectedProfileId}`);
    return {
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: thinking.thinkingLevel,
    };
}
function oneLineComponent(lines) {
    return {
        render(width) {
            const safeWidth = Math.max(1, Math.floor(width));
            return lines.map((line) => visibleWidth(line) <= safeWidth
                ? line
                : `${truncateToWidth(line, Math.max(0, safeWidth - 1))}…`);
        },
        invalidate() { },
    };
}
function compactLocalCapacity(capacity, theme) {
    const text = capacity.status === "ready"
        ? `local · ${capacity.available}/${capacity.limit} free`
        : "local · will queue";
    return theme.fg(capacity.status === "ready" ? "success" : "warning", text);
}
function renderAvailableAgentModels(result, expanded, theme) {
    const details = result.details;
    if (!details || !Array.isArray(details.availableModels))
        return new Text(result.content[0]?.text ?? "", 0, 0);
    const displayed = expanded
        ? details.availableModels
        : details.availableModels.slice(0, 4);
    const total = details.availableModels.length + details.moreAvailable;
    const guidance = new Map(details.thinkingGuide.map((entry) => [entry.thinkingLevel, entry.useFor]));
    const lines = [
        theme.fg("success", `✓ ${total} available model${total === 1 ? "" : "s"}`) +
            theme.fg("muted", ` for ${details.profileId}`),
    ];
    for (const model of displayed) {
        const marker = model.recommended ? theme.fg("accent", "→") : " ";
        lines.push(`${marker} ${theme.fg("accent", `#${model.rank}`)} ${theme.fg("muted", `${model.provider}/${model.modelId}`)}`);
        if (model.capacity)
            lines.push(`    ${compactLocalCapacity(model.capacity, theme)}`);
        for (const thinking of model.thinkingLevels) {
            const thinkingMarker = thinking.recommended
                ? theme.fg("accent", "→")
                : " ";
            lines.push(`    ${thinkingMarker} ${thinking.thinkingLevel} · ${theme.fg("accent", thinking.ratings.overall)} · ${guidance.get(thinking.thinkingLevel) ?? ""}`);
            if (expanded)
                lines.push(`      ${theme.fg("dim", ratingCategories(thinking.ratings))}`);
        }
    }
    const hidden = details.availableModels.length - displayed.length;
    if (hidden > 0)
        lines.push(theme.fg("dim", `… ${hidden} more returned model${hidden === 1 ? "" : "s"}`));
    if (details.moreAvailable > 0)
        lines.push(theme.fg("warning", `${details.moreAvailable} more available; increase limit to see them.`));
    return oneLineComponent(lines);
}
function validateResultInput(input) {
    assertExactObject(input, [
        "schemaVersion",
        "status",
        "summary",
        "findings",
        "changedFiles",
        "commandsRun",
        "tests",
        "commits",
        "artifacts",
        "unresolved",
        "questions",
        "recommendedNextAction",
    ], [
        "schemaVersion",
        "status",
        "summary",
        "findings",
        "changedFiles",
        "commandsRun",
        "tests",
        "commits",
        "artifacts",
        "unresolved",
        "questions",
        "recommendedNextAction",
    ]);
    if (input.schemaVersion !== 1 ||
        !["succeeded", "failed", "cancelled"].includes(input.status) ||
        typeof input.summary !== "string" ||
        input.summary.length === 0 ||
        Buffer.byteLength(input.summary, "utf8") > 65_536 ||
        (input.recommendedNextAction !== null &&
            (typeof input.recommendedNextAction !== "string" ||
                Buffer.byteLength(input.recommendedNextAction, "utf8") > 8_192)))
        throw new Error("INVALID_REQUEST");
    const arrays = {
        findings: 256,
        changedFiles: 4_096,
        commandsRun: 256,
        tests: 256,
        commits: 64,
        artifacts: 128,
        unresolved: 128,
        questions: 64,
    };
    for (const [key, max] of Object.entries(arrays)) {
        if (!Array.isArray(input[key]) || input[key].length > max)
            throw new Error("INVALID_REQUEST");
        for (const item of input[key])
            validateResultItem(key, item);
    }
    function validateResultItem(key, item) {
        const specs = {
            findings: {
                keys: ["severity", "title", "description", "evidence", "resolved"],
                required: ["severity", "title", "description", "evidence", "resolved"],
            },
            changedFiles: {
                keys: ["path", "change", "previousPath"],
                required: ["path", "change"],
            },
            commandsRun: {
                keys: ["command", "exitCode", "outcome"],
                required: ["command", "exitCode", "outcome"],
            },
            tests: {
                keys: [
                    "name",
                    "command",
                    "status",
                    "passed",
                    "failed",
                    "skipped",
                    "evidence",
                ],
                required: [
                    "name",
                    "command",
                    "status",
                    "passed",
                    "failed",
                    "skipped",
                    "evidence",
                ],
            },
            commits: { keys: ["sha", "subject"], required: ["sha", "subject"] },
            artifacts: {
                keys: ["kind", "path", "description", "mediaType"],
                required: ["kind", "path", "description", "mediaType"],
            },
            unresolved: {
                keys: ["title", "description", "blocking"],
                required: ["title", "description", "blocking"],
            },
            questions: {
                keys: ["questionId", "summary", "answered"],
                required: ["questionId", "summary", "answered"],
            },
        };
        const spec = specs[key];
        if (!spec)
            throw new Error("INVALID_REQUEST");
        assertExactObject(item, spec.keys, spec.required);
        const value = item;
        for (const field of [
            "title",
            "description",
            "summary",
            "subject",
            "path",
            "mediaType",
            "command",
            "name",
        ])
            if (value[field] !== undefined && value[field] !== null)
                assertInputString(value[field], field === "description"
                    ? 8192
                    : field === "path"
                        ? 4096
                        : field === "command"
                            ? 8192
                            : field === "subject"
                                ? 1024
                                : 1024);
        if (key === "findings" &&
            (!["info", "low", "medium", "high", "critical"].includes(value.severity) ||
                typeof value.resolved !== "boolean" ||
                !Array.isArray(value.evidence) ||
                value.evidence.length > 32 ||
                value.evidence.some((item) => {
                    try {
                        assertInputString(item, 4096);
                        return false;
                    }
                    catch {
                        return true;
                    }
                }) ||
                typeof value.title !== "string" ||
                Buffer.byteLength(value.title, "utf8") > 512 ||
                typeof value.description !== "string" ||
                Buffer.byteLength(value.description, "utf8") > 8192))
            throw new Error("INVALID_REQUEST");
        if (key === "changedFiles" &&
            (!["added", "modified", "deleted", "renamed", "unknown"].includes(value.change) ||
                typeof value.path !== "string" ||
                Buffer.byteLength(value.path, "utf8") > 4096 ||
                (value.previousPath !== undefined &&
                    value.previousPath !== null &&
                    (typeof value.previousPath !== "string" ||
                        Buffer.byteLength(value.previousPath, "utf8") > 4096))))
            throw new Error("INVALID_REQUEST");
        if (key === "commandsRun" &&
            (!["passed", "failed", "cancelled", "unknown"].includes(value.outcome) ||
                (value.exitCode !== null &&
                    (!Number.isSafeInteger(value.exitCode) ||
                        value.exitCode < 0 ||
                        value.exitCode > 255))))
            throw new Error("INVALID_REQUEST");
        if (key === "tests" &&
            (!["passed", "failed", "cancelled", "unknown"].includes(value.status) ||
                typeof value.name !== "string" ||
                Buffer.byteLength(value.name, "utf8") > 512 ||
                ["passed", "failed", "skipped"].some((field) => value[field] !== null &&
                    (!Number.isSafeInteger(value[field]) ||
                        value[field] < 0)) ||
                (value.command !== null &&
                    (typeof value.command !== "string" ||
                        Buffer.byteLength(value.command, "utf8") > 8192)) ||
                (value.evidence !== null &&
                    (typeof value.evidence !== "string" ||
                        Buffer.byteLength(value.evidence, "utf8") > 4096))))
            throw new Error("INVALID_REQUEST");
        if (key === "commits" &&
            (typeof value.sha !== "string" || !/^[0-9a-fA-F]{7,64}$/u.test(value.sha)))
            throw new Error("INVALID_REQUEST");
        if (key === "artifacts" &&
            (!["text", "json", "patch", "log", "report", "other"].includes(value.kind) ||
                typeof value.description !== "string" ||
                Buffer.byteLength(value.description, "utf8") > 1024 ||
                typeof value.mediaType !== "string" ||
                Buffer.byteLength(value.mediaType, "utf8") > 128))
            throw new Error("INVALID_REQUEST");
        if (key === "unresolved" &&
            (typeof value.blocking !== "boolean" ||
                typeof value.title !== "string" ||
                Buffer.byteLength(value.title, "utf8") > 512))
            throw new Error("INVALID_REQUEST");
        if (key === "questions" &&
            (typeof value.answered !== "boolean" ||
                typeof value.questionId !== "string" ||
                !/^qst_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.questionId)))
            throw new Error("INVALID_REQUEST");
    }
}
function validateQuestionInput(input) {
    assertExactObject(input, [
        "schemaVersion",
        "prompt",
        "context",
        "options",
        "allowFreeform",
        "defaultOptionId",
        "timeoutMs",
    ], [
        "schemaVersion",
        "prompt",
        "context",
        "options",
        "allowFreeform",
        "defaultOptionId",
        "timeoutMs",
    ]);
    if (input.schemaVersion !== 1 ||
        typeof input.prompt !== "string" ||
        Buffer.byteLength(input.prompt, "utf8") > 16_384 ||
        input.prompt.length === 0 ||
        (input.context !== null && typeof input.context !== "string") ||
        (typeof input.context === "string" &&
            Buffer.byteLength(input.context, "utf8") > 16_384) ||
        typeof input.allowFreeform !== "boolean" ||
        !Array.isArray(input.options) ||
        input.options.length > 8 ||
        (input.options.length === 0 && input.allowFreeform === false) ||
        (input.defaultOptionId !== null &&
            (typeof input.defaultOptionId !== "string" ||
                !/^[A-Za-z0-9_-]{1,32}$/u.test(input.defaultOptionId))) ||
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs < 10_000 ||
        input.timeoutMs > 86_400_000)
        throw new Error("INVALID_REQUEST");
    for (const option of input.options) {
        assertExactObject(option, ["id", "label", "description"], ["id", "label", "description"]);
        if (typeof option.id !== "string" ||
            !/^[A-Za-z0-9_-]{1,32}$/u.test(option.id) ||
            typeof option.label !== "string" ||
            option.label.length === 0 ||
            Buffer.byteLength(option.label, "utf8") > 1_024 ||
            (option.description !== null && typeof option.description !== "string") ||
            (typeof option.description === "string" &&
                Buffer.byteLength(option.description, "utf8") > 4_096))
            throw new Error("INVALID_REQUEST");
    }
}
function validateQuestionAck(value, assignment, toolCallId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_REQUEST");
    const ack = value;
    const state = ack.state;
    const keys = state === "answered"
        ? [
            "questionId",
            "runId",
            "assignmentGeneration",
            "toolCallId",
            "state",
            "answer",
        ]
        : ["questionId", "runId", "assignmentGeneration", "toolCallId", "state"];
    assertExactObject(ack, keys, keys);
    if (typeof ack.questionId !== "string" ||
        ack.questionId.length === 0 ||
        Buffer.byteLength(ack.questionId, "utf8") > 256 ||
        /[\u0000-\u001f\u007f]/u.test(ack.questionId) ||
        typeof ack.runId !== "string" ||
        ack.runId.length === 0 ||
        Buffer.byteLength(ack.runId, "utf8") > 256 ||
        /[\u0000-\u001f\u007f]/u.test(ack.runId) ||
        typeof ack.toolCallId !== "string" ||
        ack.toolCallId.length === 0 ||
        Buffer.byteLength(ack.toolCallId, "utf8") > 256 ||
        /[\u0000-\u001f\u007f]/u.test(ack.toolCallId) ||
        !Number.isSafeInteger(ack.assignmentGeneration) ||
        !["open", "answered", "cancelled", "timed_out"].includes(state) ||
        ack.runId !== assignment.runId ||
        ack.assignmentGeneration !== assignment.assignmentGeneration ||
        ack.toolCallId !== toolCallId)
        throw new Error("RUN_MISMATCH");
    if (state === "answered") {
        const answer = ack.answer;
        if (!answer || typeof answer !== "object" || Array.isArray(answer))
            throw new Error("INVALID_REQUEST");
        assertExactObject(answer, ["optionId", "text"], ["optionId", "text"]);
        const item = answer;
        if ((item.optionId !== null &&
            (typeof item.optionId !== "string" ||
                item.optionId.length === 0 ||
                Buffer.byteLength(item.optionId, "utf8") > 32 ||
                !/^[A-Za-z0-9_-]{1,32}$/u.test(item.optionId))) ||
            (item.text !== null &&
                (typeof item.text !== "string" ||
                    item.text.length === 0 ||
                    Buffer.byteLength(item.text, "utf8") > 16_384 ||
                    /[\u0000-\u001f\u007f]/u.test(item.text))) ||
            (item.optionId === null && item.text === null))
            throw new Error("INVALID_REQUEST");
        return {
            questionId: ack.questionId,
            state,
            runId: ack.runId,
            assignmentGeneration: ack.assignmentGeneration,
            toolCallId: ack.toolCallId,
            answer: {
                optionId: item.optionId,
                text: item.text,
            },
        };
    }
    return {
        questionId: ack.questionId,
        state: state,
        runId: ack.runId,
        assignmentGeneration: ack.assignmentGeneration,
        toolCallId: ack.toolCallId,
    };
}
function assertBoundedBody(value) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES)
        throw new Error("LIMIT_EXCEEDED");
}
export function registerManagedChildTools(api, adapterOrBinding, client) {
    const binding = client
        ? { adapter: adapterOrBinding, client }
        : adapterOrBinding;
    register(api, {
        name: "orchestrator_review_submit",
        label: "Submit independent review",
        description: "Submit one bounded quality score for the broker-issued review contract bound to the current managed task.",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: ["valuePpm", "confidencePpm"],
            properties: {
                valuePpm: { type: "integer", minimum: 0, maximum: 1_000_000 },
                confidencePpm: {
                    type: "integer",
                    minimum: 0,
                    maximum: 1_000_000,
                },
            },
        },
        async execute(_id, params, signal) {
            if (signal.aborted)
                throw new Error("CANCELLED");
            const adapter = binding.adapter;
            const client = binding.client;
            if (!adapter || !client || !client.connected)
                throw new Error("AGENT_DISCONNECTED");
            const assignment = adapter.assignmentForTools();
            if (!assignment)
                throw new Error("RUN_MISMATCH");
            if (!Number.isSafeInteger(params.valuePpm) ||
                Number(params.valuePpm) < 0 ||
                Number(params.valuePpm) > 1_000_000 ||
                !Number.isSafeInteger(params.confidencePpm) ||
                Number(params.confidencePpm) < 0 ||
                Number(params.confidencePpm) > 1_000_000)
                throw new Error("INVALID_REQUEST");
            const result = await client.request("review.submit", {
                agentId: assignment.agentId,
                taskId: assignment.taskId,
                runId: assignment.runId,
                assignmentGeneration: assignment.assignmentGeneration,
                valuePpm: params.valuePpm,
                confidencePpm: params.confidencePpm,
            });
            return textResult(result);
        },
    });
    register(api, {
        name: "orchestrator_result",
        label: "Publish orchestrator result",
        description: "Publish the single structured terminal result for the current managed task. Correlation identity is supplied by the adapter.",
        parameters: resultSchema,
        async execute(_id, params, signal) {
            if (signal.aborted)
                throw new Error("CANCELLED");
            const adapter = binding.adapter;
            const client = binding.client;
            if (!adapter || !client || !client.connected)
                throw new Error("AGENT_DISCONNECTED");
            const assignment = adapter.assignmentForTools();
            if (!assignment)
                throw new Error("RUN_MISMATCH");
            validateResultInput(params);
            assertBoundedBody(params);
            const result = await client.request("result.publish", {
                agentId: assignment.agentId,
                taskId: assignment.taskId,
                runId: assignment.runId,
                assignmentGeneration: assignment.assignmentGeneration,
                result: params,
            });
            return textResult(result);
        },
    });
    register(api, {
        name: "orchestrator_ask",
        label: "Ask orchestrator question",
        description: "Ask one blocking structured question for the current managed task. Correlation identity is supplied by the adapter.",
        parameters: questionSchema,
        async execute(_id, params, signal) {
            if (signal.aborted)
                throw new Error("CANCELLED");
            const adapter = binding.adapter;
            const client = binding.client;
            if (!adapter || !client || !client.connected)
                throw new Error("AGENT_DISCONNECTED");
            const assignment = adapter.assignmentForTools();
            if (!assignment)
                throw new Error("RUN_MISMATCH");
            validateQuestionInput(params);
            assertBoundedBody(params);
            api.events?.emit("herdr:blocked", {
                active: true,
                label: "Waiting for an orchestrator answer",
            });
            try {
                const waiter = client.registerQuestionWaiter(_id, assignment.runId, params.timeoutMs, signal);
                void waiter.catch(() => undefined);
                let openPromise;
                try {
                    openPromise = client.request("question.open", {
                        agentId: assignment.agentId,
                        taskId: assignment.taskId,
                        runId: assignment.runId,
                        assignmentGeneration: assignment.assignmentGeneration,
                        toolCallId: _id,
                        question: params,
                    });
                }
                catch (error) {
                    client.discardQuestionWaiter(_id);
                    throw error;
                }
                void openPromise.catch(() => undefined);
                let ack;
                try {
                    const first = await Promise.race([
                        openPromise.then((value) => ({ kind: "ack", value })),
                        waiter.then((value) => ({ kind: "waiter", value })),
                    ]);
                    if (first.kind === "waiter") {
                        const earlyQuestionId = typeof client.questionIdForToolCall === "function"
                            ? client.questionIdForToolCall(_id)
                            : undefined;
                        void openPromise.then((lateAck) => {
                            try {
                                const parsedLateAck = validateQuestionAck(lateAck, assignment, _id);
                                if (earlyQuestionId !== undefined &&
                                    parsedLateAck.questionId !== earlyQuestionId)
                                    throw new Error("QUESTION_DELIVERY_INVALID");
                            }
                            catch {
                                client.close();
                            }
                            finally {
                                client.discardQuestionWaiter(_id);
                            }
                        }, () => {
                            client.discardQuestionWaiter(_id);
                        });
                        return textResult(first.value);
                    }
                    ack = first.value;
                }
                catch (error) {
                    client.discardQuestionWaiter(_id);
                    throw error;
                }
                let parsedAck;
                try {
                    parsedAck = validateQuestionAck(ack, assignment, _id);
                }
                catch (error) {
                    client.discardQuestionWaiter(_id);
                    throw error;
                }
                if (parsedAck.state !== "open") {
                    client.discardQuestionWaiter(_id);
                    return textResult({
                        state: parsedAck.state,
                        ...(parsedAck.state === "answered"
                            ? { answer: parsedAck.answer }
                            : {}),
                    });
                }
                try {
                    client.bindQuestionWaiter(_id, parsedAck.questionId);
                }
                catch (error) {
                    client.discardQuestionWaiter(_id);
                    throw error;
                }
                try {
                    const answer = await waiter;
                    return textResult(answer);
                }
                finally {
                    client.discardQuestionWaiter(_id);
                }
            }
            finally {
                api.events?.emit("herdr:blocked", { active: false });
            }
        },
    });
}
function waitForParentPoll(delayMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("CANCELLED"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("CANCELLED"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        timer.unref?.();
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function executeParentWaitRequest(service, request, principal, signal, deadline) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("CANCELLED"));
            return;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            resolve(undefined);
            return;
        }
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(new Error("CANCELLED"));
        };
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(undefined);
        }, remainingMs);
        timer.unref?.();
        signal.addEventListener("abort", onAbort, { once: true });
        void service.execute(request, principal, signal).then((response) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(response);
        }, (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        });
    });
}
async function waitForDelegation(service, response, principal, signal, timeoutMs, waitUntil) {
    if (!response.ok)
        return response;
    const initial = response.result;
    const initialTasks = Array.isArray(initial?.tasks) ? initial.tasks : [];
    const taskIds = initialTasks
        .map((item) => item && typeof item === "object" && !Array.isArray(item)
        ? item.taskId
        : undefined)
        .filter((id) => typeof id === "string");
    if (taskIds.length === 0)
        return response;
    const wanted = new Set(waitUntil);
    const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
    const deadline = Date.now() + timeoutMs;
    let latestTasks = initialTasks;
    while (Date.now() < deadline) {
        const snapshots = [];
        for (const taskId of taskIds) {
            let next;
            do {
                next = await executeParentWaitRequest(service, { tool: "task_get", input: { taskId } }, principal, signal, deadline);
                if (!next)
                    throw new Error("WAIT_TIMEOUT");
                if (!next.ok &&
                    next.error?.code === "AGENT_DISCONNECTED" &&
                    Date.now() < deadline) {
                    await waitForParentPoll(Math.min(100, Math.max(1, deadline - Date.now())), signal);
                    next = undefined;
                }
            } while (!next);
            if (!next.ok)
                return next;
            if (next.result && typeof next.result === "object")
                snapshots.push(next.result);
        }
        latestTasks = initialTasks.map((item) => {
            const initialTask = item;
            const snapshot = snapshots.find((candidate) => candidate.id === initialTask.taskId);
            return snapshot
                ? {
                    ...initialTask,
                    ...(typeof snapshot.state === "string"
                        ? { state: snapshot.state }
                        : {}),
                }
                : initialTask;
        });
        const states = snapshots.map((task) => String(task.state));
        const blocked = states.some((state) => state === "blocked");
        const allTerminal = states.length === taskIds.length &&
            states.every((state) => terminal.has(state));
        if ((wanted.has("blocked") && blocked) ||
            (wanted.has("terminal") && allTerminal)) {
            const state = blocked
                ? "blocked"
                : states.every((item) => item === "succeeded")
                    ? "succeeded"
                    : "failed";
            return {
                ...response,
                result: { ...initial, state, tasks: latestTasks },
            };
        }
        await waitForParentPoll(Math.min(100, Math.max(1, deadline - Date.now())), signal);
    }
    throw new Error("WAIT_TIMEOUT");
}
const FACADE_RUN_REQUEST_TIMEOUT_MS = 120_000;
const ORCHESTRATE_ACTIONS = [
    "run",
    "models",
    "inspect",
    "list",
    "wait",
    "collect",
    "cancel",
    "close",
];
const orchestrateInputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
        action: {
            type: "string",
            enum: ORCHESTRATE_ACTIONS,
            description: 'Use "run" with only task for normal creation. Other actions manage the returned taskId.',
        },
        task: {
            type: "object",
            additionalProperties: false,
            required: ["title", "objective"],
            properties: {
                title: boundedString(512),
                objective: boundedString(16_384),
                constraints: {
                    type: "array",
                    maxItems: 64,
                    items: boundedString(16_384),
                },
            },
        },
        profileId: {
            type: "string",
            enum: SHIPPED_TASK_PROFILES,
            description: 'Optional task role. "run" and "models" default to the safe read-only "scout" profile.',
        },
        modelProfileId: { type: "string", enum: ["manager", "subagent"] },
        model: {
            type: "object",
            description: "Optional exact override. If omitted, run uses the broker's highest-ranked installed and allowed recommendation.",
            additionalProperties: false,
            required: ["provider", "modelId", "thinkingLevel"],
            properties: {
                provider: boundedString(128),
                modelId: boundedString(256),
                thinkingLevel: { type: "string", enum: THINKING_LEVELS },
            },
        },
        placement: {
            type: "string",
            enum: ["current-workspace", "new-workspace"],
        },
        lifecycleClass: {
            type: "string",
            enum: ["temporary", "reusable", "retained", "pinned"],
        },
        keepForReuse: { type: "boolean" },
        project: {
            type: "object",
            additionalProperties: false,
            required: ["cwd"],
            properties: { cwd: boundedString(4096) },
        },
        isolation: {
            type: "object",
            additionalProperties: false,
            required: ["mode"],
            properties: {
                mode: { type: "string", enum: ["shared-readonly", "worktree"] },
            },
        },
        budget: {
            type: "object",
            additionalProperties: false,
            required: ["wallTimeMs"],
            properties: {
                wallTimeMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
            },
        },
        review: { type: "object", maxProperties: 8 },
        wait: { type: "boolean" },
        kind: { type: "string", enum: ["task", "agent", "group"] },
        id: boundedString(256),
        projectKey: boundedString(4096),
        taskId: boundedString(256),
        taskIds: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: boundedString(256),
        },
        include: {
            type: "array",
            maxItems: 16,
            items: boundedString(64),
        },
        select: {
            type: "array",
            maxItems: 16,
            items: boundedString(64),
        },
        state: boundedString(64),
        limit: { type: "integer", minimum: 1, maximum: 500 },
        maxBytes: { type: "integer", minimum: 1, maximum: 262_144 },
        until: {
            type: "array",
            maxItems: 16,
            items: boundedString(64),
        },
        timeoutMs: { type: "integer", minimum: 1, maximum: 1_800_000 },
        reason: boundedString(16_384),
        cascade: { type: "boolean" },
        confirm: { type: "boolean" },
        idempotencyKey: boundedString(256),
    },
};
const FACADE_KEYS = Object.freeze({
    run: [
        "action",
        "task",
        "profileId",
        "modelProfileId",
        "model",
        "placement",
        "lifecycleClass",
        "keepForReuse",
        "project",
        "isolation",
        "budget",
        "review",
        "wait",
        "idempotencyKey",
    ],
    models: [
        "action",
        "profileId",
        "placement",
        "modelProfileId",
        "projectKey",
        "limit",
        "idempotencyKey",
    ],
    inspect: ["action", "kind", "id", "include", "maxBytes", "idempotencyKey"],
    list: [
        "action",
        "kind",
        "state",
        "profileId",
        "limit",
        "maxBytes",
        "idempotencyKey",
    ],
    wait: ["action", "taskId", "until", "timeoutMs", "idempotencyKey"],
    collect: ["action", "taskIds", "select", "maxBytes", "idempotencyKey"],
    cancel: ["action", "taskId", "reason", "cascade", "idempotencyKey"],
    close: ["action", "taskId", "reason", "confirm", "idempotencyKey"],
});
export function registerParentTools(api, adapterOrBinding, client) {
    const binding = client
        ? {
            adapter: adapterOrBinding,
            client,
            parentAuthorized: client.principal?.permissions.includes("delegate") === true ||
                client.principal?.permissions.includes("manage:all") === true,
        }
        : adapterOrBinding;
    const principalFromClient = () => {
        const adapter = binding.adapter;
        const activeClient = binding.client;
        if (!adapter || !activeClient || !activeClient.connected)
            throw new Error("AGENT_DISCONNECTED");
        const principal = activeClient.principal;
        if (!principal?.id || !Array.isArray(principal.permissions))
            throw new Error("BROKER_PRINCIPAL_UNAVAILABLE");
        return {
            id: principal.id,
            kind: principal.kind,
            permissions: principal.permissions,
            ...(principal.agentId ? { agentId: principal.agentId } : {}),
        };
    };
    const service = new ParentToolService({
        invoke: async (method, params, _principal, idempotencyKey) => {
            const activeClient = binding.client;
            if (!activeClient?.connected)
                throw new Error("AGENT_DISCONNECTED");
            return activeClient.request(method, params, {
                ...(idempotencyKey ? { idempotencyKey } : {}),
                ...(method === "agent.spawn"
                    ? { timeoutMs: FACADE_RUN_REQUEST_TIMEOUT_MS }
                    : {}),
            });
        },
    });
    const invoke = async (tool, input, principal, signal, idempotencyKey) => {
        validateParentInput(tool, input);
        const request = {
            tool,
            input,
            ...(idempotencyKey ? { idempotencyKey } : {}),
        };
        if (!isParentToolRequest(request))
            throw new Error("INVALID_REQUEST");
        const response = await service.execute(request, principal, signal);
        if (response.ok)
            return response.result;
        const failure = new Error(response.error?.message ?? "REQUEST_FAILED");
        if (response.error?.code !== undefined)
            failure.code = response.error.code;
        if (response.error?.details !== undefined)
            failure.details = response.error.details;
        if (response.error?.remediation !== undefined)
            failure.remediation = response.error.remediation;
        throw failure;
    };
    register(api, {
        name: "orchestrate",
        label: "Orchestrate Agents",
        description: 'Create an agent with action "run" and only a task; omitted profile defaults to scout and omitted model uses the broker\'s top installed, allowed recommendation. Optional fields override those safe defaults. Use the returned taskId for inspect, wait, collect, cancel, and close; the broker derives agent, run, and generation identity for cleanup.',
        parameters: orchestrateInputSchema,
        async execute(_id, params, signal, _onUpdate, context) {
            assertExactObject(params, [
                ...new Set(Object.values(FACADE_KEYS).flat()),
            ]);
            const action = params.action;
            if (!ORCHESTRATE_ACTIONS.includes(action))
                throw new Error("INVALID_REQUEST");
            const allowed = FACADE_KEYS[action];
            const unsupported = Object.keys(params).filter((key) => !allowed.includes(key));
            if (unsupported.length > 0)
                throw new Error(`ORCHESTRATE_INVALID_ARGUMENTS: action ${String(action)} does not accept ${unsupported.join(", ")}; allowed fields are ${allowed.join(", ")}`);
            const { idempotencyKey } = params;
            if (idempotencyKey !== undefined)
                assertInputString(idempotencyKey, 256);
            const principal = principalFromClient();
            const requestKey = idempotencyKey;
            let result;
            if (action === "run") {
                const profileId = params.profileId ?? "scout";
                assertInputString(profileId, 256);
                if (!SHIPPED_TASK_PROFILES.includes(profileId))
                    throw new Error(`ORCHESTRATE_PROFILE_INVALID: ${String(profileId)}`);
                const input = { ...params, profileId };
                delete input.action;
                delete input.idempotencyKey;
                if (input.project === undefined) {
                    if (!context || typeof context.cwd !== "string")
                        throw new Error("ORCHESTRATE_PROJECT_REQUIRED: run needs a project cwd when Pi does not provide the current cwd");
                    input.project = { cwd: context.cwd };
                }
                const projectCwd = input.project.cwd;
                assertInputString(projectCwd, 4096);
                input.placement ??= "current-workspace";
                input.isolation ??= {
                    mode: profileId === "implementer" ? "worktree" : "shared-readonly",
                };
                input.wait ??= false;
                input.budget ??= { wallTimeMs: 900_000 };
                if (input.model === undefined) {
                    const optionsInput = {
                        profileId,
                        placement: input.placement,
                        projectKey: projectCwd,
                        ...(input.modelProfileId !== undefined
                            ? { modelProfileId: input.modelProfileId }
                            : {}),
                        limit: 1,
                    };
                    const options = await invoke("agent_model_options", optionsInput, principal, signal, undefined);
                    input.model = recommendedAgentModel(options, profileId);
                }
                result = withLaunchLifecycleReminder("agent_spawn", input, await invoke("agent_spawn", input, principal, signal, requestKey));
            }
            else if (action === "models") {
                const profileId = params.profileId ?? "scout";
                assertInputString(profileId, 256);
                const input = {
                    profileId,
                    ...(params.placement !== undefined
                        ? { placement: params.placement }
                        : {}),
                    ...(params.modelProfileId !== undefined
                        ? { modelProfileId: params.modelProfileId }
                        : {}),
                    ...(params.projectKey !== undefined
                        ? { projectKey: params.projectKey }
                        : {}),
                    limit: params.limit ?? 16,
                };
                result = await invoke("agent_model_options", input, principal, signal, requestKey);
            }
            else if (action === "inspect") {
                assertInputString(params.id, 256);
                const kind = params.kind;
                const tool = kind === "task"
                    ? "task_get"
                    : kind === "agent"
                        ? "agent_get"
                        : kind === "group"
                            ? "group_get"
                            : undefined;
                if (!tool)
                    throw new Error("INVALID_REQUEST");
                const input = {
                    [kind === "task"
                        ? "taskId"
                        : kind === "agent"
                            ? "agentId"
                            : "groupId"]: params.id,
                    ...(params.include !== undefined ? { include: params.include } : {}),
                    ...(params.maxBytes !== undefined
                        ? { maxBytes: params.maxBytes }
                        : {}),
                };
                result = await invoke(tool, input, principal, signal, requestKey);
            }
            else if (action === "list") {
                const kind = params.kind;
                const tool = kind === "task"
                    ? "task_list"
                    : kind === "agent"
                        ? "agent_list"
                        : kind === "group"
                            ? "group_list"
                            : undefined;
                if (!tool)
                    throw new Error("INVALID_REQUEST");
                const input = {
                    ...(params.state !== undefined ? { state: params.state } : {}),
                    ...(params.profileId !== undefined
                        ? { profileId: params.profileId }
                        : {}),
                    ...(params.limit !== undefined ? { limit: params.limit } : {}),
                    ...(params.maxBytes !== undefined
                        ? { maxBytes: params.maxBytes }
                        : {}),
                };
                result = await invoke(tool, input, principal, signal, requestKey);
            }
            else if (action === "wait") {
                assertInputString(params.taskId, 256);
                const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 120_000;
                const input = {
                    kind: "task",
                    targetId: params.taskId,
                    until: params.until ?? [
                        "succeeded",
                        "failed",
                        "cancelled",
                        "timed_out",
                        "blocked",
                    ],
                    timeoutMs,
                    pollMs: 100,
                };
                const request = {
                    tool: "coordination_wait",
                    input,
                    ...(requestKey ? { idempotencyKey: requestKey } : {}),
                };
                validateParentInput("coordination_wait", input);
                const deadline = Date.now() + timeoutMs;
                let response = await executeParentWaitRequest(service, request, principal, signal, deadline);
                while (response?.ok &&
                    response.result?.ready !==
                        true &&
                    Date.now() < deadline) {
                    await waitForParentPoll(Math.min(100, Math.max(1, deadline - Date.now())), signal);
                    response = await executeParentWaitRequest(service, { tool: "coordination_wait", input }, principal, signal, deadline);
                }
                if (!response)
                    throw new Error("WAIT_TIMEOUT");
                if (!response.ok)
                    throw new Error(response.error?.message ?? "REQUEST_FAILED");
                const waitResult = response.result;
                result = {
                    taskId: params.taskId,
                    state: waitResult.state,
                    ready: waitResult.ready,
                };
            }
            else if (action === "collect") {
                result = await invoke("task_collect", {
                    taskIds: params.taskIds,
                    ...(params.select !== undefined ? { select: params.select } : {}),
                    ...(params.maxBytes !== undefined
                        ? { maxBytes: params.maxBytes }
                        : {}),
                }, principal, signal, requestKey);
            }
            else if (action === "cancel") {
                result = await invoke("task_cancel", {
                    taskId: params.taskId,
                    reason: params.reason ?? "Cancelled through the orchestration facade.",
                    cascade: params.cascade ?? false,
                }, principal, signal, requestKey);
            }
            else {
                if (params.confirm !== true)
                    throw new Error("INVALID_REQUEST");
                const task = (await invoke("task_get", { taskId: params.taskId }, principal, signal, undefined));
                const agentId = task?.assignedAgentId;
                if (typeof agentId !== "string")
                    throw new Error("AGENT_NOT_FOUND");
                const agent = (await invoke("agent_get", { agentId }, principal, signal, undefined));
                if (agent?.managedResourceState === "closed") {
                    result = {
                        taskId: params.taskId,
                        agentId,
                        state: "closed",
                        alreadyClosed: true,
                    };
                }
                else {
                    const assignmentGeneration = agent?.currentAssignmentGeneration;
                    result = await invoke("agent_close", {
                        agentId,
                        ...(typeof task?.currentRunId === "string"
                            ? { runId: task.currentRunId }
                            : {}),
                        ...(Number.isSafeInteger(assignmentGeneration) &&
                            Number(assignmentGeneration) > 0
                            ? { assignmentGeneration }
                            : {}),
                        reason: params.reason ?? "Closed through the orchestration facade.",
                        confirm: true,
                    }, principal, signal, requestKey);
                }
            }
            return textResult(result);
        },
    });
    if (process.env.PI_HERDR_ORCH_ADVANCED_TOOLS === "1")
        registerAdvancedParentTools(api, binding);
}
export function registerAdvancedParentTools(api, adapterOrBinding, client) {
    const binding = client
        ? {
            adapter: adapterOrBinding,
            client,
            parentAuthorized: client.principal?.permissions.includes("delegate") === true ||
                client.principal?.permissions.includes("manage:all") === true,
        }
        : adapterOrBinding;
    const principalFromClient = () => {
        const adapter = binding.adapter;
        const client = binding.client;
        if (!adapter || !client || !client.connected)
            throw new Error("AGENT_DISCONNECTED");
        const p = client.principal;
        if (!p || !p.id || !Array.isArray(p.permissions))
            throw new Error("BROKER_PRINCIPAL_UNAVAILABLE");
        return {
            id: p.id,
            kind: p.kind,
            permissions: p.permissions,
            ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
        };
    };
    const broker = {
        invoke: async (method, params, _principal, idempotencyKey) => {
            const client = binding.client;
            if (!client?.connected)
                throw new Error("AGENT_DISCONNECTED");
            return client.request(method, params, idempotencyKey ? { idempotencyKey } : {});
        },
    };
    const service = new ParentToolService(broker);
    for (const tool of PARENT_TOOL_NAMES) {
        register(api, {
            name: tool,
            label: tool === "agent_model_options"
                ? "Available Agent Models"
                : `Orchestrator ${tool}`,
            description: tool === "agent_model_options"
                ? "List only Pi-available, broker-allowed models for this task profile. Each model groups its thinking levels with simple five-star ratings and selection guidance. Slot capacity appears only for explicitly local compute."
                : `Use broker method for ${tool}. The broker checks current state and parent scope on every call.`,
            parameters: parentInputSchema(tool),
            ...(tool === "agent_model_options"
                ? {
                    renderResult(result, options, theme) {
                        return renderAvailableAgentModels(result, options.expanded, theme);
                    },
                }
                : {}),
            async execute(_id, params, signal) {
                const { idempotencyKey, ...provided } = params;
                const modelOptionsInput = tool === "agent_model_options" && provided.limit === undefined
                    ? { ...provided, limit: 16 }
                    : provided;
                const raw = tool === "coordination_wait" && modelOptionsInput.kind === "timer"
                    ? {
                        ...modelOptionsInput,
                        startedAt: typeof modelOptionsInput.startedAt === "string"
                            ? modelOptionsInput.startedAt
                            : new Date().toISOString(),
                    }
                    : modelOptionsInput;
                if (idempotencyKey !== undefined)
                    assertInputString(idempotencyKey, 256);
                if ((tool === "delegate" || tool === "delegate_compact") &&
                    binding.parentAuthorized !== true)
                    throw new Error("PERMISSION_DENIED");
                const principal = principalFromClient();
                const adapter = binding.adapter;
                const client = binding.client;
                if (!adapter || !client)
                    throw new Error("AGENT_DISCONNECTED");
                validateParentInput(tool, raw);
                const request = {
                    tool: tool,
                    input: raw,
                    ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
                };
                if (!isParentToolRequest(request))
                    throw new Error("INVALID_REQUEST");
                let response;
                if (tool === "agent_wait" ||
                    tool === "coordination_wait" ||
                    tool === "group_wait") {
                    const until = new Set(Array.isArray(raw.until) ? raw.until : []);
                    const deadline = Date.now() + raw.timeoutMs;
                    const initial = await executeParentWaitRequest(service, request, principal, signal, deadline);
                    if (!initial)
                        throw new Error("WAIT_TIMEOUT");
                    response = initial;
                    const pollRequest = {
                        tool: request.tool,
                        input: request.input,
                    };
                    while (response.ok &&
                        (tool === "agent_wait"
                            ? !until.has(String(response.result
                                ?.state))
                            : response.result
                                ?.ready !== true) &&
                        Date.now() < deadline) {
                        await waitForParentPoll(Math.min(100, Math.max(1, deadline - Date.now())), signal);
                        const next = await executeParentWaitRequest(service, pollRequest, principal, signal, deadline);
                        if (!next)
                            break;
                        response = next;
                    }
                }
                else {
                    response = await service.execute(request, principal, signal);
                    if ((tool === "delegate" || tool === "delegate_compact") &&
                        raw.wait === true &&
                        raw.dryRun !== true &&
                        response.ok)
                        response = await waitForDelegation(service, response, principal, signal, typeof raw.timeoutMs === "number" ? raw.timeoutMs : 120_000, Array.isArray(raw.waitUntil)
                            ? raw.waitUntil
                            : ["terminal", "blocked"]);
                }
                if (!response.ok) {
                    const error = boundedSecretFree(response.error ?? {
                        code: "REQUEST_FAILED",
                        message: "The broker rejected the parent tool request.",
                    });
                    const content = JSON.stringify(error);
                    return {
                        content: [{ type: "text", text: content }],
                        details: error,
                        isError: true,
                    };
                }
                const result = withLaunchLifecycleReminder(tool, raw, response.result);
                return tool === "agent_model_options"
                    ? availableAgentModelsResult(result)
                    : textResult(result);
            },
        });
    }
}
export function registerOrchestratorTools(api, binding, managed, permissions = []) {
    if (managed)
        registerManagedChildTools(api, binding);
    if (!managed ||
        permissions.includes("delegate") ||
        permissions.includes("manage:all"))
        registerParentTools(api, binding);
    binding.parentAuthorized =
        permissions.includes("delegate") || permissions.includes("manage:all");
}
