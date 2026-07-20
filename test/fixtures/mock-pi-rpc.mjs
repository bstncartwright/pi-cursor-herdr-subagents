#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const record = process.env.MOCK_PI_RECORD;
const exitMarker = process.env.MOCK_PI_EXIT;
if (record) writeFileSync(record, `${JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, herdr: { env: process.env.HERDR_ENV, pane: process.env.HERDR_PANE_ID, tab: process.env.HERDR_TAB_ID } })}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (request, data) => send({ id: request.id, type: "response", command: request.type, success: true, ...(data === undefined ? {} : { data }) });

function handle(request) {
	if (record) appendFileSync(record, `${JSON.stringify({ request })}\n`);
	if (request.type === "get_state") { if (process.env.MOCK_PI_STARTUP_EXTENSION_ERROR) send({ type: "extension_error", error: process.env.MOCK_PI_STARTUP_EXTENSION_ERROR }); return response(request, { model: null, isStreaming: false }); }
	if (request.type === "get_session_stats") return response(request, { sessionFile: "/private/session.jsonl", sessionId: "discard-me", userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 4, tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 }, cost: 0.25, contextUsage: { tokens: 7, contextWindow: 1000, percent: 0.7 } });
	if (request.type === "prompt") {
		response(request);
		send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private thought" } });
		send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } });
		send({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "read", partialResult: { content: "unsafe raw" } });
		send({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: "unsafe raw" }, isError: false });
		send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello\u2028world" } });
		const assistant = { role: "assistant", content: [{ type: "text", text: "final child response" }], stopReason: "stop" };
		send({ type: "message_end", message: assistant }); send({ type: "agent_end", messages: [assistant] }); send({ type: "agent_settled" }); return;
	}
	if (request.type === "steer" || request.type === "abort") return response(request);
	send({ id: request.id, type: "response", command: request.type, success: false, error: "unsupported mock command" });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1); if (line) handle(JSON.parse(line)); }
});
process.stdin.on("end", () => process.exit(0));
process.on("exit", () => { if (exitMarker) writeFileSync(exitMarker, "exited\n", { mode: 0o600 }); });
