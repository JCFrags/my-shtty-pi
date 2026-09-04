import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile, } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { REGISTRY_VERSION, } from "./types.js";
const MAX_STRING = 16384;
const PROCESS_STATES = [
    "starting",
    "live",
    "missing",
    "closed",
    "failed",
];
const RUN_PHASES = [
    "starting",
    "running",
    "cancel_requested",
    "completed",
    "cancelled",
    "failed",
    "unknown",
];
const TOPOLOGIES = [
    "parent-split-v1",
    "managed-subagents-tab-v2",
];
export class RegistryError extends Error {
    code;
    constructor(code) {
        super(code);
        this.name = "RegistryError";
        this.code = code;
    }
}
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
    ? v
    : undefined;
function stringField(v, k, max = MAX_STRING) {
    const x = v[k];
    return typeof x === "string" && x.length > 0 && Buffer.byteLength(x) <= max
        ? x
        : undefined;
}
function parentValid(v) {
    const x = record(v);
    return (!!x &&
        !!stringField(x, "workspaceId", 128) &&
        !!stringField(x, "tabId", 128) &&
        !!stringField(x, "paneId", 128));
}
function tabValid(v) {
    const x = record(v);
    return (!!x &&
        !!stringField(x, "workspaceId", 128) &&
        !!stringField(x, "tabId", 128) &&
        !!stringField(x, "requestedLabel", 160) &&
        !!stringField(x, "createdAt", 64) &&
        !!stringField(x, "verifiedAt", 64));
}
function progressValid(v) {
    if (v === null)
        return true;
    const x = record(v);
    return (!!x &&
        Number.isSafeInteger(x.eventSequence) &&
        Number(x.eventSequence) > 0 &&
        !!stringField(x, "summary", 2048) &&
        !!stringField(x, "createdAt", 64));
}
function terminalValid(v) {
    if (v === null)
        return true;
    const x = record(v);
    return (!!x &&
        (x.status === "completed" ||
            x.status === "cancelled" ||
            x.status === "failed") &&
        !!stringField(x, "summary", 4096) &&
        !!stringField(x, "completedAt", 64) &&
        !!stringField(x, "resultFile", 256));
}
function runValid(v) {
    const x = record(v);
    return (!!x &&
        !!stringField(x, "runId", 128) &&
        Number.isSafeInteger(x.assignmentGeneration) &&
        Number(x.assignmentGeneration) > 0 &&
        typeof x.phase === "string" &&
        RUN_PHASES.includes(x.phase) &&
        progressValid(x.latestProgress) &&
        terminalValid(x.terminal) &&
        Number.isSafeInteger(x.deliveredSequence) &&
        Number(x.deliveredSequence) >= 0 &&
        typeof x.terminalDelivered === "boolean" &&
        Number.isSafeInteger(x.notifiedSequence) &&
        Number(x.notifiedSequence) >= 0 &&
        typeof x.terminalNotified === "boolean" &&
        (x.cancelRequestedAt === null ||
            !!stringField(x, "cancelRequestedAt", 64)) &&
        (x.assignmentState === "pending-prompt" ||
            x.assignmentState === "delivered") &&
        (x.pendingTask === null || !!stringField(x, "pendingTask", 8192)) &&
        Array.isArray(x.legacyDeliveredEventIds) &&
        x.legacyDeliveredEventIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) &&
        !!stringField(x, "createdAt", 64) &&
        !!stringField(x, "updatedAt", 64));
}
function agentValid(v, domainId) {
    const x = record(v);
    if (!x || x.domainId !== domainId)
        return false;
    if (!stringField(x, "agentId", 128) ||
        !stringField(x, "runId", 128) ||
        !stringField(x, "herdrAgentName", 32) ||
        !stringField(x, "workspaceId", 128) ||
        !stringField(x, "tabId", 128) ||
        !stringField(x, "paneId", 128) ||
        !stringField(x, "cwd", 4096) ||
        !stringField(x, "label", 160) ||
        !stringField(x, "herdrAttention", 64) ||
        !stringField(x, "createdAt", 64) ||
        !stringField(x, "updatedAt", 64))
        return false;
    if (x.agentGeneration !== 1 ||
        !Number.isSafeInteger(x.assignmentGeneration) ||
        Number(x.assignmentGeneration) < 1 ||
        typeof x.topology !== "string" ||
        !TOPOLOGIES.includes(x.topology) ||
        typeof x.processState !== "string" ||
        !PROCESS_STATES.includes(x.processState) ||
        typeof x.runPhase !== "string" ||
        !RUN_PHASES.includes(x.runPhase) ||
        !progressValid(x.latestProgress) ||
        !terminalValid(x.terminal) ||
        !Array.isArray(x.runs) ||
        x.runs.length < 1 ||
        !x.runs.every(runValid))
        return false;
    const runs = x.runs;
    const current = runs.find((r) => r.runId === x.runId);
    return (!!current &&
        new Set(runs.map((r) => r.runId)).size === runs.length &&
        current.assignmentGeneration === x.assignmentGeneration);
}
function commonValid(x, domainId) {
    return (x.domainId === domainId &&
        !!stringField(x, "projectRoot", 4096) &&
        parentValid(x.parent) &&
        !!stringField(x, "createdAt", 64) &&
        !!stringField(x, "updatedAt", 64) &&
        Array.isArray(x.agents));
}
function validateRegistry(v, domainId) {
    const x = record(v);
    if (!x ||
        x.version !== REGISTRY_VERSION ||
        !commonValid(x, domainId) ||
        (x.managedTab !== null && !tabValid(x.managedTab)) ||
        !x.agents.every((a) => agentValid(a, domainId)))
        throw new RegistryError("REGISTRY_MALFORMED");
    return x;
}
function oldAgentValid(v, domainId, version) {
    const x = record(v);
    if (!x || x.domainId !== domainId)
        return false;
    for (const [k, m] of [
        ["agentId", 128],
        ["runId", 128],
        ["herdrAgentName", 32],
        ["workspaceId", 128],
        ["tabId", 128],
        ["paneId", 128],
        ["cwd", 4096],
        ["label", 160],
        ["herdrAttention", 64],
        ["createdAt", 64],
        ["updatedAt", 64],
    ])
        if (!stringField(x, k, m))
            return false;
    return (x.agentGeneration === 1 &&
        x.assignmentGeneration === 1 &&
        typeof x.processState === "string" &&
        PROCESS_STATES.includes(x.processState) &&
        typeof x.runPhase === "string" &&
        [
            "starting",
            "running",
            "completed",
            "closed",
            "failed",
            "unknown",
        ].includes(x.runPhase) &&
        (version === 1 ||
            (typeof x.topology === "string" &&
                TOPOLOGIES.includes(x.topology))));
}
function migrate(v, domainId) {
    const x = record(v);
    if (!x ||
        ![1, 2, 3, 4].includes(Number(x.version)) ||
        !commonValid(x, domainId))
        return undefined;
    const version = Number(x.version);
    if (version === 4) {
        const timestamp = new Date().toISOString();
        const candidate = {
            ...x,
            version: REGISTRY_VERSION,
            updatedAt: timestamp,
            agents: x.agents.map((value) => {
                const agent = record(value) ?? {};
                return {
                    ...agent,
                    runs: Array.isArray(agent.runs)
                        ? agent.runs.map((item) => {
                            const run = record(item) ?? {};
                            return {
                                ...run,
                                notifiedSequence: Number.isSafeInteger(run.deliveredSequence) &&
                                    Number(run.deliveredSequence) >= 0
                                    ? Number(run.deliveredSequence)
                                    : 0,
                                terminalNotified: run.terminal !== null,
                                cancelRequestedAt: null,
                            };
                        })
                        : [],
                };
            }),
        };
        return validateRegistry(candidate, domainId);
    }
    if (!x.agents.every((a) => oldAgentValid(a, domainId, version)))
        return undefined;
    const timestamp = new Date().toISOString();
    const agents = x.agents.map((old) => {
        const oldTerminal = version === 3 && terminalValid(old.terminal)
            ? old.terminal
            : null;
        const oldProgress = version === 3 && old.latestProgress !== null && record(old.latestProgress)
            ? {
                eventSequence: 1,
                summary: String(record(old.latestProgress)?.summary ?? "").slice(0, 2048) || "migrated progress",
                createdAt: String(record(old.latestProgress)?.createdAt ?? old.updatedAt),
            }
            : null;
        const rawPhase = String(old.runPhase);
        const phase = oldTerminal
            ? oldTerminal.status === "completed"
                ? "completed"
                : "failed"
            : rawPhase === "closed"
                ? "unknown"
                : RUN_PHASES.includes(rawPhase)
                    ? rawPhase
                    : "unknown";
        const run = {
            runId: old.runId,
            assignmentGeneration: 1,
            phase,
            latestProgress: oldProgress,
            terminal: oldTerminal,
            deliveredSequence: 0,
            terminalDelivered: version === 3 && old.terminalDelivered === true,
            notifiedSequence: 0,
            terminalNotified: oldTerminal !== null,
            cancelRequestedAt: null,
            assignmentState: "delivered",
            pendingTask: null,
            legacyDeliveredEventIds: version === 3 && Array.isArray(old.deliveredEventIds)
                ? old.deliveredEventIds.filter((id) => typeof id === "string")
                : [],
            createdAt: old.createdAt,
            updatedAt: old.updatedAt,
        };
        return {
            ...old,
            topology: version === 1 ? "parent-split-v1" : old.topology,
            runPhase: phase,
            latestProgress: oldProgress,
            terminal: oldTerminal,
            runs: [run],
        };
    });
    return {
        version: REGISTRY_VERSION,
        domainId,
        projectRoot: x.projectRoot,
        parent: x.parent,
        managedTab: version >= 2 && (x.managedTab === null || tabValid(x.managedTab))
            ? x.managedTab
            : null,
        createdAt: x.createdAt,
        updatedAt: timestamp,
        agents,
    };
}
function stateBase() {
    const configured = process.env.XDG_STATE_HOME;
    return resolve(configured && isAbsolute(configured)
        ? configured
        : join(homedir(), ".local", "state"), "pi-herdr-orchestrator-v2");
}
function validDomainId(id) {
    return /^d-[a-f0-9]{24}$/u.test(id);
}
export function registryPathForDomain(id) {
    if (!validDomainId(id))
        throw new RegistryError("REGISTRY_MALFORMED");
    return join(stateBase(), `${id}.json`);
}
export function domainDirectoryFor(id) {
    if (!validDomainId(id))
        throw new RegistryError("REGISTRY_MALFORMED");
    return join(stateBase(), id);
}
export async function readRegistryByDomain(id) {
    try {
        const parsed = JSON.parse(await readFile(registryPathForDomain(id), "utf8"));
        return migrate(parsed, id) ?? validateRegistry(parsed, id);
    }
    catch (e) {
        if (e instanceof RegistryError)
            throw e;
        throw new RegistryError("REGISTRY_MALFORMED");
    }
}
export function domainIdFor(root, parent) {
    return `d-${createHash("sha256")
        .update([resolve(root), parent.workspaceId, parent.tabId, parent.paneId].join("\0"))
        .digest("hex")
        .slice(0, 24)}`;
}
export class RegistryStore {
    domainId;
    path;
    projectRoot;
    parent;
    loaded;
    constructor(root, parent) {
        this.projectRoot = resolve(root);
        this.parent = { ...parent };
        this.domainId = domainIdFor(this.projectRoot, this.parent);
        this.path = registryPathForDomain(this.domainId);
    }
    async ensureDirectory() {
        const d = dirname(this.path);
        await mkdir(d, { recursive: true, mode: 0o700 });
        await chmod(d, 0o700).catch(() => undefined);
    }
    ownershipValid(r) {
        return (r.projectRoot === this.projectRoot &&
            r.parent.workspaceId === this.parent.workspaceId &&
            r.parent.tabId === this.parent.tabId &&
            r.parent.paneId === this.parent.paneId);
    }
    async load() {
        if (this.loaded)
            return this.loaded;
        await this.ensureDirectory();
        let parsed;
        try {
            parsed = JSON.parse(await readFile(this.path, "utf8"));
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw new RegistryError("REGISTRY_MALFORMED");
            const t = new Date().toISOString();
            this.loaded = {
                version: REGISTRY_VERSION,
                domainId: this.domainId,
                projectRoot: this.projectRoot,
                parent: { ...this.parent },
                managedTab: null,
                createdAt: t,
                updatedAt: t,
                agents: [],
            };
            return this.loaded;
        }
        const migrated = migrate(parsed, this.domainId);
        this.loaded = migrated ?? validateRegistry(parsed, this.domainId);
        if (!this.ownershipValid(this.loaded))
            throw new RegistryError("REGISTRY_MALFORMED");
        if (migrated)
            await this.save(migrated);
        return this.loaded;
    }
    async save(next) {
        validateRegistry(next, this.domainId);
        if (!this.ownershipValid(next))
            throw new RegistryError("REGISTRY_MALFORMED");
        await this.ensureDirectory();
        const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600).catch(() => undefined);
        try {
            await rename(tmp, this.path);
        }
        catch (e) {
            await unlink(tmp).catch(() => undefined);
            throw e;
        }
        this.loaded = next;
    }
    async addAgent(agent) {
        const r = await this.load();
        if (r.agents.some((a) => a.agentId === agent.agentId ||
            a.runs.some((run) => run.runId === agent.runId)))
            throw new RegistryError("REGISTRY_MALFORMED");
        await this.save({
            ...r,
            updatedAt: new Date().toISOString(),
            agents: [...r.agents, agent],
        });
    }
    async updateAgent(agentId, patch) {
        const r = await this.load(), i = r.agents.findIndex((a) => a.agentId === agentId);
        if (i < 0)
            throw new RegistryError("REGISTRY_AGENT_MISSING");
        const timestamp = new Date().toISOString(), original = r.agents[i];
        let runs = patch.runs ?? original.runs;
        if (patch.runPhase !== undefined ||
            patch.latestProgress !== undefined ||
            patch.terminal !== undefined) {
            runs = runs.map((run) => run.runId === original.runId
                ? {
                    ...run,
                    ...(patch.runPhase !== undefined
                        ? { phase: patch.runPhase }
                        : {}),
                    ...(patch.latestProgress !== undefined
                        ? { latestProgress: patch.latestProgress }
                        : {}),
                    ...(patch.terminal !== undefined
                        ? { terminal: patch.terminal }
                        : {}),
                    updatedAt: timestamp,
                }
                : run);
        }
        const updated = {
            ...original,
            ...patch,
            runs,
            updatedAt: timestamp,
        };
        const agents = [...r.agents];
        agents[i] = updated;
        await this.save({ ...r, updatedAt: timestamp, agents });
        return updated;
    }
    async updateRun(agentId, runId, patch) {
        const r = await this.load(), i = r.agents.findIndex((a) => a.agentId === agentId);
        if (i < 0)
            throw new RegistryError("REGISTRY_AGENT_MISSING");
        const original = r.agents[i], j = original.runs.findIndex((run) => run.runId === runId);
        if (j < 0)
            throw new RegistryError("REGISTRY_RUN_MISSING");
        const runs = [...original.runs], updatedRun = {
            ...runs[j],
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        runs[j] = updatedRun;
        const current = original.runId === runId;
        const updated = {
            ...original,
            runs,
            ...(current
                ? {
                    runPhase: updatedRun.phase,
                    latestProgress: updatedRun.latestProgress,
                    terminal: updatedRun.terminal,
                }
                : {}),
            updatedAt: new Date().toISOString(),
        };
        const agents = [...r.agents];
        agents[i] = updated;
        await this.save({ ...r, agents, updatedAt: new Date().toISOString() });
        return updated;
    }
    async startAssignment(agentId, run) {
        const r = await this.load(), i = r.agents.findIndex((a) => a.agentId === agentId);
        if (i < 0)
            throw new RegistryError("REGISTRY_AGENT_MISSING");
        const a = r.agents[i];
        if (a.runs.some((x) => x.runId === run.runId) ||
            run.assignmentGeneration !== a.assignmentGeneration + 1)
            throw new RegistryError("REGISTRY_MALFORMED");
        const updated = {
            ...a,
            runId: run.runId,
            assignmentGeneration: run.assignmentGeneration,
            runPhase: run.phase,
            latestProgress: null,
            terminal: null,
            runs: [...a.runs, run],
            updatedAt: new Date().toISOString(),
        };
        const agents = [...r.agents];
        agents[i] = updated;
        await this.save({ ...r, agents, updatedAt: new Date().toISOString() });
        return updated;
    }
    async setManagedTab(tab) {
        const r = await this.load();
        await this.save({
            ...r,
            managedTab: tab,
            updatedAt: new Date().toISOString(),
        });
    }
    async clearManagedTab(expected) {
        const r = await this.load();
        if (r.managedTab?.tabId !== expected)
            return false;
        await this.save({
            ...r,
            managedTab: null,
            updatedAt: new Date().toISOString(),
        });
        return true;
    }
    async markManagedTabAgentsMissing(tabId) {
        const r = await this.load(), t = new Date().toISOString();
        const agents = r.agents.map((a) => a.topology === "managed-subagents-tab-v2" &&
            a.tabId === tabId &&
            a.processState !== "closed" &&
            a.processState !== "failed"
            ? {
                ...a,
                processState: "missing",
                runPhase: a.terminal ? a.runPhase : "unknown",
                herdrAttention: "unknown",
                runs: a.runs.map((run) => run.runId === a.runId && !run.terminal
                    ? { ...run, phase: "unknown", updatedAt: t }
                    : run),
                updatedAt: t,
            }
            : a);
        await this.save({ ...r, agents, updatedAt: t });
    }
    async getAgent(agentId, runId) {
        if (!agentId && !runId)
            return undefined;
        return (await this.load()).agents.find((a) => a.agentId === agentId ||
            (!!runId && a.runs.some((r) => r.runId === runId)));
    }
    async getRun(runId) {
        const agent = await this.getAgent(undefined, runId), run = agent?.runs.find((r) => r.runId === runId);
        return agent && run ? { agent, run } : undefined;
    }
    async list() {
        return [...(await this.load()).agents];
    }
    async managedTab() {
        const t = (await this.load()).managedTab;
        return t ? { ...t } : null;
    }
}
