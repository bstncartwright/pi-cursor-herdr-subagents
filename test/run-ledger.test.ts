import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_SERIALIZED_SUMMARY_LENGTH,
	buildRunLedgerPresentation,
	normalizeRunLedgerEvent,
	parseRunLedgerJsonl,
	createRunLedgerState,
	redactAndBound,
	reduceRunLedgerEvents,
	renderRunLedger,
	renderRunLedgerText,
	sanitizeResponseText,
	sanitizeTerminalText,
	summarizeToolInput,
	summarizeToolResult,
	summarizeToolOutcome,
	thoughtPreview,
	toolLedgerKey,
	type RunLedgerEvent,
} from "../extensions/run-ledger.ts";

const at = 1_000_000;
function event<K extends RunLedgerEvent["kind"]>(kind: K, fields: Record<string, unknown>, seq: number, ts = at + seq * 1_000, turn = 2): Extract<RunLedgerEvent, { kind: K }> {
	const marker = kind === "thought" ? { previewKind: "heading" } : kind === "tool-start" || kind === "tool-update" || kind === "tool-end" ? { summaryFormat: "semantic-v1" } : {};
	return { v: 1, kind, seq, ts, turn, ...marker, ...fields } as Extract<RunLedgerEvent, { kind: K }>;
}

test("terminal sanitization, recursive redaction, and code-point bounds are safe", () => {
	assert.equal(sanitizeTerminalText("\u001b[31mred\u001b[0m \u001b]8;;https://evil\u0007link\u001b]8;;\u0007\n\u202Espoof\u0000"), "red link spoof");
	assert.equal(sanitizeTerminalText("\u001b]8;;https://unterminated"), "");
	assert.equal(summarizeToolResult("😀😀😀", { maxStringLength: 2 }), "text output · 6 chars");
	const safe = JSON.stringify(redactAndBound({ token: "no", nested: { password: "never" }, values: Array(40).fill("x") }, { maxDepth: 2, maxKeys: 4, maxArrayLength: 2 }));
	assert.match(safe, /\[REDACTED\]/);
	assert.doesNotMatch(safe, /never|"no"/);
	assert.ok(summarizeToolResult({ data: "x".repeat(10_000) }).length <= MAX_SERIALIZED_SUMMARY_LENGTH);
});

test("strict v1 metadata rejects strings, fractions, dates, and unsafe seq/turn", () => {
	const valid = { v: 1, seq: 1, ts: at, turn: 0, kind: "task", synopsis: "ok" };
	assert.ok(normalizeRunLedgerEvent(valid));
	for (const [field, value] of [["seq", "1"], ["seq", 1.5], ["seq", Number.MAX_SAFE_INTEGER + 1], ["turn", "1"], ["turn", 0.1], ["ts", "2026-01-01"], ["ts", "1"], ["ts", Infinity]] as const) {
		assert.equal(normalizeRunLedgerEvent({ ...valid, [field]: value }), undefined, `${field}=${String(value)}`);
	}
});

test("JSONL tail parsing preserves exact boundaries, drops partial prefixes, and retains newest complete records", () => {
	const old = JSON.stringify({ v: 1, seq: 1, ts: at, turn: 1, kind: "task", synopsis: "old" });
	const middle = JSON.stringify({ v: 1, seq: 2, ts: at + 1, turn: 1, kind: "task", synopsis: "middle" });
	const recent = JSON.stringify({ v: 1, seq: 3, ts: at + 2, turn: 1, kind: "task", synopsis: "recent" });
	const unsupported = JSON.stringify({ v: 9, seq: 4, ts: at, turn: 1, kind: "task", synopsis: "no" });
	const normal = parseRunLedgerJsonl(`${old}\nnope\n${unsupported}\n{"v":1`);
	assert.equal(normal.events.length, 1); assert.equal(normal.malformed, 1); assert.equal(normal.unsupported, 1);
	const boundary = parseRunLedgerJsonl(`${old}\n${recent}\n`, { maxBytes: Buffer.byteLength(`${recent}\n`) });
	assert.deepEqual(boundary.events.map((entry) => entry.kind === "task" ? entry.synopsis : ""), ["recent"]);
	const partial = parseRunLedgerJsonl(`${old}\n${recent}\n`, { maxBytes: Buffer.byteLength(`x\n${recent}\n`) });
	assert.deepEqual(partial.events.map((entry) => entry.kind === "task" ? entry.synopsis : ""), ["recent"]);
	const newest = parseRunLedgerJsonl(`${old}\n${middle}\n${recent}\n`, { maxLines: 2 });
	assert.deepEqual(newest.events.map((entry) => entry.kind === "task" ? entry.synopsis : ""), ["middle", "recent"]);
	for (const maxLines of [Number.NaN, Infinity, -1, 1.5]) {
		assert.equal(parseRunLedgerJsonl(`${old}\n${recent}\n`, { maxLines }).events.length, 2);
	}
	for (const maxBytes of [Number.NaN, Infinity, -1, 1.5]) {
		assert.equal(parseRunLedgerJsonl(`${old}\n${recent}\n`, { maxBytes }).events.length, 2);
	}
});

test("a seeded state retains identity and run-relative times after a long bounded tail omits the run event", () => {
	const run = JSON.stringify({ v: 1, seq: 0, ts: at, turn: 0, kind: "run", runId: "old-run", agentName: "Ada" });
	const recent = JSON.stringify({ v: 1, seq: 99, ts: at + 90_000, turn: 7, kind: "phase", name: "tail phase" });
	const journal = `${run}\n${"padding\n".repeat(20_000)}${recent}\n`;
	const parsed = parseRunLedgerJsonl(journal, { maxBytes: Buffer.byteLength(`${recent}\n`) });
	assert.equal(parsed.events[0]?.kind, "phase");
	const state = reduceRunLedgerEvents(parsed.events, createRunLedgerState({ startedAt: at, agentName: "Ada", backend: "pi", model: "gpt", thinking: "high", cwd: "/work", task: "seeded task" }));
	const text = renderRunLedgerText(renderRunLedger(state, { width: 100, height: 5, now: at + 100_000 }));
	assert.match(text, /^RUN Ada · running · 1:40 · turn 7/m);
	assert.match(text, /\+1:30 Phase · tail phase/);
	assert.match(text, /seeded task/);
});

test("thought contract accepts preview only and never persists raw short thoughts or secrets", () => {
	assert.equal(thoughtPreview("secret token=abc"), "Working through details");
	assert.equal(thoughtPreview("# token=abc"), "token=[REDACTED]");
	assert.equal(thoughtPreview("**Bold heading**\nsecret"), "Bold heading");
	assert.equal(normalizeRunLedgerEvent({ v: 1, seq: 1, ts: at, turn: 1, kind: "thought", text: "short secret token=abc" }), undefined);
	assert.equal(normalizeRunLedgerEvent({ v: 1, seq: 1, ts: at, turn: 1, kind: "thought", preview: "bare preview" }), undefined);
	const normalized = normalizeRunLedgerEvent({ v: 1, seq: 1, ts: at, turn: 1, kind: "thought", previewKind: "heading", preview: "short secret token=abc" });
	assert.deepEqual(normalized && normalized.kind === "thought" ? normalized.preview : undefined, "short secret token=[REDACTED]");
	const state = reduceRunLedgerEvents([normalized!]);
	assert.doesNotMatch(JSON.stringify(state), /abc/i);
});

test("settled multiline responses survive normalize, JSONL, reduce, and bounded render", () => {
	const finalizedOutput = "\x1b[31m- Package: pi\r\n  - install\tpi\r  - token=" + "abc";
	const normalized = normalizeRunLedgerEvent({ v: 1, seq: 1, ts: at, turn: 1, kind: "response", text: finalizedOutput });
	assert.deepEqual(normalized?.kind === "response" ? normalized.text : undefined, "- Package: pi\n  - install pi\n  - token=[REDACTED]");
	const parsed = parseRunLedgerJsonl(`${JSON.stringify(normalized)}\n`).events;
	const state = reduceRunLedgerEvents(parsed);
	const response = state.timeline.find((row) => row.kind === "response");
	assert.equal(response?.kind === "response" ? response.text : undefined, "- Package: pi\n  - install pi\n  - token=[REDACTED]");
	const frame = renderRunLedger(state, { width: 40, height: 4 });
	assert.equal(renderRunLedgerText(frame), "Run Ledger · running · 0ms · T1\n+0ms Response · - Package: pi\n  ↳   - install pi\n  ↳   - token=[REDACTED]");
	for (const row of frame.lines) {
		const rendered = row.tokens.map((token) => token.text).join("");
		assert.ok(Array.from(rendered).length <= frame.width);
		for (const token of row.tokens) assert.doesNotMatch(token.text, /[\r\n\x1b]/);
	}
	assert.doesNotMatch(renderRunLedgerText(frame), /abc/);
	for (let width = 1; width <= 20; width++) {
		const narrow = renderRunLedger(state, { width, height: 4 });
		for (const row of narrow.lines) {
			const rendered = row.tokens.map((token) => token.text).join("");
			assert.ok(Array.from(rendered).length <= width, `width ${width}: ${JSON.stringify(rendered)}`);
			for (const token of row.tokens) assert.doesNotMatch(token.text, /[\r\n]/);
		}
	}
});

test("response sanitizer preserves ordinary spacing and logical blank lines", () => {
	assert.equal(sanitizeResponseText("  lead  \tkeep\ntrail  "), "  lead   keep\ntrail  ");
	assert.equal(sanitizeResponseText("\x1b[31mred\x1b[0m\x00blue\u202e"), "red blue");
	assert.equal(sanitizeResponseText("  token=abc  "), "  token=[REDACTED]  ");
	assert.equal(sanitizeResponseText(" abc ", 4), " ab…");
	const blanks = reduceRunLedgerEvents([event("response", { text: "first\n\nthird" }, 1, at, 1)]);
	assert.equal(renderRunLedgerText(renderRunLedger(blanks, { width: 40, height: 4 })), "Run Ledger · running · 0ms · T1\n+0ms Response · first\n  ↳ \n  ↳ third");
});

test("thought and response chunks coalesce only within a turn", () => {
	const state = reduceRunLedgerEvents([
		event("thought", { preview: "# First" }, 1, at, 1), event("thought", { preview: "# Second" }, 2, at + 10, 1),
		event("thought", { preview: "# New turn" }, 3, at + 20, 2),
		event("response", { text: "a" }, 4, at + 30, 1), event("response", { text: "b" }, 5, at + 40, 1), event("response", { text: "c" }, 6, at + 50, 2),
	]);
	assert.deepEqual(state.timeline.filter((row) => row.kind === "thought").map((row) => [row.preview, row.chunks]), [["# First", 2], ["# New turn", 1]]);
	assert.deepEqual(state.timeline.filter((row) => row.kind === "response").map((row) => row.text), ["ab", "c"]);
});

test("tool correlation is composite turn+ID, supports reuse/late updates, and ignores duplicate terminals", () => {
	const state = reduceRunLedgerEvents([
		event("tool-start", { id: "same", name: "bash", inputSummary: "bash one" }, 1, at, 1),
		event("tool-end", { id: "same", resultPreview: "first output" }, 2, at + 100, 1),
		event("tool-start", { id: "same", name: "bash", inputSummary: "bash two" }, 3, at + 200, 2),
		event("tool-update", { id: "same", status: "streaming", count: 8 }, 4, at + 300, 2),
		event("tool-update", { id: "same", status: "late" }, 5, at + 400, 1),
		event("tool-end", { id: "same", errorPreview: "boom" }, 6, at + 500, 2),
		event("tool-end", { id: "same", resultPreview: "duplicate" }, 7, at + 600, 2),
	]);
	assert.equal(state.tools.size, 2);
	assert.equal(state.tools.get(toolLedgerKey(1, "same"))?.durationMs, 100);
	assert.equal(state.tools.get(toolLedgerKey(2, "same"))?.inputSummary, "bash two");
	assert.equal(state.tools.get(toolLedgerKey(2, "same"))?.errorPreview, "boom");
	assert.equal(state.tools.get(toolLedgerKey(2, "same"))?.resultPreview, undefined);
	assert.equal(state.unknownToolEvents, 2);
});

test("presentation blocks retain stable keys across lifecycle updates", () => {
	const start = event("tool-start", { id: "same", name: "read", inputSummary: "read · a.ts" }, 1, at, 1);
	const update = event("tool-update", { id: "same", status: "running", count: 2 }, 2, at + 1, 1);
	const first = reduceRunLedgerEvents([start]); const second = reduceRunLedgerEvents([start, update]);
	assert.equal(buildRunLedgerPresentation(first, { width: 80 }).blocks[0]!.key, buildRunLedgerPresentation(second, { width: 80 }).blocks[0]!.key);
	assert.match(renderRunLedgerText(renderRunLedger(second, { width: 80, height: 3 })), /updates 2/);
});

test("presentation block keys survive a bounded-tail head drop", () => {
	const phases = [1, 2, 3].map((seq) => event("phase", { name: `phase ${seq}` }, seq, at + seq, 1));
	const full = buildRunLedgerPresentation(reduceRunLedgerEvents(phases), { width: 80 }).blocks.map((block) => block.key);
	const tail = buildRunLedgerPresentation(reduceRunLedgerEvents(phases.slice(1)), { width: 80 }).blocks.map((block) => block.key);
	assert.deepEqual(full.slice(1), tail);
});


test("terminal tool ends leave no running rows after completion or interruption", () => {
	const state = reduceRunLedgerEvents([
		event("tool-start", { id: "one", name: "bash", inputSummary: "bash npm test" }, 1, at, 1),
		event("tool-start", { id: "two", name: "bash", inputSummary: "bash git status" }, 2, at + 1, 1),
		event("tool-end", { id: "one", status: "completed" }, 3, at + 2, 1),
		event("tool-end", { id: "two", status: "interrupted" }, 4, at + 3, 1),
	]);
	assert.deepEqual([...state.tools.values()].map((tool) => tool.status), ["completed", "interrupted"]);
	assert.ok([...state.tools.values()].every((tool) => tool.endedAt !== undefined));
});

test("duplicate active tool start does not append a ghost row", () => {
	const state = reduceRunLedgerEvents([
		event("tool-start", { id: "x", name: "bash", inputSummary: "bash one" }, 1, at, 2),
		event("tool-start", { id: "x", name: "bash", inputSummary: "bash duplicate" }, 2, at + 1, 2),
	]);
	assert.equal(state.tools.size, 1);
	assert.equal(state.timeline.filter((row) => row.kind === "tool").length, 1);
	assert.equal(state.tools.get(toolLedgerKey(2, "x"))?.inputSummary, "bash one");
	assert.equal(state.unknownToolEvents, 1);
});

test("tool summaries use semantic allowlists and opaque outcome counts", () => {
	assert.equal(summarizeToolInput("read", { path: "src/a.ts" }), "read src/a.ts");
	assert.equal(summarizeToolInput("write", { path: "secret.env", content: "TOKEN=top-secret" }), "write secret.env · 16 chars");
	assert.equal(summarizeToolInput("grep", { pattern: "TOKEN=top-secret", path: "src", limit: 3 }), "grep in src · limit 3");
	assert.equal(summarizeToolInput("bash", { command: "npm test" }), "bash npm test");
	const bash = summarizeToolInput("bash", { command: "curl https://user:secret@example.test/?token=abcdef" });
	assert.equal(bash, "bash curl command · 51 chars");
	assert.doesNotMatch(bash, /secret|token|example|abcdef/i);
	assert.equal(summarizeToolOutcome("Authorization: Bearer abcdef"), "text output · 28 chars");
	assert.equal(summarizeToolOutcome({ exitCode: 0, lines: 3, truncated: true }), "exit 0 · lines 3 · truncated");
	assert.equal(summarizeToolOutcome("boom", true), "error output · 4 chars");
	assert.equal(summarizeToolOutcome({ status: "token=abc", code: "secret" }), "structured output received");
});

test("tool normalization drops arbitrary partial output and raw summary fields", () => {
	const normalized = normalizeRunLedgerEvent({ v: 1, seq: 1, ts: at, turn: 1, kind: "tool-update", id: "x", status: "streaming", summary: "secret=abc", count: 12 });
	assert.deepEqual(normalized, { v: 1, seq: 1, ts: at, turn: 1, kind: "tool-update", id: "x", status: "streaming", count: 12, summaryFormat: "semantic-v1" });
	const started = normalizeRunLedgerEvent({ v: 1, seq: 2, ts: at, turn: 1, kind: "tool-start", id: "x", name: "bash", inputSummary: "curl token=abc", input: { command: "curl https://secret.example" } });
	assert.doesNotMatch(JSON.stringify(started), /secret|token|example/i);
	const read = normalizeRunLedgerEvent({ v: 1, seq: 3, ts: at, turn: 1, kind: "tool-start", id: "read", name: "read", input: { path: "src/a.ts" } });
	assert.equal(read?.kind === "tool-start" ? read.inputSummary : undefined, "read src/a.ts");
	const unmarkedEnd = normalizeRunLedgerEvent({ v: 1, seq: 4, ts: at, turn: 1, kind: "tool-end", id: "x", resultPreview: "token=abc" });
	assert.equal(unmarkedEnd?.kind === "tool-end" ? unmarkedEnd.resultPreview : undefined, undefined);
	assert.doesNotMatch(JSON.stringify(unmarkedEnd), /token|abc/i);
});

test("tool renderer exposes only semantic update counts and safe outcome labels", () => {
	const active = reduceRunLedgerEvents([
		event("tool-start", { id: "read", name: "read", inputSummary: "read src/a.ts" }, 1, at, 1),
		event("tool-update", { id: "read", status: "streaming", count: 42 }, 2, at + 250, 1),
	]);
	const activeText = renderRunLedgerText(renderRunLedger(active, { width: 100, height: 4, now: at + 500 }));
	assert.match(activeText, /read · src\/a.ts · streaming · updates 42/);
	assert.doesNotMatch(activeText, /read · read/);
});

test("newer turns clear stale completion, error, and permission even from a current-turn seed", () => {
	const failed = reduceRunLedgerEvents([
		event("runtime", { state: "failed" }, 1, at, 1),
		event("error", { message: "turn one failed" }, 2, at + 1, 1),
		event("permission", { status: "pending", summary: "old permission" }, 3, at + 2, 1),
		event("completion", { status: "failed", summary: "turn one" }, 4, at + 3, 1),
	]);
	const next = reduceRunLedgerEvents([
		event("runtime", { state: "running" }, 5, at + 4, 2),
		event("task", { synopsis: "turn two" }, 6, at + 5, 2),
		event("completion", { status: "completed", summary: "turn two success" }, 7, at + 6, 2),
	], { ...failed, turn: 2, runtimeState: "running" });
	const text = renderRunLedgerText(renderRunLedger(next, { width: 90, height: 6, now: at + 7 }));
	assert.match(text, /completed/); assert.match(text, /turn two success/);
	assert.doesNotMatch(text, /turn one failed|old permission/);
});

test("normalized thought previews survive round-trip and redact secrets", () => {
	const raw = { v: 1, seq: 1, ts: at, turn: 1, kind: "thought", previewKind: "heading", preview: thoughtPreview("**Planning X**\ntoken=abc") };
	const parsed = parseRunLedgerJsonl(`${JSON.stringify(raw)}\n`).events;
	const text = renderRunLedgerText(renderRunLedger(reduceRunLedgerEvents(parsed), { width: 80, height: 3 }));
	assert.match(text, /Thought · Planning X/); assert.doesNotMatch(text, /abc|token/i);
});

test("normalized tool summaries survive JSONL round-trip without raw leakage", () => {
	const raw = [
		{ v: 1, seq: 1, ts: at, turn: 1, kind: "tool-start", id: "read", name: "read", input: { path: "src/a.ts" } },
		{ v: 1, seq: 2, ts: at + 1_000, turn: 1, kind: "tool-end", id: "read", status: "completed", result: { lines: 2200, token: "abc" } },
	];
	const written = raw.map(normalizeRunLedgerEvent).filter(Boolean);
	const parsed = parseRunLedgerJsonl(`${written.map((entry) => JSON.stringify(entry)).join("\n")}\n`).events;
	const text = renderRunLedgerText(renderRunLedger(reduceRunLedgerEvents(parsed), { width: 100, height: 5, now: at + 1_000 }));
	assert.match(text, /read · src\/a.ts/); assert.match(text, /lines 2200/);
	assert.doesNotMatch(text, /token|abc|path unavailable/i);
});

test("opaque labels and write counts stay bounded without scanning huge payloads", () => {
	assert.equal(summarizeToolInput("write", { path: "x", content: "x".repeat(200_000) }), "write x · ≥100000 chars");
	assert.equal(summarizeToolOutcome("x".repeat(200_000)), "text output · ≥100000 chars");
	assert.equal(summarizeToolOutcome({ payload: "x".repeat(200_000) }), "structured output received");
	const circular: Record<string, unknown> = {}; circular.self = circular;
	assert.equal(summarizeToolOutcome(circular), "structured output received");
});

function fixture() {
	return reduceRunLedgerEvents([
		event("run", { runId: "run-123", title: "Build release", agentName: "Ada", backend: "pi", model: "gpt-test", thinking: "high", cwd: "/work" }, 0, at, 2),
		event("runtime", { state: "running" }, 1, at + 1_000),
		event("task", { synopsis: "Implement the ledger renderer" }, 2, at + 2_000),
		event("thought", { preview: "# Plan" }, 3, at + 3_000),
		event("tool-start", { id: "x", name: "bash", inputSummary: "bash npm test" }, 4, at + 4_000),
		event("tool-end", { id: "x", status: "completed", resultPreview: "text output · 11 chars" }, 5, at + 6_000),
		event("response", { text: "This response is intentionally long enough to wrap across several semantic lines." }, 6, at + 7_000),
		event("permission", { status: "pending", summary: "write report" }, 7, at + 8_000),
		event("error", { code: "EACCES", message: "Denied once" }, 8, at + 9_000),
		event("permission", { status: "resolved", summary: "write report" }, 9, at + 10_000),
		event("completion", { status: "completed", summary: "success" }, 10, at + 11_000),
	]);
}

test("elapsed time freezes at a completion timestamp and terminal runtime timestamp", () => {
	const completed = reduceRunLedgerEvents([
		event("run", { runId: "freeze" }, 0, at, 1),
		event("runtime", { state: "completed" }, 1, at + 4_000, 1),
		event("completion", { status: "completed" }, 2, at + 5_000, 1),
		event("runtime", { state: "closed" }, 3, at + 6_000, 1),
		event("completion", { status: "closed" }, 4, at + 7_000, 1),
	]);
	assert.equal(completed.runtimeState, "closed");
	assert.deepEqual(completed.completion, { ts: at + 5_000, turn: 1, status: "completed", summary: undefined });
	assert.equal(renderRunLedgerText(renderRunLedger(completed, { width: 100, height: 2, now: at + 9_000_000 })), "RUN freeze · completed · 5.0s · turn 1\nCompleted · completed");
	const missingCompletion = reduceRunLedgerEvents([
		event("run", { runId: "terminal" }, 0, at, 1),
		event("runtime", { state: "failed" }, 1, at + 6_000, 1),
	]);
	assert.equal(renderRunLedgerText(renderRunLedger(missingCompletion, { width: 100, height: 1, now: at + 9_000_000 })), "RUN terminal · failed · 6.0s · turn 1");
});

test("elapsed time continues advancing for active runs", () => {
	const active = reduceRunLedgerEvents([
		event("run", { runId: "active" }, 0, at, 1),
		event("runtime", { state: "running" }, 1, at + 1_000, 1),
	]);
	assert.equal(renderRunLedgerText(renderRunLedger(active, { width: 100, height: 1, now: at + 90_000 })), "RUN active · running · 1:30 · turn 1");
});

test("wide renderer shows metadata, run-relative timestamps, context-first tool rows, and wrapped response", () => {
	const text = renderRunLedgerText(renderRunLedger(fixture(), { width: 120, height: 13, now: at + 20_000 }));
	assert.equal(text, `RUN Ada · completed · 0:11 · turn 2\nError EACCES · Denied once\nTask · Implement the ledger renderer\npi · gpt-test · thinking high · /work\n+3.0s Thought · # Plan\n+4.0s Tool · ✓ bash · npm test · completed · 2.0s · text output · 11 chars\n+7.0s Response · This response is intentionally long enough to wrap across several semantic lines.\nCompleted · completed · success`);
	assert.match(text, /text output · 11 chars/);
});

test("exact tiny-height snapshots retain completion before all other optional content", () => {
	const state = fixture();
	const snapshots = [1, 2, 3, 4, 5].map((height) => renderRunLedgerText(renderRunLedger(state, { width: 60, height, now: at + 20_000 })));
	assert.deepEqual(snapshots, [
		"Completed · completed · success",
		"Ada · completed · 0:11 · T2\nCompleted · completed · success",
		"Ada · completed · 0:11 · T2\nError EACCES · Denied once\nCompleted · completed · success",
		"Ada · completed · 0:11 · T2\nError EACCES · Denied once\nTask · Implement the ledger renderer\nCompleted · completed · success",
		"Ada · completed · 0:11 · T2\nError EACCES · Denied once\nTask · Implement the ledger renderer\npi · gpt-test · thinking high · /work\nCompleted · completed · success",
	]);
});

test("permission lifecycle clears resolved pins and completion clears any stale pending card", () => {
	const pending = reduceRunLedgerEvents([event("permission", { status: "pending", summary: "edit file" }, 1)]);
	assert.match(renderRunLedgerText(renderRunLedger(pending, { width: 80, height: 3 })), /Permission · pending · edit file/);
	for (const status of ["resolved", "rejected", "expired", "cancelled"]) {
		const state = reduceRunLedgerEvents([event("permission", { status: "pending", summary: "edit file" }, 1), event("permission", { status, summary: "edit file" }, 2)]);
		assert.equal(state.permission, undefined, status);
	}
	const completed = reduceRunLedgerEvents([event("permission", { status: "pending", summary: "edit file" }, 1), event("completion", { status: "completed", summary: "done" }, 2)]);
	const snapshot = renderRunLedgerText(renderRunLedger(completed, { width: 60, height: 3 }));
	assert.equal(snapshot, "Run Ledger · completed · 1.0s · T2\nCompleted · completed · done");
	assert.doesNotMatch(snapshot, /Permission/);
});

test("medium and narrow exact snapshots preserve sticky identity and do not expose thought telemetry", () => {
	const state = fixture();
	assert.equal(renderRunLedgerText(renderRunLedger(state, { width: 80, height: 8, now: at + 20_000 })), `RUN Ada · completed · 0:11 · T2\nError EACCES · Denied once\nTask · Implement the ledger renderer\npi · gpt-test · thinking high · /work\n+4.0s Tool · ✓ bash · npm test · completed · 2.0s · text output · 11 chars\n+7.0s Response · This response is intentionally long enough to wrap across sever\n  ↳ al semantic lines.\nCompleted · completed · success`);
	assert.equal(renderRunLedgerText(renderRunLedger(state, { width: 40, height: 6, now: at + 20_000 })), `Ada · completed · 0:11 · T2\nError EACCES · Denied once\nTask · Implement the ledger renderer\npi · gpt-test · thinking high · /work\n+7.0s Response · This response is intent\nCompleted · completed · success`);
});

test("v2 metrics and compaction records reject identifiers and render Cursor availability honestly", () => {
	const metrics = normalizeRunLedgerEvent({ v: 2, seq: 1, ts: at, turn: 1, kind: "metrics", sampledAt: at, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0.1, contextUsage: { tokens: null, contextWindow: 100, percent: null }, compactionCount: 4 });
	const compact = normalizeRunLedgerEvent({ v: 2, seq: 2, ts: at + 1, turn: 1, kind: "compaction", state: "completed", reason: "overflow", tokensBefore: 10, estimatedTokensAfter: 4, compactionCount: 4 });
	assert.equal(normalizeRunLedgerEvent({ v: 2, seq: 3, ts: at, turn: 1, kind: "compaction", state: "end", compactionCount: 4 }), undefined);
	assert.ok(metrics); assert.ok(compact);
	assert.equal(normalizeRunLedgerEvent({ ...(metrics as any), sessionId: "never" }), undefined);
	const pi = renderRunLedgerText(renderRunLedger(reduceRunLedgerEvents([metrics!, compact!]), { width: 100, height: 3 }));
	assert.match(pi, /usage 3 .* context — .* compactions 4/);
	const context = normalizeRunLedgerEvent({ ...(metrics as any), seq: 3, contextUsage: { tokens: 2215, contextWindow: 372000, percent: 0.5954301075 } });
	assert.match(renderRunLedgerText(renderRunLedger(reduceRunLedgerEvents([context!]), { width: 120, height: 2 })), /context 2215\/372000 0\.6%/);
	const cursor = renderRunLedgerText(renderRunLedger(reduceRunLedgerEvents([normalizeRunLedgerEvent({ v: 2, seq: 1, ts: at, turn: 1, kind: "run", runId: "c", backend: "cursor" })!]), { width: 100, height: 2 }));
	assert.match(cursor, /usage — .* context — .* compactions —/);
});
