/**
 * Enhanced Titlebar Activity Extension
 *
 * Turns the terminal title into a tiny activity display with selectable,
 * persistent animation profiles and phase-aware compaction animations.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type ProfileId = "smart" | "minimal" | "arcade" | "cosmic" | "playful" | "terminal" | "context" | "surprise" | "still";
type ActivityKind = "thinking" | "writing" | "compacting" | "bash" | "editing" | "reading" | "searching" | "tool";
type Activity = { kind: ActivityKind; label: string; toolName?: string };
type Profile = { id: ProfileId; name: string; description: string };

const IN_HERDR = process.env.HERDR_ENV === "1";
const FRAME_INTERVAL_MS = IN_HERDR ? 250 : 120;
const MAX_TITLE_LENGTH = IN_HERDR ? 72 : 140;
const CONFIG_PATH = path.join(getAgentDir(), "title-animation.json");

const PROFILES: Profile[] = [
	{ id: "smart", name: "Smart Activity", description: "Phase-aware spark, wave, scanner, pencil, terminal, and compaction effects" },
	{ id: "minimal", name: "Minimal", description: "Quiet Braille, pulse, and compact shrinking animations" },
	{ id: "arcade", name: "Arcade", description: "Pac-Man chases, Knight Rider sweeps, and retro movement" },
	{ id: "cosmic", name: "Cosmic", description: "Comets, orbital motion, moon phases, DNA, and a compaction black hole" },
	{ id: "playful", name: "Playful", description: "Nyan-style cat, tiny train, books-to-sparkles compaction, and cheerful motion" },
	{ id: "terminal", name: "Terminal", description: "Typewriter, cursor, scanner, Braille, and archive-style compaction" },
	{ id: "context", name: "Context Pressure", description: "A live context-density meter that contracts during compaction" },
	{ id: "surprise", name: "Surprise Me", description: "Rotates through the animated profiles during each run" },
	{ id: "still", name: "Still", description: "No motion; retain activity labels, elapsed time, and context" },
];

const PROFILE_IDS = new Set<ProfileId>(PROFILES.map((profile) => profile.id));

const FX = {
	braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	pulse: ["·", "•", "●", "✦", "●", "•"],
	wave: ["▁▂▃▄▅", "▂▃▄▅▆", "▃▄▅▆▇", "▄▅▆▇█", "▃▄▅▆▇", "▂▃▄▅▆"],
	thinking: ["[✦···]", "[·✦··]", "[··✦·]", "[···✦]", "[··✦·]", "[·✦··]"],
	reading: ["[▰▱▱▱]", "[▱▰▱▱]", "[▱▱▰▱]", "[▱▱▱▰]", "[▱▱▰▱]", "[▱▰▱▱]"],
	writing: ["[✎···]", "[·✎··]", "[··✎·]", "[···✎]", "[··✎·]", "[·✎··]"],
	terminal: ["[›_··]", "[·›_·]", "[··›_]", "[·›_·]"],
	searching: ["[⌕···]", "[·⌕··]", "[··⌕·]", "[···⌕]", "[··⌕·]", "[·⌕··]"],
	shrink: ["[≡≡≡≡]", "[·≡≡≡]", "[··≡≡]", "[···≡]", "[····]", "[··✦·]"],
	pacman: ["ᗧ•••", "•ᗧ••", "••ᗧ•", "•••ᗧ", "••ᗤ•", "•ᗤ••"],
	knight: ["[●····]", "[·●···]", "[··●··]", "[···●·]", "[····●]", "[···●·]", "[··●··]", "[·●···]"],
	comet: ["✦···", "·✦··", "··✦·", "···✦", "··✦·", "·✦··"],
	orbit: ["◜", "◝", "◞", "◟"],
	moon: ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"],
	dna: ["╲╱", "╳", "╱╲", "╳"],
	blackHole: ["[✦···]", "[·✦··]", "[··✦·]", "[··●·]", "[··◉·]", "[··●·]"],
	nyan: ["=^.^=···", "·=^.^=··", "··=^.^=·", "···=^.^=", "··=^.^=·", "·=^.^=··"],
	train: ["🚂···", "·🚂··", "··🚂·", "···🚂", "··🚂·", "·🚂··"],
	books: ["📚📚📚→✨", "·📚📚→✨", "··📚→✨", "···✨", "··✨·", "·✨··"],
	typewriter: ["T▌", "Ty▌", "Typ▌", "Typi▌", "Typin▌", "Typing▌", "Typing·", "Typing▌"],
	archive: ["[####]", "[###·]", "[##··]", "[#···]", "[zip·]", "[·✓··]"],
} as const;

function clean(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

function shorten(value: string, maxLength: number): string {
	const chars = [...clean(value)];
	return chars.length <= maxLength ? chars.join("") : `${chars.slice(0, maxLength - 1).join("")}…`;
}

function fitTitle(value: string): string {
	return shorten(value, MAX_TITLE_LENGTH);
}

function loadProfile(): ProfileId {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { profile?: unknown };
		if (typeof parsed.profile === "string" && PROFILE_IDS.has(parsed.profile as ProfileId)) {
			return parsed.profile as ProfileId;
		}
	} catch {
		// Missing or invalid config falls back to smart mode.
	}
	return "smart";
}

function saveProfile(profile: ProfileId): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ profile }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function modelName(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return shorten(ctx.model.id.replace(/^.*\//, ""), 30);
}

function contextTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const project = shorten(path.basename(ctx.cwd) || ctx.cwd, 28);
	const session = pi.getSessionName();
	const model = modelName(ctx);
	const parts = [session ? shorten(session, 46) : undefined, project, model].filter(
		(part): part is string => Boolean(part),
	);
	return `π ${parts.join(" · ")}`;
}

function displayTitle(pi: ExtensionAPI, ctx: ExtensionContext, activity: string): string {
	return fitTitle(IN_HERDR ? activity : `${activity} │ ${contextTitle(pi, ctx)}`);
}

function formatElapsed(startedAt: number): string {
	const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function milestoneBadge(startedAt: number): string {
	const seconds = Math.floor((Date.now() - startedAt) / 1000);
	if (seconds >= 300) return "🧙";
	if (seconds >= 120) return "🐢";
	if (seconds >= 30) return "☕";
	return "";
}

function toolActivity(toolName: string): Activity {
	const activities: Record<string, Activity> = {
		bash: { kind: "bash", label: "Running command", toolName },
		edit: { kind: "editing", label: "Editing file", toolName },
		find: { kind: "searching", label: "Finding files", toolName },
		grep: { kind: "searching", label: "Searching", toolName },
		read: { kind: "reading", label: "Reading", toolName },
		write: { kind: "editing", label: "Writing file", toolName },
	};
	return activities[toolName] ?? { kind: "tool", label: `Using ${toolName.replaceAll("_", " ")}`, toolName };
}

function smartFrames(activity: Activity): readonly string[] {
	switch (activity.kind) {
		case "compacting": return FX.books;
		case "bash": return FX.terminal;
		case "editing": return FX.writing;
		case "reading": return FX.reading;
		case "searching": return FX.searching;
		case "writing": return FX.wave;
		case "tool": return FX.pulse;
		default: return FX.thinking;
	}
}

function minimalFrames(activity: Activity): readonly string[] {
	if (activity.kind === "compacting") return FX.shrink;
	if (activity.kind === "writing") return FX.pulse;
	return FX.braille;
}

function arcadeFrames(activity: Activity): readonly string[] {
	if (activity.kind === "compacting" || activity.kind === "reading" || activity.kind === "searching") return FX.pacman;
	if (activity.kind === "bash" || activity.kind === "editing") return FX.knight;
	return activity.kind === "writing" ? FX.wave : FX.pacman;
}

function cosmicFrames(activity: Activity): readonly string[] {
	if (activity.kind === "compacting") return FX.blackHole;
	if (activity.kind === "reading") return FX.moon;
	if (activity.kind === "searching") return FX.dna;
	if (activity.kind === "thinking") return FX.orbit;
	return FX.comet;
}

function playfulFrames(activity: Activity): readonly string[] {
	if (activity.kind === "compacting") return FX.books;
	if (activity.kind === "bash" || activity.kind === "editing" || activity.kind === "tool") return FX.train;
	return FX.nyan;
}

function terminalFrames(activity: Activity): readonly string[] {
	if (activity.kind === "compacting") return FX.archive;
	if (activity.kind === "writing") return FX.typewriter;
	if (activity.kind === "bash") return FX.terminal;
	if (activity.kind === "reading" || activity.kind === "searching") return FX.reading;
	return FX.braille;
}

function contextFrames(ctx: ExtensionContext, activity: Activity, frameIndex: number): readonly string[] {
	if (activity.kind === "compacting") return FX.shrink;
	const percent = ctx.getContextUsage()?.percent ?? 0;
	const filled = Math.max(0, Math.min(8, Math.round(percent / 12.5)));
	const bar = `[${"█".repeat(filled)}${"░".repeat(8 - filled)}]`;
	const pulse = frameIndex % 4 === 0 ? "◆" : "◇";
	return [`${pulse}${bar}`];
}

function framesFor(profile: ProfileId, activity: Activity, ctx: ExtensionContext, frameIndex: number): readonly string[] {
	if (profile === "surprise") {
		const rotation: Exclude<ProfileId, "surprise" | "still" | "context">[] = [
			"smart", "minimal", "arcade", "cosmic", "playful", "terminal",
		];
		const selected = rotation[Math.floor(frameIndex / 30) % rotation.length]!;
		return framesFor(selected, activity, ctx, frameIndex);
	}
	if (profile === "still") return ["●"];
	if (profile === "minimal") return minimalFrames(activity);
	if (profile === "arcade") return arcadeFrames(activity);
	if (profile === "cosmic") return cosmicFrames(activity);
	if (profile === "playful") return playfulFrames(activity);
	if (profile === "terminal") return terminalFrames(activity);
	if (profile === "context") return contextFrames(ctx, activity, frameIndex);
	return smartFrames(activity);
}

function profileLabel(profile: Profile): string {
	return `${profile.name} — ${profile.description}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let idleRefresh: ReturnType<typeof setTimeout> | undefined;
	let frameIndex = 0;
	let startedAt = 0;
	let phase: "Thinking" | "Writing" = "Thinking";
	let compacting = false;
	let profileId = loadProfile();
	let activeContext: ExtensionContext | undefined;
	const activeTools = new Map<string, string>();

	const renderIdle = (ctx: ExtensionContext) => {
		ctx.ui.setTitle(displayTitle(pi, ctx, "✓ Ready"));
	};

	const currentActivity = (): Activity => {
		if (compacting) return { kind: "compacting", label: "Compacting memory" };
		const tools = [...activeTools.values()];
		const toolName = tools[tools.length - 1];
		if (toolName) return toolActivity(toolName);
		return phase === "Writing" ? { kind: "writing", label: "Writing" } : { kind: "thinking", label: "Thinking" };
	};

	const renderBusy = () => {
		if (!activeContext) return;
		const activity = currentActivity();
		const frames = framesFor(profileId, activity, activeContext, frameIndex);
		const frame = frames[frameIndex % frames.length]!;
		const badge = milestoneBadge(startedAt);
		activeContext.ui.setTitle(
			displayTitle(pi, activeContext, `${frame} ${shorten(activity.label, 34)} · ${formatElapsed(startedAt)}${badge ? ` ${badge}` : ""}`),
		);
		frameIndex++;
	};

	const beginAnimation = (ctx: ExtensionContext, resetTools: boolean) => {
		if (timer) clearInterval(timer);
		activeContext = ctx;
		if (resetTools) activeTools.clear();
		frameIndex = 0;
		startedAt = Date.now();
		renderBusy();
		timer = setInterval(renderBusy, FRAME_INTERVAL_MS);
	};

	const stopAnimation = (ctx: ExtensionContext) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		frameIndex = 0;
		compacting = false;
		activeTools.clear();
		activeContext = ctx;
		renderIdle(ctx);
	};

	const selectProfile = async (ctx: ExtensionContext): Promise<ProfileId | undefined> => {
		const labels = PROFILES.map((profile) => `${profile.id === profileId ? "●" : "○"} ${profileLabel(profile)}`);
		const selected = await ctx.ui.select("Title animation profile", labels);
		if (!selected) return undefined;
		const index = labels.indexOf(selected);
		return PROFILES[index]?.id;
	};

	const applyProfile = (nextProfile: ProfileId, ctx: ExtensionContext) => {
		profileId = nextProfile;
		frameIndex = 0;
		try {
			saveProfile(profileId);
		} catch (error) {
			ctx.ui.notify(`Could not save title animation profile: ${String(error)}`, "warning");
		}
		if (timer) renderBusy();
		const profile = PROFILES.find((candidate) => candidate.id === profileId)!;
		ctx.ui.notify(`Title animation: ${profile.name}`, "info");
	};

	pi.registerCommand("title-animation", {
		description: "Select a terminal title animation profile.",
		getArgumentCompletions: (prefix) => {
			const matches = PROFILES.filter((profile) => profile.id.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches.map((profile) => ({ value: profile.id, label: profile.name, description: profile.description })) : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested) {
				const selected = await selectProfile(ctx);
				if (selected) applyProfile(selected, ctx);
				return;
			}
			if (!PROFILE_IDS.has(requested as ProfileId)) {
				ctx.ui.notify(`Unknown profile. Choose one of: ${PROFILES.map((profile) => profile.id).join(", ")}`, "error");
				return;
			}
			applyProfile(requested as ProfileId, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (idleRefresh) clearTimeout(idleRefresh);
		activeContext = ctx;
		renderIdle(ctx);
		// Pi applies its default startup title after session_start handlers. Restore
		// the extension title on the next event-loop pass without disturbing a run
		// that may already have started.
		idleRefresh = setTimeout(() => {
			idleRefresh = undefined;
			if (activeContext === ctx && !timer) renderIdle(ctx);
		}, 50);
		idleRefresh.unref?.();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		compacting = false;
		phase = "Thinking";
		beginAnimation(ctx, true);
	});

	pi.on("turn_start", async (_event, ctx) => {
		activeContext = ctx;
		phase = "Thinking";
	});

	pi.on("message_update", async (event, ctx) => {
		activeContext = ctx;
		if (event.message.role === "assistant" && activeTools.size === 0 && !compacting) phase = "Writing";
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeContext = ctx;
		activeTools.set(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeContext = ctx;
		activeTools.delete(event.toolCallId);
		if (activeTools.size === 0 && !compacting) phase = "Thinking";
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		compacting = true;
		beginAnimation(ctx, false);
	});

	pi.on("session_compact", async (event, ctx) => {
		compacting = false;
		frameIndex = 0;
		if (event.reason === "manual") stopAnimation(ctx);
		else phase = "Thinking";
	});

	pi.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		activeContext = ctx;
		if (!timer) renderIdle(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		activeContext = ctx;
		if (!timer) renderIdle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (idleRefresh) clearTimeout(idleRefresh);
		idleRefresh = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		activeTools.clear();
		ctx.ui.setTitle(fitTitle(IN_HERDR ? "π" : contextTitle(pi, ctx)));
	});
}
