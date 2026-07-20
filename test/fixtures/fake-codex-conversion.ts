import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CODEX_TOOL_NAMES = ["exec_command", "write_stdin", "apply_patch", "web_run", "imagegen", "view_image"];

/** Offline stand-in for the installed conversion package used by real Pi loading tests. */
export default function fakeCodexConversion(pi: ExtensionAPI): void {
	for (const name of CODEX_TOOL_NAMES) pi.registerTool({ name, label: name, description: "fixture Codex tool", parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "fixture" }], details: {} }; } });
	pi.on("session_start", () => pi.setActiveTools([...CODEX_TOOL_NAMES]));
}
