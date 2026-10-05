import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	captureReference,
	contextBoundary,
	ENTRY_TYPE,
	findReference,
	projectReference,
	referenceText,
	SECTION_NAME,
	type DateReference,
} from "./reference.ts";

export default function dateReferenceExtension(pi: ExtensionAPI): void {
	function reference(ctx: ExtensionContext, allowCapture: boolean): DateReference {
		const branch = ctx.sessionManager.getBranch();
		const saved = findReference(branch, () => ctx.sessionManager.getEntries());
		if (saved) return saved;
		if (!allowCapture) throw new Error("Date reference was not initialized before request preparation.");
		const boundary = contextBoundary(branch);
		const captured = captureReference(boundary.id, boundary.timestamp ? new Date(boundary.timestamp) : new Date());
		pi.appendEntry(ENTRY_TYPE, captured);
		return captured;
	}

	// Restore lazily from Pi's session tree. Do not write at startup: a compaction
	// owner can still be checking a provisional replacement session's freshness.
	pi.on("session_compact", (_event, ctx) => { reference(ctx, true); });

	pi.on("before_agent_start", (event, ctx) => {
		event.systemPromptOptions.sections[SECTION_NAME] = referenceText(reference(ctx, true));
	});

	// Boundary-draft compactions do not emit session_compact. This public event
	// runs before request-context admission and sees only committed entries.
	pi.on("turn_start", (_event, ctx) => { reference(ctx, true); });

	pi.on("context_with_system", (event, ctx) => {
		// Never append here: a compaction owner can already have captured the leaf.
		const messages = projectReference(event.messages, reference(ctx, false));
		if (messages !== event.messages) return { messages };
	});

	pi.registerCommand("date-reference", {
		description: "Show the fixed local date/time-zone reference without refreshing it.",
		handler: async (_args, ctx) => {
			const saved = findReference(ctx.sessionManager.getBranch(), () => ctx.sessionManager.getEntries());
			ctx.ui.notify(saved ? referenceText(saved) : "Date reference is pending the first agent request.", "info");
		},
	});
}
