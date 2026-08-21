import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";

export type SnapshotReason =
	| "session start"
	| "extension reload"
	| "compaction"
	| "model change"
	| "tree navigation"
	| "manual refresh";

export interface SnapshotFacts {
	reason: SnapshotReason;
	date: string;
	cwd: string;
	environment: string;
	shell?: string;
}

function unquoteOsReleaseValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed
			.slice(1, -1)
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	return trimmed;
}

export function parseOsRelease(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (!match) continue;
		result[match[1]] = unquoteOsReleaseValue(match[2]);
	}
	return result;
}

export function readEnvironmentDescription(): string {
	const kernel = platform();
	let product = kernel;
	if (kernel === "darwin") product = "macOS";
	else if (kernel === "win32") product = "Windows";
	else if (kernel === "linux") {
		try {
			const release = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
			product = release.PRETTY_NAME || release.NAME || "Linux";
		} catch {
			product = "Linux";
		}
	}
	return `${product}; kernel ${kernel}; architecture ${arch()}`;
}

export function formatLocalDate(date: Date): string {
	const year = date.getFullYear().toString().padStart(4, "0");
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function buildSnapshotText(facts: SnapshotFacts): string {
	const lines = [
		"<agent-context>",
		`Context snapshot (${facts.reason}): Current local date: ${facts.date}`,
		`Environment: ${facts.environment}`,
	];
	if (facts.shell) {
		lines.push(
			`Shell: each Pi bash call starts a fresh ${facts.shell} in ${facts.cwd}; cd, export, and shell variables do not persist between calls.`,
		);
	}
	lines.push(
		"This snapshot is intentionally stable within one local date and between context-reset boundaries. Re-check mutable facts when exact current state matters.",
		"</agent-context>",
	);
	return lines.join("\n");
}
