import assert from "node:assert/strict";
import test from "node:test";
import {
	agentActivitySummary,
	compactActivityText,
	JsonlDecoder,
	normalizeTaskName,
	parentScopeKey,
	parseAgentTemplateText,
	selectInheritedPiTools,
	SUBAGENT_IDLE_CLOSE_MS,
	taskStorageKey,
} from "../extensions/unified.ts";

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

test("focused tool contract requires an explicit backend and keeps Cursor on ACP", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../extensions/unified.ts", import.meta.url), "utf8");
	for (const tool of [
		"spawn_agent",
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
	assert.match(source, /new CursorAcpClient/);
	const acpSource = await readFile(new URL("../extensions/acp.ts", import.meta.url), "utf8");
	assert.match(acpSource, /session\/load/);
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

test("activity summaries prefer sanitized live phases and fall back to the task", () => {
	assert.equal(compactActivityText("\u001b[31mRead\u001b[0m\n  package.json\u202e"), "Read package.json");
	assert.equal(
		agentActivitySummary({ status: "running", lastTaskMessage: "Review\nactivity UI" }, "Tool · bash"),
		"Tool · bash",
	);
	assert.equal(
		agentActivitySummary({ status: "completed", lastTaskMessage: "Review\nactivity UI" }, "Writing response"),
		"Task · Review activity UI",
	);
	assert.equal(agentActivitySummary({ status: "running" }), "Working");
});
