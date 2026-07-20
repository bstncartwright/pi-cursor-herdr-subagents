import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function captureParentTools(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const path = process.env.PI_TEST_TOOL_CAPTURE;
		if (!path) return;
		const tools = pi.getAllTools().map((tool) => ({ name: tool.name, parameters: tool.parameters ?? null, source: tool.sourceInfo?.source ?? null }));
		writeFileSync(path, `${JSON.stringify({ tools, activeTools: pi.getActiveTools() })}\n`, { mode: 0o600 });
	});
}
