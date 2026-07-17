import assert from "node:assert/strict";
import test from "node:test";
import {
	agentActivitySummary,
	compactActivityText,
	formatElapsed,
	formatPersistentWidgetMetadata,
	JsonlDecoder,
	normalizeCursorToolUpdate,
	sanitizeAcpCapabilities,
	normalizePiRpcToolEvent,
	permissionJournalStatus,
	opaqueToolValueCount,
	terminalizeActiveToolEvents,
	finalizeActiveToolStatus,
	normalizeTaskName,
	parentScopeKey,
	parseAgentTemplateText,
	parsePiModel,
	resolvePiSpawnSelection,
	requireCursorModel,
	resolveCursorSpawnModel,
	selectInheritedPiTools,
	validatePiModelSelection,
	validateSpawnPiOptions,
	validateTemplateBackendOptions,
	SUBAGENT_IDLE_CLOSE_MS,
	taskStorageKey,
} from "../extensions/unified.ts";
import { resolveAutomaticPermission } from "../extensions/helpers.ts";
import { normalizeRunLedgerEvent } from "../extensions/run-ledger.ts";

test("unified JSONL framing preserves Unicode line separators", () => {
	const decoder = new JsonlDecoder();
	const payload = JSON.stringify({ text: "before\u2028after" });
	assert.deepEqual(decoder.push(Buffer.from(payload.slice(0, 8))), []);
	assert.deepEqual(decoder.push(Buffer.from(`${payload.slice(8)}\n`)), [payload]);
	assert.deepEqual(decoder.end(), []);
});

test("unified agent identities are parent-session scoped", () => {
	assert.notEqual(parentScopeKey("parent-a"), parentScopeKey("parent-b"));
	assert.notEqual(taskStorageKey("review/api"), taskStorageKey("review__api"));
	assert.equal(normalizeTaskName("/review/api/"), "review/api");
	assert.throws(() => normalizeTaskName("../escape"), /task_name/);
});

test("agent templates parse explicit backend-specific settings", () => {
	const template = parseAgentTemplateText(`---
name: reviewer
backend: cursor
cursor_model: Grok 4.5 High
permission_mode: deny
skills: web-investigate, frontend-design
---
Review carefully.`, "fallback");
	assert.deepEqual(template, {
		name: "reviewer",
		description: undefined,
		hint: undefined,
		backend: "cursor",
		provider: undefined,
		model: undefined,
		thinking: undefined,
		tools: undefined,
		skills: ["web-investigate", "frontend-design"],
		extensions: undefined,
		cursorModel: "Grok 4.5 High",
		permissionMode: "deny",
		prompt: "Review carefully.",
	});
});

test("invalid template cursor_model values are silently dropped", () => {
	const template = parseAgentTemplateText(`---
name: invalid-cursor-model
backend: cursor
cursor_model: not-a-cursor-preset
---
Review carefully.`, "fallback");
	assert.equal(template.cursorModel, undefined);
});

test("templates reject settings that do not belong to the selected backend", () => {
	assert.throws(() => validateTemplateBackendOptions("cursor", { name: "bad-cursor", skills: ["local"] }), /Pi-only/);
	assert.throws(() => validateTemplateBackendOptions("pi", { name: "bad-pi", cursorModel: "Auto" }), /cursor_model/);
	assert.doesNotThrow(() => validateTemplateBackendOptions("cursor", { name: "cursor", cursorModel: "Auto", permissionMode: "deny" }));
	assert.doesNotThrow(() => validateTemplateBackendOptions("pi", { name: "pi", skills: ["local"], permissionMode: "deny" }));
});

test("pi_model parsing trims and splits only at the first slash", () => {
	assert.deepEqual(parsePiModel("  openrouter/anthropic/claude:beta  "), {
		provider: "openrouter",
		modelId: "anthropic/claude:beta",
	});
	assert.deepEqual(parsePiModel("provider / model/id:tag "), {
		provider: "provider",
		modelId: "model/id:tag",
	});
	for (const value of ["", "   ", "provider", "/model", "provider/", " / "]) {
		assert.throws(() => parsePiModel(value), /provider\/model-id/);
	}
});

test("Pi model and thinking resolve independently with explicit, template, parent precedence", () => {
	assert.deepEqual(resolvePiSpawnSelection({
		parentModel: { provider: "parent-provider", id: "parent-model" },
		parentThinking: "low",
	}), {
		provider: "parent-provider",
		modelId: "parent-model",
		modelSource: "parent",
		thinking: "low",
		thinkingSource: "parent",
	});

	assert.deepEqual(resolvePiSpawnSelection({
		piModel: "explicit-provider/model/with:route",
		template: { name: "reviewer", provider: "template-provider", model: "template-model", thinking: "high" },
		parentModel: { provider: "parent-provider", id: "parent-model" },
		parentThinking: "low",
	}), {
		provider: "explicit-provider",
		modelId: "model/with:route",
		modelSource: "explicit",
		thinking: "high",
		thinkingSource: "template",
	});

	assert.deepEqual(resolvePiSpawnSelection({
		piThinking: "off",
		template: { name: "reviewer", provider: " template-provider ", model: " template/model:tag ", thinking: "high" },
		parentThinking: "medium",
	}), {
		provider: "template-provider",
		modelId: "template/model:tag",
		modelSource: "template",
		thinking: "off",
		thinkingSource: "explicit",
	});
});

test("complete explicit or template Pi models do not require a parent model", () => {
	assert.equal(resolvePiSpawnSelection({ piModel: "provider/model" }).modelSource, "explicit");
	assert.equal(resolvePiSpawnSelection({
		template: { name: "reviewer", provider: "provider", model: "model" },
	}).modelSource, "template");
	assert.throws(
		() => resolvePiSpawnSelection({ parentThinking: "high" }),
		/active parent provider\/model/,
	);
});

test("thinking-only Pi templates retain the inherited parent model", () => {
	assert.deepEqual(resolvePiSpawnSelection({
		template: { name: "deep-reviewer", thinking: "max" },
		parentModel: { provider: "parent-provider", id: "parent-model" },
		parentThinking: "low",
	}), {
		provider: "parent-provider",
		modelId: "parent-model",
		modelSource: "parent",
		thinking: "max",
		thinkingSource: "template",
	});
});

test("selected incomplete Pi template pairs throw but explicit model bypasses them", () => {
	for (const template of [
		{ name: "provider-only", provider: "provider" },
		{ name: "model-only", model: "model" },
		{ name: "blank-provider", provider: "  ", model: "model" },
		{ name: "blank-model", provider: "provider", model: "  " },
	]) {
		assert.throws(() => resolvePiSpawnSelection({ template }), /must define both nonempty provider and model/);
	}
	assert.deepEqual(resolvePiSpawnSelection({
		piModel: "explicit/model",
		template: { name: "malformed", provider: "template-only", thinking: "xhigh" },
	}), {
		provider: "explicit",
		modelId: "model",
		modelSource: "explicit",
		thinking: "xhigh",
		thinkingSource: "template",
	});
});

test("explicit and template Pi models are exact-validated while inherited models skip lookup", () => {
	const calls: Array<[string, string]> = [];
	validatePiModelSelection(
		{ provider: "provider", modelId: "model/route:tag", modelSource: "explicit" },
		(provider, modelId) => {
			calls.push([provider, modelId]);
			return { provider, modelId };
		},
	);
	assert.deepEqual(calls, [["provider", "model/route:tag"]]);
	assert.throws(
		() => validatePiModelSelection(
			{ provider: "provider", modelId: "missing", modelSource: "template" },
			() => undefined,
		),
		/Pi model not found: provider\/missing/,
	);
	validatePiModelSelection(
		{ provider: "parent", modelId: "current", modelSource: "parent" },
		() => { throw new Error("inherited current model must not be revalidated"); },
	);
});

test("Pi-only spawn fields are rejected for Cursor", () => {
	assert.throws(() => validateSpawnPiOptions("cursor", { pi_model: "provider/model" }), /only valid when backend=pi/);
	assert.throws(() => validateSpawnPiOptions("cursor", { pi_thinking: "off" }), /only valid when backend=pi/);
	assert.doesNotThrow(() => validateSpawnPiOptions("cursor", {}));
	assert.doesNotThrow(() => validateSpawnPiOptions("pi", { pi_model: "provider/model", pi_thinking: "max" }));
});

test("Cursor model runtime validation accepts supported values without exposing a preset list", () => {
	assert.equal(requireCursorModel("Auto"), "Auto");
	assert.equal(requireCursorModel("Grok 4.5 High"), "Grok 4.5 High");
	let errorMessage = "";
	assert.throws(() => requireCursorModel("invalid"), (error: unknown) => {
		errorMessage = error instanceof Error ? error.message : String(error);
		return true;
	});
	assert.match(errorMessage, /list_subagent_models/);
	assert.doesNotMatch(errorMessage, /Auto|Grok/);
	for (const value of [undefined, "auto", 42]) {
		assert.throws(() => requireCursorModel(value), /list_subagent_models/);
	}
});

test("Cursor model resolution uses explicit, parsed template, then default precedence", () => {
	assert.equal(resolveCursorSpawnModel("cursor", "Auto", { cursorModel: "Grok 4.5 High" }), "Auto");
	assert.equal(resolveCursorSpawnModel("cursor", undefined, { cursorModel: "Grok 4.5 High" }), "Grok 4.5 High");
	assert.equal(resolveCursorSpawnModel("cursor", undefined), "Auto");
	assert.throws(() => resolveCursorSpawnModel("cursor", "invalid"), /list_subagent_models/);
});

test("Pi ignores cursor_model, including invalid values, for compatibility", () => {
	assert.equal(resolveCursorSpawnModel("pi", "invalid", { cursorModel: "Grok 4.5 High" }), undefined);
});

test("current scheduler contract keeps explicit backend/model resolution and opaque runtime selection", () => {
	// Tool registration and lifecycle behavior are exercised through the controlled integration
	// harness. Keep this unit-level contract on public selection behavior rather than source regexes.
	assert.deepEqual(parsePiModel("provider/model"), { provider: "provider", modelId: "model" });
	assert.equal(resolveCursorSpawnModel("cursor", undefined), "Auto");
	assert.throws(() => validateSpawnPiOptions("cursor", { pi_model: "provider/model" }), /only valid when backend=pi/);
	assert.equal(resolveCursorSpawnModel("pi", "not-a-preset"), undefined);
});

test("Pi tool inheritance excludes parent-only extension tools", () => {
	const selected = selectInheritedPiTools(
		["exec_command", "spawn_agent"],
		[
			{ name: "exec_command", sourceInfo: { source: "pi-codex-conversion" } },
			{ name: "spawn_agent", sourceInfo: { source: "pi-bstn-subagents" } },
		],
	);
	assert.equal(selected, "read,bash,grep,find,ls");
	assert.equal(
		selectInheritedPiTools(
			["read", "bash", "spawn_agent"],
			[
				{ name: "read", sourceInfo: { source: "builtin" } },
				{ name: "bash", sourceInfo: { source: "builtin" } },
				{ name: "spawn_agent", sourceInfo: { source: "pi-bstn-subagents" } },
			],
		),
		"read,bash",
	);
});

test("settled subagents retain the documented fifteen-minute idle-close window", () => {
	assert.equal(SUBAGENT_IDLE_CLOSE_MS, 15 * 60 * 1000);
});

test("response journal normalization accepts one finalized response and never raw thought", () => {
	// The controlled runtime integration test verifies that streaming text is materialized once
	// at terminal transition. The journal contract independently rejects raw thought payloads.
	const event = normalizeRunLedgerEvent({ v: 1, seq: 1, ts: 1, turn: 1, kind: "response", text: "final response" });
	assert.deepEqual(event, { v: 1, seq: 1, ts: 1, turn: 1, kind: "response", text: "final response" });
	assert.equal(normalizeRunLedgerEvent({ v: 1, seq: 2, ts: 2, turn: 1, kind: "thought", text: "raw thought" }), undefined);
});

test("activity summaries prefer sanitized live phases and fall back to the task", () => {
	assert.equal(compactActivityText("\u001b[31mRead\u001b[0m\n  package.json\u202e"), "Read package.json");
	assert.equal(
		agentActivitySummary({ status: "running", lastTaskMessage: "Review\nactivity UI" }, "Tool · bash"),
		"Tool · bash",
	);
	assert.equal(
		agentActivitySummary({ status: "completed", lastTaskMessage: "Review\nactivity UI", finalResponse: "Found\nthree issues" }, "Writing response"),
		"Result · Found three issues",
	);
	assert.equal(
		agentActivitySummary({ status: "failed", lastTaskMessage: "Review activity UI" }),
		"Task · Review activity UI",
	);
	assert.equal(agentActivitySummary({ status: "running" }), "Working");
});

test("agent elapsed time uses the legacy minute-second format", () => {
	assert.equal(formatElapsed(1_000, 1_000), "0:00");
	assert.equal(formatElapsed(1_000, 66_000), "1:05");
	assert.equal(formatElapsed(1_000, 3_662_000), "61:01");
});

test("persistent widget metadata formats Pi thinking and legacy unknown exactly", () => {
	const now = 66_000;
	assert.equal(formatPersistentWidgetMetadata({
		backend: "pi",
		model: "openai-codex:gpt-5.6-terra",
		thinking: "high",
		status: "running",
		createdAt: 1_000,
	}, now), "[pi] openai-codex:gpt-5.6-terra · thinking high · running · 1:05");
	assert.equal(formatPersistentWidgetMetadata({
		backend: "pi",
		model: "legacy:model",
		status: "completed",
		createdAt: 1_000,
	}, now), "[pi] legacy:model · thinking unknown · completed · 1:05");
});

test("persistent widget metadata omits stale thinking for Cursor exactly", () => {
	assert.equal(formatPersistentWidgetMetadata({
		backend: "cursor",
		model: "Grok 4.5 High",
		thinking: "max",
		status: "failed",
		createdAt: 1_000,
	}, 66_000), "[cursor] Grok 4.5 High · failed · 1:05");
});


test("Pi RPC tool normalization retains stable ids, args, partial results, result, and isError", () => {
	assert.deepEqual(normalizePiRpcToolEvent({ type: "tool_execution_start", toolCallId: "pi-1", toolName: "bash", args: { command: "echo hi" } }), {
		type: "tool_start", id: "pi-1", name: "bash", input: { command: "echo hi" },
	});
	assert.deepEqual(normalizePiRpcToolEvent({ type: "tool_execution_update", toolCallId: "pi-1", partialResult: { text: "half" } }), {
		type: "tool_update", id: "pi-1", status: undefined, partialResult: { text: "half" },
	});
	assert.deepEqual(normalizePiRpcToolEvent({ type: "tool_execution_end", toolCallId: "pi-1", result: { text: "bad" }, isError: true }), {
		type: "tool_end", id: "pi-1", status: undefined, result: { text: "bad" }, isError: true,
	});
	assert.deepEqual(normalizePiRpcToolEvent({ type: "tool_execution_start", toolName: "bash" }), { type: "tool_observed", phase: "Observed Pi tool without stable id" });
});

test("Cursor tool normalization never correlates title-only updates and uses explicit stable IDs", () => {
	assert.deepEqual(normalizeCursorToolUpdate({ sessionUpdate: "tool_call", title: "bash", toolCallId: "cursor-1", input: { command: "echo hi" } }), {
		type: "tool_start", id: "cursor-1", name: "bash", input: { command: "echo hi" },
	});
	assert.deepEqual(normalizeCursorToolUpdate({ sessionUpdate: "tool_call_update", title: "bash", toolCallId: "cursor-1", status: "completed", output: "done" }), {
		type: "tool_end", id: "cursor-1", status: "completed", result: "done", isError: false,
	});
	const observed = normalizeCursorToolUpdate({ sessionUpdate: "tool_call_update", title: "same title", status: "completed", output: "unavailable" });
	assert.equal(observed?.type, "tool_observed");
	assert.match(observed?.type === "tool_observed" ? observed.phase : "", /same title/);
});

test("Cursor ACP capabilities retain only the reconnect bit", () => {
	assert.deepEqual(sanitizeAcpCapabilities({ loadSession: true, mcpCapabilities: { tools: true }, promptCapabilities: { image: true } }), { loadSession: true });
	assert.deepEqual(sanitizeAcpCapabilities({ loadSession: false, unsafe: "discard" }), { loadSession: false });
	assert.equal(sanitizeAcpCapabilities({ mcpCapabilities: {} }), undefined);
});


test("terminal tool helper emits one exact end per active ID and clears no lifecycle by title", () => {
	const events = terminalizeActiveToolEvents(new Map([["one", "bash"], ["two", "same title"]]), "interrupted");
	assert.deepEqual(events, [{ id: "one", status: "interrupted" }, { id: "two", status: "interrupted" }]);
	assert.equal(finalizeActiveToolStatus("completed"), "settled-without-terminal-update");
	assert.equal(finalizeActiveToolStatus("failed"), "failed");
});

test("permission journal state follows actual ACP outcomes including fallback cancellation", () => {
	assert.equal(permissionJournalStatus({ outcome: { outcome: "selected", optionId: "allow-once" } }), "resolved");
	assert.equal(permissionJournalStatus({ outcome: { outcome: "selected", optionId: "reject_once" } }), "rejected");
	assert.equal(permissionJournalStatus(resolveAutomaticPermission("allow-once", [{ optionId: "reject-once" }])), "rejected");
	assert.equal(permissionJournalStatus(resolveAutomaticPermission("deny", [{ optionId: "reject-once" }])), "rejected");
	assert.equal(permissionJournalStatus(resolveAutomaticPermission("deny", [])), "cancelled");
	assert.equal(permissionJournalStatus({ outcome: { outcome: "cancelled" } }, "expired"), "expired");
});


test("repeated opaque partial results become counts without persisting their text", () => {
	const partials = ["token=top-secret", "https://user:password@example.test"];
	const records = partials.map((partial, index) => ({ kind: "tool-update", id: "same", status: "streaming", count: opaqueToolValueCount(partial), index }));
	assert.deepEqual(records.map((record) => record.count), [16, 34]);
	assert.doesNotMatch(JSON.stringify(records), /token|secret|password|example/i);
});

test("Pi session stats parser accepts only numeric non-identifying totals", async () => {
	const { parsePiSessionStats } = await import("../extensions/pi-runtime.ts");
	const raw = { sessionFile: "/private/session.jsonl", sessionId: "private-session", userMessages: 1, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 9, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.25, contextUsage: { tokens: null, contextWindow: 100, percent: null } };
	assert.deepEqual(parsePiSessionStats(raw), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10, cost: 0.25, contextUsage: { tokens: null, contextWindow: 100, percent: null } });
	assert.equal(parsePiSessionStats({ ...raw, sessionId: "" }), undefined);
	assert.equal(parsePiSessionStats({ ...raw, tokens: { ...raw.tokens, total: Infinity } }), undefined);
	assert.equal(parsePiSessionStats({ ...raw, contextUsage: undefined })!.contextUsage, undefined);
});

test("Pi compaction hints use result numbers and never retain textual or identifying payloads", async () => {
	const { normalizePiCompactionEvent } = await import("../extensions/pi-runtime.ts");
	assert.deepEqual(normalizePiCompactionEvent({ type: "compaction_start", reason: "threshold", summary: "secret" }), { type: "compaction", state: "started", reason: "threshold" });
	assert.deepEqual(normalizePiCompactionEvent({ type: "compaction_end", reason: "overflow", willRetry: true, result: { tokensBefore: 99, estimatedTokensAfter: 12, summary: "secret", firstKeptEntryId: "id" }, details: "private" }), { type: "compaction", state: "completed", reason: "overflow", tokensBefore: 99, estimatedTokensAfter: 12, willRetry: true });
	assert.deepEqual(normalizePiCompactionEvent({ type: "compaction_end", errorMessage: "private error", result: { tokensBefore: 9 } }), { type: "compaction", state: "failed", tokensBefore: 9 });
	assert.deepEqual(normalizePiCompactionEvent({ type: "compaction_end", aborted: true, result: { estimatedTokensAfter: 3 } }), { type: "compaction", state: "aborted", estimatedTokensAfter: 3 });
	assert.deepEqual(normalizePiCompactionEvent({ type: "compaction_end" }), { type: "compaction", state: "failed" });
});
