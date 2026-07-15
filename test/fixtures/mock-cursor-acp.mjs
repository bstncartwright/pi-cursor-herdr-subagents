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
/** @type {Map<string, (message: any) => void>} */
const serverRequestResponses = new Map();
/** @type {undefined | (() => void)} */
let cancelActivePrompt;

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
					agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
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
		case "session/load":
			if (params.sessionId !== sessionId) {
				write({ jsonrpc: "2.0", id, error: { code: -32000, message: "unknown session" } });
				return;
			}
			write({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
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
			const promptText = params.prompt?.[0]?.text;
			if (promptText === "wait-for-cancel") {
				write({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: "waiting for cancellation" },
						},
					},
				});
				await new Promise((resolve) => {
					cancelActivePrompt = resolve;
				});
				cancelActivePrompt = undefined;
				write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
				return;
			}
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
				params: {
					sessionId,
					toolCall: { title: "Read package.json", kind: "read" },
					options: [
						{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
						{ optionId: "allow-always", name: "Allow always", kind: "allow_always" },
						{ optionId: "reject-once", name: "Reject once", kind: "reject_once" },
					],
				},
			});
			const permissionResponse = await new Promise((resolve) => {
				serverRequestResponses.set(permissionId, resolve);
			});
			write({
				jsonrpc: "2.0",
				id,
				result: { stopReason: "end_turn", permissionOutcome: permissionResponse.result?.outcome },
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
		cancelActivePrompt?.();
		return;
	}
	if (message.id !== undefined && !message.method && (message.result !== undefined || message.error !== undefined)) {
		const resolve = serverRequestResponses.get(message.id);
		serverRequestResponses.delete(message.id);
		resolve?.(message);
		return;
	}
	void handle(message);
});

rl.on("close", () => {
	closed = true;
	process.exit(0);
});
