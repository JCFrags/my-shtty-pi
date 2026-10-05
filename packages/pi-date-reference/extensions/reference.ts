import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "pi-date-reference:v1";
export const SECTION_NAME = "local_date_reference";

export interface DateReference {
	schemaVersion: 1;
	contextId: string | null;
	date: string;
	timeZone: string;
}

export function contextBoundary(branch: SessionEntry[]): { id: string | null; timestamp?: string } {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction") return { id: `compaction:${entry.id}`, timestamp: entry.timestamp };
	}
	return { id: branch[0] ? `root:${branch[0].id}` : null };
}

function readReference(entry: SessionEntry, contextId: string | null): DateReference | undefined {
	if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) return undefined;
	const data = entry.data as Partial<DateReference> | undefined;
	if (!data || data.schemaVersion !== 1) return undefined;
	// An empty session's first reference entry becomes that context's root.
	const savedId = data.contextId === null && entry.parentId === null ? `root:${entry.id}` : data.contextId;
	if (savedId !== contextId || typeof data.date !== "string" || typeof data.timeZone !== "string") return undefined;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !/^[A-Za-z0-9._+\/-]{1,80}$/.test(data.timeZone)) return undefined;
	const parsed = new Date(`${data.date}T00:00:00Z`);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== data.date) return undefined;
	return data as DateReference;
}

export function findReference(branch: SessionEntry[], allEntries: () => SessionEntry[]): DateReference | undefined {
	const { id } = contextBoundary(branch);
	if (id === null) return undefined;
	for (const entry of branch) {
		const reference = readReference(entry, id);
		if (reference) return reference;
	}
	// Navigation can stop at the checkpoint before its metadata child. Reuse only
	// a record with that exact context ID, never another branch's context state.
	for (const entry of allEntries()) {
		const reference = readReference(entry, id);
		if (reference) return reference;
	}
	return undefined;
}

export function captureReference(contextId: string | null, capturedAt = new Date()): DateReference {
	if (!Number.isFinite(capturedAt.getTime())) throw new Error("Invalid date-reference boundary timestamp.");
	const year = capturedAt.getFullYear().toString().padStart(4, "0");
	const month = (capturedAt.getMonth() + 1).toString().padStart(2, "0");
	const day = capturedAt.getDate().toString().padStart(2, "0");
	let timeZone = "unknown";
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (zone && /^[A-Za-z0-9._+\/-]{1,80}$/.test(zone)) timeZone = zone;
	} catch {
		// Keep an unavailable zone explicit. Do not copy arbitrary environment text.
	}
	return { schemaVersion: 1, contextId, date: `${year}-${month}-${day}`, timeZone };
}

export function referenceText(reference: DateReference): string {
	return [
		`Local date reference: ${reference.date}`,
		`Local time zone: ${reference.timeZone}`,
		"This reference is fixed for this context. Query the clock when the actual current date or time matters.",
		"This describes the Pi host, not an SSH target or the user's physical location.",
	].join("\n");
}

export function projectReference(messages: AgentMessage[], reference: DateReference): AgentMessage[] {
	if (messages[0]?.role !== "system") throw new Error("Date reference requires Pi's leading system message.");
	const section = `<${SECTION_NAME}>\n${referenceText(reference)}\n</${SECTION_NAME}>`;
	let changed = false;
	const projected = messages.map((message, index) => {
		if (message.role !== "system") return message;
		const declaresReference = Object.hasOwn(message.sections ?? {}, SECTION_NAME);
		// Keep every other section, message position, content, and tool declaration.
		// Refresh this section in a compacted checkpoint even when the host's current
		// run options still contain the preceding context's reference.
		if (index !== 0 && !message.replace && !declaresReference) return message;
		if (message.sections?.[SECTION_NAME] === section) return message;
		changed = true;
		return { ...message, sections: { ...message.sections, [SECTION_NAME]: section } };
	});
	return changed ? projected : messages;
}
