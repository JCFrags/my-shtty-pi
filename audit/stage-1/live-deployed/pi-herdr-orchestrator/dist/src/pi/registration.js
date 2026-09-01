const MAX_TEXT = 256;
const MAX_TOOLS = 128;
const MAX_TOOL_NAME = 128;
function text(value, field) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_TEXT ||
        /[\u0000-\u001f\u007f]/u.test(value))
        throw new Error(`PI_REGISTRATION_${field.toUpperCase()}_INVALID`);
    return value;
}
function generation(value) {
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("PI_REGISTRATION_GENERATION_INVALID");
    return value;
}
function capabilities(value) {
    if (!value || typeof value !== "object")
        throw new Error("PI_REGISTRATION_CAPABILITIES_INVALID");
    const source = value;
    const keys = [
        "core",
        "prompt",
        "steer",
        "followUp",
        "abort",
        "compact",
        "model",
        "thinking",
        "tools",
        "toolExpansion",
    ];
    if (Object.keys(source).some((key) => !keys.includes(key)) ||
        keys.some((key) => typeof source[key] !== "boolean"))
        throw new Error("PI_REGISTRATION_CAPABILITIES_INVALID");
    return Object.fromEntries(keys.map((key) => [key, source[key]]));
}
export function validateRegistrationPayload(value) {
    if (!value || typeof value !== "object")
        throw new Error("PI_REGISTRATION_PAYLOAD_INVALID");
    const source = value;
    const allowed = new Set([
        "adapterVersion",
        "agentId",
        "generation",
        "herdr",
        "pi",
    ]);
    if (Object.keys(source).some((key) => !allowed.has(key)))
        throw new Error("PI_REGISTRATION_PAYLOAD_INVALID");
    if (!source.herdr ||
        typeof source.herdr !== "object" ||
        !source.pi ||
        typeof source.pi !== "object")
        throw new Error("PI_REGISTRATION_PAYLOAD_INVALID");
    const herdr = source.herdr, pi = source.pi;
    const herdrKeys = new Set(["paneId", "terminalId", "detectedKind", "name"]);
    if (Object.keys(herdr).some((key) => !herdrKeys.has(key)) ||
        herdr.detectedKind !== "pi")
        throw new Error("PI_REGISTRATION_HERDR_INVALID");
    const piKeys = new Set(["sessionId", "activity", "capabilities"]);
    if (Object.keys(pi).some((key) => !piKeys.has(key)) ||
        (pi.activity !== "idle" && pi.activity !== "working"))
        throw new Error("PI_REGISTRATION_PI_INVALID");
    return {
        adapterVersion: text(source.adapterVersion, "adapter_version"),
        ...(source.agentId === undefined
            ? {}
            : { agentId: text(source.agentId, "agent_id") }),
        ...(source.generation === undefined
            ? {}
            : { generation: generation(source.generation) }),
        herdr: {
            paneId: text(herdr.paneId, "pane_id"),
            ...(herdr.terminalId === undefined
                ? {}
                : { terminalId: text(herdr.terminalId, "terminal_id") }),
            detectedKind: "pi",
            ...(herdr.name === undefined ? {} : { name: text(herdr.name, "name") }),
        },
        pi: {
            sessionId: text(pi.sessionId, "session_id"),
            activity: pi.activity,
            capabilities: capabilities(pi.capabilities),
        },
    };
}
export function createRegistrationPayload(state, options) {
    return validateRegistrationPayload({
        adapterVersion: options.adapterVersion ?? "0.1.0",
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        ...(options.generation === undefined
            ? {}
            : { generation: options.generation }),
        herdr: options.herdr,
        pi: {
            sessionId: state.sessionId,
            activity: state.activity,
            capabilities: state.capabilities,
        },
    });
}
export function validateHeartbeatState(state) {
    const result = {
        ...state,
        sessionId: text(state.sessionId, "session_id"),
        agentId: text(state.agentId, "agent_id"),
    };
    if (!Number.isSafeInteger(state.generation) ||
        state.generation < 1 ||
        !Number.isSafeInteger(state.pendingMessages) ||
        state.pendingMessages < 0 ||
        state.pendingMessages > 1 ||
        (state.activity !== "idle" && state.activity !== "working"))
        throw new Error("PI_HEARTBEAT_STATE_INVALID");
    if (!Array.isArray(state.activeTools) ||
        state.activeTools.length > MAX_TOOLS ||
        state.activeTools.some((name) => typeof name !== "string" ||
            name.length === 0 ||
            name.length > MAX_TOOL_NAME))
        throw new Error("PI_HEARTBEAT_STATE_INVALID");
    return result;
}
