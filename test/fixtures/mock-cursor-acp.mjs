#!/usr/bin/env node
/**
 * Minimal Cursor ACP stand-in for unit tests.
 * Speaks newline-delimited JSON-RPC on stdio.
 */
import readline from "node:readline";

/** @type {Map<string, string>} */
const config = new Map([
	["model", "default"],
	["effort", "medium"],
	["fast", "true"],
]);

let sessionId = "sess_test_1";
let closed = false;

/**
 * @param {Record<string, unknown>} message
 */
function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * @returns {Array<{ id: string, currentValue: string }>}
 */
function configOptions() {
	return [...config.entries()].map(([id, currentValue]) => ({ id, currentValue }));
}

/**
 * @param {any} message
 */
async function handle(message) {
	const { id, method, params } = message;
	if (!method || id === undefined) return;

	switch (method) {
		case "initialize":
			write({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: 1,
					agentInfo: { name: "mock-cursor-acp", version: "0.0.0" },
				},
			});
			return;
		case "authenticate":
			write({ jsonrpc: "2.0", id, result: {} });
			return;
		case "session/new":
			write({
				jsonrpc: "2.0",
				id,
				result: { sessionId, configOptions: configOptions() },
			});
			return;
		case "session/set_config_option": {
			config.set(params.configId, params.value);
			write({
				jsonrpc: "2.0",
				id,
				result: { configOptions: configOptions() },
			});
			return;
		}
		case "session/prompt": {
			write({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId,
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: "thinking about it" },
					},
				},
			});
			write({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "hello from mock" },
					},
				},
			});
			const permissionId = "req_perm_1";
			write({
				jsonrpc: "2.0",
				id: permissionId,
				method: "session/request_permission",
				params: { sessionId, toolCall: { title: "read" } },
			});
			// Wait briefly for the client response; ignore body for the mock.
			await new Promise((resolve) => setTimeout(resolve, 20));
			write({
				jsonrpc: "2.0",
				id,
				result: { stopReason: "end_turn" },
			});
			return;
		}
		default:
			write({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `Method not found: ${method}` },
			});
	}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (closed) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.stderr.write(`invalid json: ${line}\n`);
		return;
	}
	if (message.method === "session/cancel") {
		closed = true;
		return;
	}
	if (message.id !== undefined && message.result !== undefined) {
		// Client response to a server request; ignore.
		return;
	}
	void handle(message);
});

rl.on("close", () => {
	closed = true;
	process.exit(0);
});
