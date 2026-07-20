import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REQUIRED_CODEX_TOOLS = ["exec_command", "write_stdin", "apply_patch", "web_run", "imagegen", "view_image"] as const;

/**
 * Child-only verification for the installed Codex conversion. This extension deliberately
 * registers and changes nothing; its sole job is making a broken conversion fail at startup.
 */
export default function codexChildGuard(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = new Set(pi.getActiveTools());
		const missing = REQUIRED_CODEX_TOOLS.filter((name) => !registered.has(name) || !active.has(name));
		if (missing.length) throw new Error(`Codex child conversion did not activate required tools: ${missing.join(", ")}. Reinstall @howaboua/pi-codex-conversion.`);
	});
}
