import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { InventoryItem, ProgressiveToolsConfig } from "./types.ts";

export function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

export function toolSummary(tool: ToolInfo, config: ProgressiveToolsConfig): string {
	const configured = Object.hasOwn(config.summaries, tool.name) ? config.summaries[tool.name] : undefined;
	const text = cleanText(configured || tool.description) || "No description provided.";
	const summary = text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
	return summary.length <= 300 ? summary : `${summary.slice(0, 297)}...`;
}

export function permittedInventory(inventory: InventoryItem[]): InventoryItem[] {
	return inventory
		.filter((item) => item.decision.state !== "blocked" && (item.active || item.decision.state === "managed"))
		.sort((left, right) => left.tool.name.localeCompare(right.tool.name));
}

export function formatToolList(inventory: InventoryItem[], config: ProgressiveToolsConfig, showState = false): string {
	return inventory.map((item) => {
		const state = showState ? ` [${item.active ? "active" : "load with tool_help"}]` : "";
		return `- ${cleanText(item.tool.name)}${state}: ${toolSummary(item.tool, config)}`;
	}).join("\n");
}

export function buildCatalog(inventory: InventoryItem[], config: ProgressiveToolsConfig): string {
	return [
		"## Tool catalog",
		"These are exact registered tool names, not parameter schemas. Use list_tools to refresh this short inventory.",
		"Call tool_help with names for usage guidance and to enable managed tools. Call a newly enabled tool only on the next model response, after Pi supplies its schema.",
		formatToolList(permittedInventory(inventory), config),
	].join("\n");
}

export function formatHelp(inventory: InventoryItem[], config: ProgressiveToolsConfig, added: string[]): string {
	const lines = [added.length > 0
		? `Enabled for the next model response: ${added.map(cleanText).join(", ")}. Pi supplies the schemas.`
		: "Requested tools are already active."];
	for (const item of inventory) {
		lines.push("", `${cleanText(item.tool.name)}: ${toolSummary(item.tool, config)}`);
		// A before_agent_start prompt override can omit guidelines activated mid-run.
		// Return all registered guidelines here instead of relying on a prompt rebuild.
		const guidelines = [...new Set((item.tool.promptGuidelines ?? []).map((line) => line.trim()).filter(Boolean))];
		for (const guideline of guidelines) lines.push(`- ${guideline}`);
	}
	lines.push("", "No tool operation was run. Call the native tool separately with its schema.");
	return lines.join("\n");
}
