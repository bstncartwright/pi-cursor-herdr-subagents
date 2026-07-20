import assert from "node:assert/strict";
import test from "node:test";
import codexChildGuard, { REQUIRED_CODEX_TOOLS } from "../extensions/codex-child-guard.ts";

function guardHarness(active: string[]) {
	let sessionStart!: () => void;
	codexChildGuard({
		on(event: string, listener: () => void) { if (event === "session_start") sessionStart = listener; },
		getAllTools: () => REQUIRED_CODEX_TOOLS.map((name) => ({ name })),
		getActiveTools: () => active,
	} as any);
	return sessionStart;
}

test("Codex child guard rejects registered but inactive Codex tools", () => {
	assert.throws(() => guardHarness(["exec_command", "write_stdin", "apply_patch"])(), /did not activate required tools: web_run, imagegen, view_image/);
});

test("Codex child guard accepts all six registered and active Codex tools", () => {
	assert.doesNotThrow(() => guardHarness([...REQUIRED_CODEX_TOOLS])());
});
