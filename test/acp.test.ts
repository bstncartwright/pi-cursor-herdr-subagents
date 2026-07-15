import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	CursorAcpClient,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	childEnvironment,
	findConfig,
} from "../extensions/acp.ts";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-cursor-acp.mjs");

test("package metadata is coherent for ACP clientInfo", () => {
	assert.equal(PACKAGE_NAME, "pi-bstn-subagents");
	assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);
});

test("childEnvironment strips Herdr pane identity keys", () => {
	const env = childEnvironment({
		PATH: "/usr/bin",
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		HERDR_WORKSPACE_ID: "w1",
		HERDR_TAB_ID: "w1:t1",
		HERDR_PANE_ID: "w1:p1",
		KEEP: "yes",
	});

	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.KEEP, "yes");
	assert.equal(env.HERDR_ENV, undefined);
	assert.equal(env.HERDR_SOCKET_PATH, undefined);
	assert.equal(env.HERDR_WORKSPACE_ID, undefined);
	assert.equal(env.HERDR_TAB_ID, undefined);
	assert.equal(env.HERDR_PANE_ID, undefined);
});

test("findConfig locates config options by id", () => {
	const options = [
		{ id: "model", currentValue: "default" },
		{ id: "fast", currentValue: "false" },
	];
	assert.equal(findConfig(options, "fast")?.currentValue, "false");
	assert.equal(findConfig(options, "missing"), undefined);
});

test("CursorAcpClient starts Auto model against a mock ACP process", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cursor-acp-"));
	const notifications: Array<{ method?: string }> = [];
	const requests: Array<{ method?: string }> = [];

	const client = new CursorAcpClient(cwd, {
		agentCommand: process.execPath,
		agentArgs: [mockAgent],
		env: { PATH: process.env.PATH ?? "" },
		requestTimeoutMs: 5_000,
		onNotification: (message) => notifications.push(message),
		onRequest: async (message) => {
			requests.push(message);
			if (message.method === "session/request_permission") {
				return { outcome: { outcome: "selected", optionId: "allow-once" } };
			}
			return {};
		},
	});

	try {
		const started = await client.start("Auto");
		assert.equal(started.sessionId, "sess_test_1");
		assert.equal(started.model, "Auto");
		assert.equal(findConfig(started.configOptions, "model")?.currentValue, "default");
		assert.equal(client.isAlive, true);
		assert.equal(client.activeSessionId, "sess_test_1");

		const result = await client.prompt("hi") as {
			stopReason?: string;
			permissionOutcome?: { outcome?: string; optionId?: string };
		};
		assert.equal(result.stopReason, "end_turn");
		assert.deepEqual(result.permissionOutcome, { outcome: "selected", optionId: "allow-once" });
		assert.ok(notifications.some((message) => message.method === "session/update"));
		assert.ok(requests.some((message) => message.method === "session/request_permission"));
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("CursorAcpClient applies Grok High non-fast config against a mock ACP process", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cursor-acp-"));
	const client = new CursorAcpClient(cwd, {
		agentCommand: process.execPath,
		agentArgs: [mockAgent],
		env: { PATH: process.env.PATH ?? "" },
		requestTimeoutMs: 5_000,
	});

	try {
		const started = await client.start("Grok 4.5 High");
		assert.equal(findConfig(started.configOptions, "model")?.currentValue, "grok-4.5");
		assert.equal(findConfig(started.configOptions, "effort")?.currentValue, "high");
		assert.equal(findConfig(started.configOptions, "fast")?.currentValue, "false");
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("CursorAcpClient rejects starting twice", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cursor-acp-"));
	const client = new CursorAcpClient(cwd, {
		agentCommand: process.execPath,
		agentArgs: [mockAgent],
		env: { PATH: process.env.PATH ?? "" },
		requestTimeoutMs: 5_000,
	});

	try {
		await client.start("Auto");
		await assert.rejects(() => client.start("Auto"), /already started/);
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("CursorAcpClient cancels an active turn and can prompt again", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cursor-acp-"));
	const client = new CursorAcpClient(cwd, {
		agentCommand: process.execPath,
		agentArgs: [mockAgent],
		env: { PATH: process.env.PATH ?? "" },
		requestTimeoutMs: 5_000,
	});

	try {
		await client.start("Auto");
		const pending = client.prompt("wait-for-cancel");
		client.cancel();
		assert.equal((await pending).stopReason, "cancelled");
		assert.equal(client.isAlive, true);
		assert.equal((await client.prompt("after cancellation")).stopReason, "end_turn");
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
