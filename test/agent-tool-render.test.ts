import assert from "node:assert/strict";
import test from "node:test";
import {
	renderAgentsCall, renderAgentsResult, renderCloseResult, renderInterruptResult, renderModelsCall, renderModelsResult,
	renderPermissionCall, renderPermissionCard, renderPermissionResult, renderReadResult, renderSendResult,
	renderTargetCall, renderTemplatesCall, renderTemplatesResult, renderWaitAllCall, renderWaitAllResult, renderWaitCall,
	renderWaitProgress, renderWaitResult, safeDisplayText,
} from "../extensions/agent-tool-render.ts";

const theme = { fg(_role: string, text: string) { return text; }, bold(text: string) { return text; } };
const evil = "\u001b]0;title\u0007/path\n\u202ereversed\u0000";
const noLeak = (text: string) => assert.doesNotMatch(text, /\x1b|\u202e|title|SECRET|\/private|turn-|approval-/);

test("shared safe display primitive accepts strings only and strips ANSI CSI/OSC/C1/bidi", () => {
	assert.equal(safeDisplayText(evil, 99), "/path reversed");
	assert.equal(safeDisplayText("\x9b31mred\x1b[0m", 99), "red");
	assert.equal(safeDisplayText({ value: "SECRET" }, 20), "—");
	assert.equal(safeDisplayText("abcdef", 4), "abc…");
});

test("catalog wireframes use real catalog keys, project status, bounded rows, and column-zero errors", () => {
	assert.equal(renderTemplatesCall({}, theme), "▸ Templates");
	const catalog = { templates: Array.from({ length: 13 }, (_, i) => ({ name: `t${i}`, backend: i ? "pi" : evil, scope: "global", isolation: "shared", hint: evil })), diagnostics: [evil], conflicted_names: ["x"], project_status: "trusted", project_root: "/private", sources: ["SECRET"] };
	const templates = renderTemplatesResult({ details: catalog }, { expanded: true }, theme);
	assert.match(templates, /^✓ 13 templates · trusted · 1 conflict · 1 warning/m); assert.match(templates, /^  ⎿  … 1 more/m); noLeak(templates);
	assert.equal(renderTemplatesResult({ isError: true, details: { error: "SECRET" } }, {}, theme), "✗ Template listing failed");
	assert.equal(renderModelsCall({ backend: "pi", search: evil }, theme), "▸ Models  pi · /path reversed");
	const models = renderModelsResult({ details: { models: [{ backend: "cursor", model: "Auto", current_parent: true, spawn_parameter: "cursor_model", source: "/private" }], total: 1, warnings: ["SECRET"] } }, { expanded: true }, theme);
	assert.match(models, /^✓ 1\/1 models · 1 warning/m); assert.match(models, /cursor · Auto · current · cursor_model/); noLeak(models);
	assert.equal(renderModelsResult({ isError: true }, {}, theme), "✗ Model listing failed");
});

test("wait cards have spinner/status headers, body rows, neutral malformed fallback, and status-only all rows", () => {
	assert.equal(renderWaitCall({ targets: ["/a", evil] }, theme), "▸ Wait  /a, /path reversed");
	assert.equal(renderWaitAllCall({ targets: ["/a", "/b"] }, theme), "▸ Wait all  /a, /b");
	const progress = { v: 1, mode: "all", elapsedMs: 2_000, counts: { total: 2, queued: 1, active: 1, settled: 0, permissionPending: 0 }, agents: [
		{ agentName: "/a", backend: "pi", status: "running", activity: evil, metrics: { totalTokens: 1200 } },
		{ agentName: "/b", backend: "cursor", status: "queued", queuePosition: 2 },
	] };
	const partial = renderWaitProgress(progress, {}, theme); assert.match(partial, /^⠹ Waiting 0\/2 settled/m); assert.match(partial, /^  ⎿  ● \/a/m); assert.match(partial, /usage 1\.2k|usage —/); noLeak(partial);
	assert.equal(renderWaitProgress({ nope: "SECRET" }, {}, theme), "Waiting · —");
	const completion = renderWaitResult({ details: { kind: "completion", agentName: "/a", backend: "pi", status: "completed", agentStatus: "completed", model: "m", isolation: "shared", output: "done" } }, {}, theme); assert.match(completion, /^✓ \/a completed/m);
	const permission = renderWaitResult({ details: { kind: "permission", agentName: "/a", summary: `token=SECRET ${evil}`, approvalId: "approval-secret" } }, {}, theme); assert.match(permission, /^⚿ \/a permission required/m); assert.match(permission, /^  ⎿  token=\[REDACTED\]/m); assert.doesNotMatch(permission, /approval-secret/); noLeak(permission);
	const all = renderWaitAllResult({ details: { responses: [{ agent_name: "/a", backend: "pi", status: "completed", finalResponse: "SECRET" }, { agent_name: "/b", backend: "bad", status: "bad", error: "SECRET" }] } }, { expanded: true }, theme); assert.match(all, /^✓ 2 agents · 1 completed · 1 —/m); noLeak(all);
	assert.equal(renderWaitResult({ isError: true }, {}, theme), "✗ Wait failed");
});

test("agent/read/control wireframes expose only optional safe facts and exact worktree enums", () => {
	assert.equal(renderAgentsCall({ include_all: true, path_prefix: evil }, theme), "▸ Agents  all · /path reversed");
	const agents = renderAgentsResult({ details: { agents: [
		{ agent_name: "/a", backend: "pi", agent_status: "running", model: "m", activity_summary: evil, elapsed: "0:01", terminal_reason: evil, parent_session_id: "SECRET", worktree: { phase: "retained-branch", reason: "commits-preserved", cwd: "/private" } },
		{ agent_name: "/b", backend: "cursor", agent_status: "closed", model: "Auto" },
	] } }, { expanded: true }, theme);
	assert.match(agents, /^✓ 2 agents/m); assert.match(agents, /worktree retained-branch · commits-preserved/); assert.doesNotMatch(agents, /\/b.*—/); noLeak(agents);
	assert.equal(renderTargetCall("Read", { target: "/a" }, theme), "▸ Read  /a");
	const read = renderReadResult({ details: { agent_name: "/a", status: "completed", output: `one\n${evil}`, truncated: true, fullOutputPath: "/private/file" } }, { expanded: true }, theme); assert.match(read, /^✓ \/a · completed/m); assert.match(read, /^  ⎿  Output truncated/m); noLeak(read);
	assert.equal(renderSendResult({ details: { delivery: "steer", message: "SECRET", turnId: "turn-secret" } }, theme), "  ⎿  Delivered · steer");
	assert.equal(renderSendResult({ details: { delivery: "cancel-and-prompt" } }, theme), "  ⎿  Cursor turn replaced");
	assert.equal(renderSendResult({ details: { delivery: "prompt" } }, theme), "  ⎿  New turn queued");
	assert.equal(renderInterruptResult({ details: { previous_status: "running", status: "interrupted", turn_id: "turn-secret" } }, theme), "  ⎿  Interrupted · previously running");
	assert.equal(renderCloseResult({ details: { previous_status: "completed", status: "closed", worktree: { phase: "retained-both", reason: "dirty", cwd: "/private" } } }, theme), "  ⎿  Closed · previously completed\n  ⎿  Worktree retained-both · dirty");
	assert.equal(renderPermissionCall({ target: "/a", decision: "approve", approval_id: "approval-secret" }, theme), "▸ Permission  /a · approve");
	assert.equal(renderPermissionResult({ details: { decision: "approve", approval_id: "approval-secret" } }, theme), "  ⎿  Approved once");
	assert.equal(renderPermissionResult({ details: { decision: "reject" } }, theme), "  ⎿  Rejected");
	assert.equal(renderPermissionCard({ details: { agentName: "/a", summary: evil, approvalId: "approval-secret" } }, theme).includes("approval-secret"), false);
});
