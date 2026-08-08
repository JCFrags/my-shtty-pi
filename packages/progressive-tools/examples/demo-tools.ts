import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function demoTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "demo_weather_lookup",
		label: "Demo Weather Lookup",
		description: "Return sample weather data for a city. This tool is only for testing progressive tool discovery.",
		parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Demo weather for ${params.city}: 21 C and clear.` }],
				details: { demo: true },
			};
		},
	});

	pi.registerTool({
		name: "demo_issue_search",
		label: "Demo Issue Search",
		description: "Search a sample issue list by keyword. This tool is only for testing progressive tool discovery.",
		parameters: Type.Object({ query: Type.String({ description: "Issue search words" }) }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Demo issue search for ${params.query}: no open issues.` }],
				details: { demo: true },
			};
		},
	});

	pi.registerTool({
		name: "demo_release_notes",
		label: "Demo Release Notes",
		description: "Return sample release notes for a version. This tool is only for testing progressive tool discovery.",
		parameters: Type.Object({ version: Type.String({ description: "Release version" }) }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Demo release ${params.version}: improved tool discovery.` }],
				details: { demo: true },
			};
		},
	});
}
