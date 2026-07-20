import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_EXTENSION_STARTUP_FAILURE, PiRpcClient } from "../extensions/pi-runtime.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-pi-rpc.mjs");

test("PiRpcClient exercises real argv/JSONL lifecycle, stats, token correlation, and process cleanup", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-process-")); const cwd = join(root, "cwd"); await mkdir(cwd); const record = join(root, "record.jsonl"); const exited = join(root, "exited"); const executable = join(root, "mock-pi");
	writeFileSync(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`); chmodSync(executable, 0o700);
	const previous = { bin: process.env.PI_SUBAGENT_PI_BIN, record: process.env.MOCK_PI_RECORD, exit: process.env.MOCK_PI_EXIT, herdr: process.env.HERDR_ENV, pane: process.env.HERDR_PANE_ID, tab: process.env.HERDR_TAB_ID };
	Object.assign(process.env, { PI_SUBAGENT_PI_BIN: executable, MOCK_PI_RECORD: record, MOCK_PI_EXIT: exited, HERDR_ENV: "1", HERDR_PANE_ID: "must-not-leak", HERDR_TAB_ID: "must-not-leak" });
	const events: Array<{ event: any; token?: string }> = []; const logs: Array<[string, string]> = []; let exitError: Error | undefined; let settle!: () => void; const settled = new Promise<void>((done) => { settle = done; });
	const client = new PiRpcClient({ canonicalName: "/fixture", cwd, provider: "fixture-provider", modelId: "fixture/model", thinking: "high", tools: "read,bash", skillPaths: [join(root, "skill")], extensionPaths: [join(root, "extension")], sessionFile: join(root, "session.jsonl"), logFile: join(root, "events.log") }, (event, token) => { events.push({ event, token }); if (event.type === "settled") settle(); }, (error) => { exitError = error; }, (category, message) => logs.push([category, message]));
	try {
		await client.start(); const stats = await client.getSessionStats(); assert.deepEqual(stats, { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, totalTokens: 14, cost: 0.25, contextUsage: { tokens: 7, contextWindow: 1000, percent: 0.7 } });
		await client.prompt("fixture prompt", "turn-token"); await settled;
		assert.ok(events.some(({ event, token }) => event.type === "text" && event.text === "hello\u2028world" && token === "turn-token")); assert.ok(events.some(({ event }) => event.type === "thought")); assert.ok(events.some(({ event }) => event.type === "tool_start" && event.id === "tool-1")); assert.ok(events.some(({ event }) => event.type === "tool_end" && event.id === "tool-1"));
		assert.deepEqual(events.find(({ event }) => event.type === "settled")?.event, { type: "settled", output: "final child response", error: undefined }); await client.steer("after settle"); await client.close(); assert.equal(exitError, undefined); assert.ok(existsSync(exited));
		const rows = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)); const argv = rows[0].argv as string[]; assert.deepEqual(rows[0].herdr, {}); for (const expected of ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--provider", "fixture-provider", "--model", "fixture/model", "--thinking", "high", "--tools", "read,bash", "--skill", join(root, "skill"), "--extension", join(root, "extension")]) assert.ok(argv.includes(expected), expected); assert.ok(rows.some((row) => row.request?.type === "prompt" && row.request.message === "fixture prompt")); assert.match(logs.find(([category]) => category === "spawn")?.[1] ?? "", /--provider fixture-provider/);
	} finally {
		await client.close().catch(() => undefined);
		for (const [key, value] of Object.entries({ PI_SUBAGENT_PI_BIN: previous.bin, MOCK_PI_RECORD: previous.record, MOCK_PI_EXIT: previous.exit, HERDR_ENV: previous.herdr, HERDR_PANE_ID: previous.pane, HERDR_TAB_ID: previous.tab })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(root, { recursive: true, force: true });
	}
});

test("PiRpcClient turns an extension_error before startup state into a bounded startup failure and closes the child", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-startup-error-")); const cwd = join(root, "cwd"); await mkdir(cwd); const exited = join(root, "exited"); const record = join(root, "record.jsonl"); const executable = join(root, "mock-pi"); writeFileSync(executable, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`); chmodSync(executable, 0o700);
	const previous = { bin: process.env.PI_SUBAGENT_PI_BIN, exit: process.env.MOCK_PI_EXIT, record: process.env.MOCK_PI_RECORD, error: process.env.MOCK_PI_STARTUP_EXTENSION_ERROR }; Object.assign(process.env, { PI_SUBAGENT_PI_BIN: executable, MOCK_PI_EXIT: exited, MOCK_PI_RECORD: record, MOCK_PI_STARTUP_EXTENSION_ERROR: "\u001b[31mbroken conversion\u001b[0m\nsecret" });
	const logs: string[] = []; const client = new PiRpcClient({ canonicalName: "/fixture", cwd, provider: "fixture", modelId: "model", tools: undefined, extensionPaths: ["/conversion", "/selected", "/guard"], sessionFile: join(root, "session.jsonl"), logFile: join(root, "events.log") }, () => {}, () => {}, (_category, message) => logs.push(message));
	try {
		await assert.rejects(() => client.start(), (error: unknown) => error instanceof Error && error.message === PI_EXTENSION_STARTUP_FAILURE); await new Promise((resolve) => setTimeout(resolve, 100)); assert.ok(existsSync(exited)); assert.match(logs.join("\n"), /broken conversion[\s\S]*secret/); assert.doesNotMatch(PI_EXTENSION_STARTUP_FAILURE, /broken conversion|secret/); const argv = JSON.parse(readFileSync(record, "utf8").split("\n")[0]!).argv as string[]; assert.equal(argv.includes("--tools"), false); assert.deepEqual(argv.filter((value) => ["/conversion", "/selected", "/guard"].includes(value)), ["/conversion", "/selected", "/guard"]);
	} finally { await client.close().catch(() => undefined); for (const [key, value] of Object.entries({ PI_SUBAGENT_PI_BIN: previous.bin, MOCK_PI_EXIT: previous.exit, MOCK_PI_RECORD: previous.record, MOCK_PI_STARTUP_EXTENSION_ERROR: previous.error })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); }
});
