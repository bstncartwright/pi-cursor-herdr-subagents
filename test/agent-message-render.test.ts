import assert from "node:assert/strict";
import test from "node:test";
import {
	COMPLETION_FOLLOW_UP_DETAIL_KEYS,
	buildCompletionFollowUpDetails,
	computeDurationMs,
	formatCompactTokens,
	formatDurationMs,
	renderCompletionMessage,
	renderSpawnCall,
	renderSpawnResult,
	spawnTaskLabel,
} from "../extensions/agent-message-render.ts";

/** Recognizable wrappers so theme usage is asserted without ANSI. */
const theme = {
	fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
	bold(text: string) { return `*${text}*`; },
};

const identity = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
};

test("spawn call uses ▸ /task [backend] agent_type and never shows message/prompt", () => {
	const rendered = renderSpawnCall({
		task_name: "/Review/Api/",
		backend: "pi",
		agent_type: "reviewer",
		message: "SECRET_PROMPT_BODY",
		prompt: "ALSO_SECRET",
	}, theme);
	assert.match(rendered, /▸/);
	assert.match(rendered, /<accent>\/Review\/Api<\/accent>/);
	assert.match(rendered, /<dim>\[pi\]<\/dim>/);
	assert.match(rendered, /<dim>reviewer<\/dim>/);
	assert.doesNotMatch(rendered, /SECRET_PROMPT_BODY|ALSO_SECRET|message|prompt/);
});

test("spawn call is robust to missing args", () => {
	assert.equal(spawnTaskLabel(undefined), "/?");
	assert.equal(spawnTaskLabel(""), "/?");
	assert.equal(spawnTaskLabel("  /alpha/  "), "/alpha");
	const missing = renderSpawnCall({}, identity);
	assert.equal(missing, "▸ /? [?]");
	assert.equal(renderSpawnCall(null, identity), "▸ /? [?]");
	assert.equal(renderSpawnCall({ task_name: "beta" }, identity), "▸ /beta [?]");
});

test("spawn success is queued semantics without checkmark; error is Spawn failed only", () => {
	const success = renderSpawnResult({
		details: { agent_name: "/alpha", backend: "pi", model: "openai:gpt", thinking: "high", isolation: "shared" },
	}, identity);
	assert.equal(success, "  ⎿  Queued in background\n  pi · openai:gpt · thinking high · shared");
	assert.doesNotMatch(success, /✓|SECRET|Spawned/);

	const cursor = renderSpawnResult({
		details: { backend: "cursor", model: "Auto", isolation: "worktree", thinking: "high" },
	}, identity);
	assert.equal(cursor, "  ⎿  Queued in background\n  cursor · Auto · worktree");
	assert.doesNotMatch(cursor, /thinking/);

	const failed = renderSpawnResult({ isError: true, details: { agent_name: "/x", output: "boom details" } as any }, theme);
	assert.equal(failed, "<error>✗ Spawn failed</error>");
	assert.doesNotMatch(failed, /boom|Queued|✓/);
});

test("completion follow-up details are an explicit allowlist projection", () => {
	const details = buildCompletionFollowUpDetails({
		agentName: "/alpha",
		mailStatus: "interrupted",
		agentStatus: "paused",
		terminalReason: "shutdown-paused",
		turnId: "turn-1",
		backend: "pi",
		model: "openai:gpt",
		thinking: "high",
		isolation: "shared",
		startedAt: 1_000,
		createdAt: 500,
		completedAt: 19_000,
		metrics: {
			sampledAt: 18_000,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 5_900,
			cost: 0.01,
			compactionCount: 0,
			contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
		},
		output: "line one\nline two",
		truncated: true,
		fullOutputPath: "/tmp/response.txt",
	});
	assert.deepEqual(Object.keys(details).sort(), [...COMPLETION_FOLLOW_UP_DETAIL_KEYS].sort());
	assert.equal(details.status, "interrupted");
	assert.equal(details.agentStatus, "paused");
	assert.equal(details.durationMs, 18_000);
	assert.equal(details.thinking, "high");
	assert.equal(details.metrics?.totalTokens, 5_900);
	assert.deepEqual(details.metrics?.contextUsage, { tokens: 10, contextWindow: 100, percent: 10 });
	assert.equal(details.fullOutputPath, "/tmp/response.txt");

	const forbidden = ["id", "parentSessionId", "createdAt", "finalResponse", "error", "lastTaskMessage", "logFile", "worktree", "cwd", "approvalId", "summary", "allowOnceOffered", "message", "prompt", "task"];
	for (const key of forbidden) assert.equal(Object.hasOwn(details, key), false, key);

	const cursor = buildCompletionFollowUpDetails({
		agentName: "/c",
		mailStatus: "completed",
		agentStatus: "completed",
		backend: "cursor",
		model: "Auto",
		thinking: "high",
		isolation: "shared",
		createdAt: 1,
		completedAt: 2,
		metrics: {
			sampledAt: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
			totalTokens: 2, cost: 0, compactionCount: 0,
		},
		output: "ok",
		truncated: false,
	});
	assert.equal(cursor.thinking, undefined);
	assert.equal(cursor.metrics, undefined);
	assert.equal(Object.hasOwn(cursor, "fullOutputPath"), false);
});

test("duration falls back to createdAt and clamps; compact tokens and duration format", () => {
	assert.equal(computeDurationMs({ createdAt: 100, completedAt: 50 }), 0);
	assert.equal(computeDurationMs({ createdAt: 100, startedAt: 120, completedAt: 220 }), 100);
	assert.equal(computeDurationMs({ createdAt: 100, completedAt: 250 }), 150);
	assert.equal(formatCompactTokens(5_900), "5.9k");
	assert.equal(formatCompactTokens(42), "42");
	assert.equal(formatDurationMs(18_000), "18s");
	assert.equal(formatDurationMs(500), "500ms");
	assert.equal(formatDurationMs(65_000), "1:05");
});

test("completion renderer status styles, stats, collapsed/expanded, and never uses message.content", () => {
	const piDetails = {
		agentName: "/alpha",
		backend: "pi",
		status: "interrupted",
		agentStatus: "paused",
		model: "openai:gpt",
		thinking: "high",
		isolation: "shared",
		durationMs: 18_000,
		metrics: {
			sampledAt: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
			totalTokens: 5_900, cost: 0, compactionCount: 0,
		},
		output: "\n\u001b[31mFirst secret line\u001b[0m\nsecond\nthird",
		truncated: false,
	};

	const collapsed = renderCompletionMessage({ details: piDetails, content: "MUST_NOT_APPEAR from content" }, { expanded: false }, identity);
	assert.match(collapsed, /^■ \/alpha paused\n/);
	assert.match(collapsed, /pi · openai:gpt · thinking high · usage 5\.9k · 18s/);
	assert.doesNotMatch(collapsed, /\bshared\b/);
	assert.match(collapsed, /  ⎿  First secret line/);
	assert.doesNotMatch(collapsed, /MUST_NOT_APPEAR|second|third|\u001b/);

	const worktree = renderCompletionMessage({
		details: { ...piDetails, isolation: "worktree", agentStatus: "completed", status: "completed" },
	}, { expanded: false }, identity);
	assert.match(worktree, /^✓ \/alpha completed\n/);
	assert.match(worktree, /worktree/);

	const cursor = renderCompletionMessage({
		details: {
			agentName: "/cursor",
			backend: "cursor",
			status: "completed",
			agentStatus: "completed",
			model: "Auto",
			thinking: "high",
			isolation: "shared",
			durationMs: 2_000,
			output: "",
		},
	}, { expanded: false }, identity);
	assert.match(cursor, /cursor · Auto · usage — · 2s/);
	assert.doesNotMatch(cursor, /thinking/);
	assert.match(cursor, /  ⎿  No output/);

	const failed = renderCompletionMessage({
		details: { agentName: "/x", backend: "pi", agentStatus: "failed", status: "failed", model: "m", durationMs: 0, output: "err" },
	}, { expanded: false }, theme);
	assert.match(failed, /<error>✗<\/error>/);

	const many = Array.from({ length: 35 }, (_, index) => index === 1 ? "\u001b]0;unsafe title\u0007line-1\u202eevil" : `line-${index}`).join("\n");
	const expanded = renderCompletionMessage({
		details: { ...piDetails, agentStatus: "closed", status: "closed", output: many, truncated: true, fullOutputPath: "/tmp/full.txt" },
		content: "content-fallback",
	}, { expanded: true }, identity);
	assert.match(expanded, /^■ \/alpha closed\n/);
	assert.match(expanded, /^  ⎿  line-0$/m);
	assert.match(expanded, /^  ⎿  line-29$/m);
	assert.doesNotMatch(expanded, /line-30/);
	assert.match(expanded, /… 5 more lines/);
	assert.doesNotMatch(expanded, /\/tmp\/full\.txt/);
	assert.doesNotMatch(expanded, /content-fallback|\u001b|\u202e/);

	const collapsedTruncated = renderCompletionMessage({
		details: { ...piDetails, truncated: true, fullOutputPath: "/private/response.txt" },
	}, { expanded: false }, identity);
	assert.doesNotMatch(collapsedTruncated, /\/private\/response\.txt/);
});


test("completion renderer sanitizes all malformed detail fields and never displays paths", () => {
	const hostile = "\u001b]0;title\u0007bad\n\u202ereversed";
	const rendered = renderCompletionMessage({ details: { agentName: hostile, backend: hostile, status: hostile, agentStatus: hostile, model: hostile, thinking: hostile, isolation: hostile, durationMs: "bad", output: `${hostile}\nline`, truncated: true, fullOutputPath: "/private/full" } }, { expanded: true }, identity);
	assert.match(rendered, /^■ bad reversed —/m);
	assert.doesNotMatch(rendered, /\x1b|\u202e|title|\/private/);
	assert.match(rendered, /  ⎿  bad\n  ⎿  reversed/);
});
