import {
	getShellConfig,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	buildSnapshotText,
	formatLocalDate,
	readEnvironmentDescription,
	type SnapshotReason,
} from "./snapshot.ts";

const SNAPSHOT_MESSAGE_TYPE = "pi-agent-context:snapshot";
const AUDIT_ENTRY_TYPE = "pi-agent-context:audit";

interface AuditEntryData {
	text: string;
}

interface LatestSnapshot {
	capturedAt: Date;
	reason: SnapshotReason;
	text: string;
}

function approximateTokens(value: unknown): number {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
		return Math.max(0, Math.ceil(text.length / 4));
	} catch {
		return 0;
	}
}

function estimateToolTokens(tool: ToolInfo): number {
	return approximateTokens({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
	});
}

async function captureSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: SnapshotReason,
): Promise<LatestSnapshot> {
	const capturedAt = new Date();
	const activeTools = new Set(pi.getActiveTools());
	const text = buildSnapshotText({
		reason,
		date: formatLocalDate(capturedAt),
		cwd: ctx.cwd,
		environment: readEnvironmentDescription(),
		shell: activeTools.has("bash") ? getShellConfig().shell : undefined,
	});
	return { capturedAt, reason, text };
}

function snapshotMessage(snapshot: LatestSnapshot) {
	return {
		customType: SNAPSHOT_MESSAGE_TYPE,
		content: snapshot.text,
		display: false,
		details: {
			capturedAt: snapshot.capturedAt.toISOString(),
			reason: snapshot.reason,
		},
	};
}

function promptInputReport(options: BuildSystemPromptOptions): string[] {
	const contextFiles = options.contextFiles ?? [];
	const skills = options.skills ?? [];
	const snippetNames = Object.keys(options.toolSnippets ?? {});
	const lines = [
		"System-prompt inputs:",
		`  Selected tools: ${(options.selectedTools ?? []).length}`,
		`  Tool snippets: ${snippetNames.length}${snippetNames.length > 0 ? ` (${snippetNames.join(", ")})` : ""}`,
		`  Prompt guidelines: ${(options.promptGuidelines ?? []).length}`,
		`  Context files: ${contextFiles.length}, about ${contextFiles.reduce((sum, file) => sum + approximateTokens(file.content), 0)} tokens`,
	];
	for (const file of contextFiles) lines.push(`    ${file.path}`);
	lines.push(`  Skills: ${skills.length}, about ${approximateTokens(skills)} tokens`);
	for (const skill of skills) lines.push(`    ${skill.name}`);
	lines.push(`  Appended system text: about ${approximateTokens(options.appendSystemPrompt ?? "")} tokens`);
	lines.push(`  Custom replacement prompt: about ${approximateTokens(options.customPrompt ?? "")} tokens`);
	return lines;
}

function buildContextAudit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	latestSnapshot: LatestSnapshot | undefined,
	showPrompt: boolean,
): string {
	const systemPrompt = ctx.getSystemPrompt();
	const options = ctx.getSystemPromptOptions();
	const allTools = pi.getAllTools();
	const activeNames = new Set(pi.getActiveTools());
	const active = allTools.filter((tool) => activeNames.has(tool.name));
	const hidden = allTools.filter((tool) => !activeNames.has(tool.name));
	const activeTokens = active.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
	const hiddenTokens = hidden.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
	const lines = [
		"Agent Context audit",
		"",
		`Effective system prompt: ${systemPrompt.length} characters, about ${approximateTokens(systemPrompt)} tokens`,
		`Tool definitions: ${active.length} active (about ${activeTokens} tokens); ${hidden.length} hidden (about ${hiddenTokens} tokens)`,
		`Snapshot delivery: hidden model-visible conversation message; never added on ordinary user turns`,
		`Snapshot refresh boundaries: session start/reload, compaction, model change, tree navigation, or /context-refresh`,
		latestSnapshot
			? `Latest snapshot: ${latestSnapshot.capturedAt.toISOString()} (${latestSnapshot.reason})`
			: "Latest snapshot: pending first agent prompt",
		"Workspace map: intentionally deferred until the workspace-organization specification is available",
		"",
		...promptInputReport(options),
		"",
		"Active tools:",
		...active.map((tool) => `  ${tool.name} — about ${estimateToolTokens(tool)} schema tokens — ${tool.sourceInfo.source}`),
		"",
		"Hidden tools:",
		...hidden.map((tool) => `  ${tool.name} — about ${estimateToolTokens(tool)} schema tokens — ${tool.sourceInfo.source}`),
	];
	if (showPrompt) {
		lines.push("", "Exact effective system prompt:", "---", systemPrompt, "---");
	}
	lines.push(
		"",
		"Limits:",
		"  Token figures use a four-characters-per-token estimate.",
		"  Later before_agent_start handlers and provider-payload hooks may still alter what a provider receives.",
	);
	return lines.join("\n");
}

export default function agentContextExtension(pi: ExtensionAPI): void {
	let initialReason: SnapshotReason = "session start";
	let initialSnapshotPending = true;
	let snapshotDelivered = false;
	let latestSnapshot: LatestSnapshot | undefined;

	async function appendBoundarySnapshot(ctx: ExtensionContext, reason: SnapshotReason): Promise<void> {
		const snapshot = await captureSnapshot(pi, ctx, reason);
		latestSnapshot = snapshot;
		snapshotDelivered = true;
		initialSnapshotPending = false;
		// During an active run this becomes a steering message and is consumed by the
		// next model request. While idle it is appended without triggering a turn.
		pi.sendMessage(snapshotMessage(snapshot), { deliverAs: "steer" });
	}

	pi.registerEntryRenderer<AuditEntryData>(AUDIT_ENTRY_TYPE, (entry, _options, theme) => {
		return new Text(theme.fg("muted", entry.data?.text ?? ""), 0, 0);
	});

	pi.registerCommand("context-refresh", {
		description: "Refresh the stable date and environment snapshot now.",
		handler: async (_args, ctx) => {
			await appendBoundarySnapshot(ctx, "manual refresh");
			ctx.ui.notify("Agent context snapshot refreshed.", "info");
		},
	});

	pi.registerCommand("context-audit", {
		description: "Show prompt, context, active/hidden tool, and snapshot costs. Add 'prompt' for exact system text.",
		handler: async (args, ctx) => {
			const showPrompt = args.trim().toLowerCase() === "prompt";
			const report = buildContextAudit(pi, ctx, latestSnapshot, showPrompt);
			pi.appendEntry<AuditEntryData>(AUDIT_ENTRY_TYPE, { text: report });
			ctx.ui.notify("Context audit added to the session. It is not sent to the model.", "info");
		},
	});

	pi.on("session_start", (event) => {
		initialReason = event.reason === "reload" ? "extension reload" : "session start";
		initialSnapshotPending = true;
		snapshotDelivered = false;
		latestSnapshot = undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!initialSnapshotPending) return;
		const snapshot = await captureSnapshot(pi, ctx, initialReason);
		latestSnapshot = snapshot;
		initialSnapshotPending = false;
		snapshotDelivered = true;
		return { message: snapshotMessage(snapshot) };
	});

	pi.on("session_compact", async (event, ctx) => {
		await appendBoundarySnapshot(ctx, "compaction");
	});

	pi.on("model_select", async (event, ctx) => {
		if (!snapshotDelivered || !event.previousModel) return;
		await appendBoundarySnapshot(ctx, "model change");
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!snapshotDelivered) return;
		await appendBoundarySnapshot(ctx, "tree navigation");
	});
}
