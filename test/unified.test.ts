import assert from "node:assert/strict";
import test from "node:test";
import {
	agentActivitySummary,
	compactActivityText,
	formatElapsed,
	formatPersistentWidgetMetadata,
	JsonlDecoder,
	normalizeCursorToolUpdate,
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
	SUBAGENT_IDLE_CLOSE_MS,
	taskStorageKey,
} from "../extensions/unified.ts";
import { resolveAutomaticPermission } from "../extensions/helpers.ts";

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

test("focused tool contract requires an explicit backend and keeps Cursor on ACP", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../extensions/unified.ts", import.meta.url), "utf8");
	for (const tool of [
		"spawn_agent",
		"list_subagent_models",
		"wait_agent",
		"wait_all_agents",
		"list_agents",
		"read_agent_response",
		"send_message",
		"interrupt_agent",
		"close_agent",
		"respond_agent_permission",
	]) assert.match(source, new RegExp(`name: "${tool}"`));
	assert.match(source, /backend: Backend/);
	assert.doesNotMatch(source, /backend:\s*Type\.Optional\(Backend\)/);
	assert.match(source, /pi_model: Type\.Optional\(Type\.String/);
	assert.match(source, /pi_thinking: Type\.Optional\(PiThinkingSchema\)/);
	assert.match(source, /cursor_model: Type\.Optional\(Type\.String\(\{ description: "Cursor model string\. Use list_subagent_models for exact supported values\." \}\)\)/);
	assert.doesNotMatch(source, /CURSOR_MODEL_IDS/);
	assert.match(source, /const cursorModel = resolveCursorSpawnModel\(params\.backend, params\.cursor_model, template\);[\s\S]*await this\.ensurePrerequisites\(params\.backend, cwd\)/);
	assert.match(source, /backend: Type\.Optional\(Type\.String/);
	assert.match(source, /offset: Type\.Optional\(Type\.Integer\(\{ minimum: 0/);
	assert.match(source, /limit: Type\.Optional\(Type\.Integer\(\{ minimum: 1, maximum: 100/);
	assert.match(source, /listSubagentModels\(ctx, params\)/);
	assert.match(source, /subagentModelToolResult\(catalog\)/);
	assert.match(source, /ctx\.modelRegistry\.find\(provider, modelId\)/);
	assert.match(source, /model: piSelection \? `\$\{piSelection\.provider\}:\$\{piSelection\.modelId\}` : cursorModel/);
	assert.match(source, /\.\.\.\(piSelection \? \{[\s\S]*provider: piSelection\.provider,[\s\S]*modelId: piSelection\.modelId,[\s\S]*thinking: piSelection\.thinking,[\s\S]*\} : \{\}\)/);
	assert.match(source, /new CursorAcpClient/);
	const acpSource = await readFile(new URL("../extensions/acp.ts", import.meta.url), "utf8");
	assert.match(acpSource, /session\/load/);
	assert.match(acpSource, /export const CURSOR_MODEL_IDS/);
	assert.match(acpSource, /const preset = CURSOR_MODEL_PRESETS\[model\]/);
	assert.match(source, /isCursorModel\(frontmatter\.cursor_model\)/);
	assert.match(source, /DEFAULT_CURSOR_MODEL/);
	assert.doesNotMatch(source, /sendAsyncMessage\(/);
	assert.match(source, /deliverAs: "followUp"/);
	assert.match(source, /observedByWaitAll/);
	assert.match(source, /registerCommand\("subagent"/);
	const entrySource = await readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(entrySource, /name:\s*"subagent"/);
	assert.doesNotMatch(entrySource, /Legacy Cursor Subagent/);
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

test("settled subagents auto-close after fifteen idle minutes", async () => {
	assert.equal(SUBAGENT_IDLE_CLOSE_MS, 15 * 60 * 1000);
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../extensions/unified.ts", import.meta.url), "utf8");
	assert.match(source, /scheduleIdleClose\(live\.info\)/);
	assert.match(source, /this\.clearIdleClose\(info\.id\);[\s\S]*this\.clearCompletionMail\(info\)/);
	assert.match(source, /Persist the claim before awaiting resource cleanup/);
	assert.match(source, /auto-closed after 15 minutes idle/);
});

test("response deltas stay out of the journal until one finalized response", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../extensions/unified.ts", import.meta.url), "utf8");
	const piRuntime = await readFile(new URL("../extensions/pi-runtime.ts", import.meta.url), "utf8");
	const piHandler = source.slice(source.indexOf("private handlePiEvent"), source.indexOf("private handleCursorNotification"));
	const cursorHandler = source.slice(source.indexOf("private handleCursorNotification"), source.indexOf("private async handleCursorRequest"));
	const finalize = source.slice(source.indexOf("private finalize"), source.indexOf("private completionEvent"));
	assert.doesNotMatch(piHandler, /kind: "response"/);
	assert.doesNotMatch(cursorHandler, /kind: "response"/);
	assert.match(piHandler, /live\.currentOutput \+= event\.text;[\s\S]*this\.setPhase\(live, "Writing response"\);[\s\S]*log\(live\.info, "assistant", event\.text\)/);
	assert.match(cursorHandler, /live\.currentOutput \+= text;[\s\S]*this\.setPhase\(live, "Writing response"\);[\s\S]*log\(live\.info, "assistant", text\)/);
	assert.match(piRuntime, /this\.candidateResponse = messageText\(event\.message\);/);
	assert.match(piRuntime, /this\.candidateResponse = messageText\(assistant\);/);
	assert.doesNotMatch(piRuntime, /this\.candidateResponse = messageText\([^)]*\)\.trim\(\);/);
	const responseAppend = 'this.appendLedger(live.info, { kind: "response", text: live.info.finalResponse });';
	assert.equal(finalize.split(responseAppend).length - 1, 1);
	assert.ok(finalize.indexOf(responseAppend) < finalize.indexOf('this.appendLedger(live.info, { kind: "runtime", state: status })'));
	assert.ok(finalize.indexOf(responseAppend) < finalize.indexOf('this.appendLedger(live.info, { kind: "completion", status, summary: error ?? live.info.finalResponse })'));
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
